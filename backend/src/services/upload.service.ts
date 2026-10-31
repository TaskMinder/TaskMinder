import { Session, SessionData } from "express-session";
import path from "path";
import { FINAL_UPLOADS_DIR, MAX_FILE_SIZE, MAX_FILES_PER_CLASS, MIME_CANONICAL_ALIASES } from "../config/upload.js";
import fs from "fs/promises";
import { ReadStream, createReadStream } from "fs";
import { prisma } from "../config/prisma.js";
import { Prisma } from "../prisma/generated/prisma/client.js";
import logger from "../config/logger.js";
import { RequestError } from "../@types/requestError.js";
import {
  getUploadFileQuery,
  getUploadFileParams,
  editUploadTypeParams,
  deleteUploadTypeParams,
  pinUploadTypeParams,
  deleteUploadRequestTypeParams,
  editUploadTypeBody,
  uploadFileTypeBody,
  pinUploadTypeBody,
  addUploadRequestTypeBody
} from "../schemas/upload.schema.js";
import { removeTempFiles } from "../utils/upload.cleanup.js";
import { queueJob, QUEUE_KEYS, generateCacheKey, CACHE_KEY_PREFIXES, redisClient } from "../config/redis.js";
import { BigIntreplacer, isValidTeamId } from "../utils/validate.functions.js";
import { invalidateCache, updateCacheData } from "../config/redis.js";
import { emitSocketToClass, SOCKET_EVENTS } from "../config/socket.js";
import { flagBlockedAuthors } from "./block.service.js";

type GetUploadFileResult = {
  stream: ReadStream;
  headers: {
    "Content-Type": string;
    "Content-Disposition": string;
    "Cache-Control": string;
  };
};

const normalizeMimeType = (mimeType: string): string => MIME_CANONICAL_ALIASES[mimeType] ?? mimeType;

// Helper function to map upload data
const mapUploadData = (uploads: Awaited<ReturnType<typeof prisma.upload.findMany<{
  include: {
    Account: { select: { username: true } };
    Files: { select: { fileMetaDataId: true, mimeType: true, size: true, createdAt: true } };
  };
  // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
}>>>) => {
  return uploads.map(upload => ({
    uploadId: upload.uploadId,
    uploadName: upload.uploadName,
    uploadDescription: upload.uploadDescription,
    uploadType: upload.uploadType,
    isPinned: upload.isPinned,
    teamId: upload.teamId,
    status: upload.status,
    errorReason: upload.errorReason,
    accountName: upload.Account?.username ?? null,
    // stripped before responding
    uploaderAccountId: upload.accountId,
    filesCount: upload.Files.length,
    createdAt: upload.createdAt,
    files: upload.Files.map(f => ({
      fileMetaDataId: f.fileMetaDataId,
      mimeType: f.mimeType,
      size: f.size,
      createdAt: f.createdAt
    }))
  }));
};

// session-free removal, shared by deleteUpload and moderation; releases storage and deletes files
export async function removeUpload(uploadData: Prisma.UploadGetPayload<{ include: { Files: true } }>): Promise<void> {
  const { uploadId, classId } = uploadData;

  // Calculate actual size (for completed uploads) or reserved size (for failed/queued)
  const sizeToRelease = uploadData.status === "completed"
    ? BigInt(uploadData.Files.reduce((sum, file) => sum + BigInt(file.size), 0n))
    : uploadData.reservedBytes;

  await prisma.$transaction(async tx => {
    // Delete the upload record
    await tx.upload.delete({
      where: { uploadId }
    });

    // Update class storage usage
    if (sizeToRelease > 0n) {
      await tx.class.update({
        where: { classId },
        data: { storageUsedBytes: { decrement: sizeToRelease } }
      });
    }
  });

  // Delete all physical files from disk
  const classDir = path.join(FINAL_UPLOADS_DIR, classId.toString());
  for (const file of uploadData.Files) {
    const filePath = path.join(classDir, file.storedFileName);
    await fs.unlink(filePath).catch(() => {
      logger.error(`Failed to delete file for classId: ${classId}, filePath: ${filePath} during upload deletion`);
    });
  }

  // Invalidate cache after delete
  await invalidateCache(CACHE_KEY_PREFIXES.UPLOADMETADATA, classId.toString());

  emitSocketToClass(classId, SOCKET_EVENTS.UPLOADS);
  logger.info(`upload deleted for class: ${classId}`);
}

const uploadService = {
  // file upload -> queue upload for worker to pick up
  async queueFileUpload(
    files: Express.Multer.File[],
    session: Session & Partial<SessionData>,
    body: uploadFileTypeBody,
    reservedBytes: bigint
  ) {
    const { uploadName, uploadDescription, uploadType, teamId } = body;
    const classId = parseInt(session.classId!, 10);
    const accountId = session.account?.accountId ?? null;

    await isValidTeamId(teamId, session);
    // create upload entry in DB
    const upload = await prisma.upload.create({
      data: {
        uploadName,
        uploadDescription,
        uploadType,
        isPinned: false,
        status: "queued",
        teamId,
        classId,
        accountId,
        reservedBytes,
        createdAt: BigInt(Date.now())
      }
    });

    const jobData = {
      uploadId: upload.uploadId,
      classId,
      tempFiles: files.map(f => ({
        path: f.path,
        originalName: f.originalname,
        mimetype: f.mimetype,
        size: f.size
      }))
    };

    try {
      await queueJob(QUEUE_KEYS.FILE_PROCESSING, jobData);
    }
    catch (error) {
      logger.error(`Failed to queue upload ${upload.uploadId}: `, error);
      // on failure, delete the upload DB entry and reset the reservedBytes
      await prisma.$transaction(async tx => {
        await tx.upload.delete({ where: { uploadId: upload.uploadId } });
        if (reservedBytes > 0n) {
          await tx.class.update({
            where: { classId },
            data: { storageUsedBytes: { decrement: reservedBytes } }
          });
        }
      });
      // remove the physical files on the system
      await removeTempFiles(files);

      if (reservedBytes > 0n && typeof error === "object" && error !== null) {
        (error as Record<string, unknown>).reservationRolledBack = true;
      }

      throw error;
    }

    // Invalidate cache after queueing new upload
    await invalidateCache(CACHE_KEY_PREFIXES.UPLOADMETADATA, classId.toString());
    // send uploads socket event
    emitSocketToClass(classId, SOCKET_EVENTS.UPLOADS);

    logger.info(`Queued upload ${upload.uploadId} with ${files.length} file(s) for class ${classId}`);
  },
  // get upload metadata service
  async getUploadMetadata(session: Session & Partial<SessionData>) {
    const classId = parseInt(session.classId!, 10);

    const classInformation = await prisma.class.findUnique({
      where: { classId },
      select: { storageUsedBytes: true, storageQuotaBytes: true }
    });

    if (!classInformation) {
      const err: RequestError = {
        name: "Not Found",
        status: 404,
        message: "Class not found.",
        expected: true
      };
      throw err;
    }

    // if no uploads available, return directly with 0 file upload metadata
    const totalUploads = await prisma.upload.count({ where: { classId } });
    if (totalUploads === 0) {
      return {
        totalUploads: 0,
        uploads: [],
        maxFilesPerClass: MAX_FILES_PER_CLASS,
        sizeLimitPerFile: MAX_FILE_SIZE,
        totalStorage: classInformation.storageQuotaBytes.toString(),
        usedStorage: classInformation.storageUsedBytes.toString()
      };
    }

    // check if data is available in cache
    const getUploadMetadataCacheKey = generateCacheKey(CACHE_KEY_PREFIXES.UPLOADMETADATA, session.classId!);
    const cachedUploadMetadataData = await redisClient.get(getUploadMetadataCacheKey);

    if (cachedUploadMetadataData) {
      try {
        // Early return — skip DB fetch entirely 
        const cached = JSON.parse(cachedUploadMetadataData);
        // return directly from cache
        return {
          totalUploads,
          uploads: await flagBlockedAuthors(cached, ["uploaderAccountId"], session),
          maxFilesPerClass: MAX_FILES_PER_CLASS,
          sizeLimitPerFile: MAX_FILE_SIZE,
          totalStorage: classInformation.storageQuotaBytes.toString(),
          usedStorage: classInformation.storageUsedBytes.toString()
        };
      }
      catch (error) {
        logger.error(`Error parsing Redis data: ${error}`);
        // fall through to fetch from database
      }
    };

    // include Account username and Files (except storedFileName) in metadata fetch too
    // omit storedFileName due to security risk (internal server detail)
    const include = {
      Account: { select: { username: true } },
      Files: { select: { fileMetaDataId: true, mimeType: true, size: true, createdAt: true } }
    } as const;

    // define prisma relations for ordered fetch from database
    const orderBy: Prisma.UploadOrderByWithRelationInput[] = [
      { isPinned: "desc" },
      { createdAt: "desc" },
      { uploadName: "asc" },
      { uploadId: "desc" }
    ];

    // find and map databse data
    const uploads = await prisma.upload.findMany({
      where: { classId },
      include,
      orderBy
    });
    const uploadList = mapUploadData(uploads);

    try {
      await updateCacheData(uploadList, getUploadMetadataCacheKey);
    }
    catch (err) {
      logger.error(`Error updating Redis data: ${err}`);
      // fall through to prevent server error/crash
    }

    const res = {
      totalUploads,
      uploads: await flagBlockedAuthors(uploadList, ["uploaderAccountId"], session),
      maxFilesPerClass: MAX_FILES_PER_CLASS,
      sizeLimitPerFile: MAX_FILE_SIZE,
      totalStorage: classInformation.storageQuotaBytes.toString(),
      usedStorage: classInformation.storageUsedBytes.toString()
    };
    const stringified = JSON.stringify(res, BigIntreplacer);
    return JSON.parse(stringified);
  },
  // send upload file to user
  async getUploadFile(
    params: getUploadFileParams,
    query: getUploadFileQuery,
    session: Session & Partial<SessionData>
  ): Promise<GetUploadFileResult> {
    const { id: fileIdParam } = params;
    const { action } = query;
    const classId = parseInt(session.classId!, 10);

    const fileData = await prisma.fileMetadata.findUnique({
      where: { fileMetaDataId: fileIdParam },
      include: {
        Upload: {
          select: {
            classId: true,
            uploadName: true,
            Files: {
              select: { fileMetaDataId: true },
              orderBy: { createdAt: "asc" }
            }
          }
        }
      }
    });

    if (!fileData || fileData.Upload.classId !== classId) {
      const err: RequestError = {
        name: "Not Found",
        status: 404,
        message: "File not found or access denied.",
        expected: true
      };
      throw err;
    }

    const disposition = action === "download" ? "attachment" : "inline";

    // Get file numbering information
    const totalFiles = fileData.Upload.Files.length;
    const fileIndex = fileData.Upload.Files.findIndex(f => f.fileMetaDataId === fileIdParam);
    const fileNumber = fileIndex + 1;

    // Extract file extension from stored filename
    const fileExtension = path.extname(fileData.storedFileName);

    // Build filename with numbering if multiple files
    let filename = fileData.Upload.uploadName;
    if (totalFiles > 1) {
      filename += ` (${fileNumber} von ${totalFiles})`;
    }
    filename += fileExtension;

    const filenameForHeader = filename.replace(/[\r\n]/g, ""); // Remove newlines that could enable header injection
    const safeOriginalName = filenameForHeader
      .replace(/\\/g, "\\\\") // Escape backslashes
      .replace(/"/g, '\\"');  // Escape quotes
    const encodedFileName = encodeURIComponent(filenameForHeader);

    const headers = {
      "Content-Type": normalizeMimeType(fileData.mimeType),
      "Content-Disposition": `${disposition}; filename="${safeOriginalName}"; filename*=UTF-8''${encodedFileName}`,
      "Cache-Control": "private, max-age=31536000, immutable"
    };

    const finalFilePath = path.join(
      FINAL_UPLOADS_DIR,
      fileData.Upload.classId.toString(),
      fileData.storedFileName
    );

    try {
      await fs.access(finalFilePath, fs.constants.R_OK);
    }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        logger.error(`File not found on disk: ${finalFilePath}`);
        const err: RequestError = {
          name: "Not Found",
          status: 404,
          message: "File not found on server.",
          expected: true
        };
        throw err;
      }
      throw e;
    }

    const stream = createReadStream(finalFilePath);
    return { stream, headers };
  },

  // eslint-disable-next-line complexity
  async editUpload(
    params: editUploadTypeParams,
    body: editUploadTypeBody,
    session: Session & Partial<SessionData>,
    files: Express.Multer.File[],
    reservedBytes?: bigint
  ) {
    const { uploadName, uploadDescription, uploadType, teamId } = body;
    const { id: uploadId } = params;
    const classId = parseInt(session.classId!, 10);
    const tempFiles = Array.isArray(files) ? files : [];
    const accountId = session.account?.accountId ?? null;

    await isValidTeamId(teamId, session);

    const uploadData = await prisma.upload.findUnique({
      where: { uploadId },
      include: { Files: true }
    });

    if (!uploadData || uploadData.classId !== classId) {
      const err: RequestError = {
        name: "Not Found",
        status: 404,
        message: "Upload not found.",
        expected: true
      };
      throw err;
    }

    const hasFiles = tempFiles.length > 0;

    // update files first (if files were uploaded)
    // if errors occur here, the update metadata is not affected
    if (hasFiles) {
      const oldFilesSize = uploadData.Files.reduce((sum, file) => sum + BigInt(file.size), 0n);
      const newFilesSize = tempFiles.reduce((sum, file) => sum + BigInt(file.size), 0n);

      const additionalBytesNeeded = newFilesSize > oldFilesSize ? newFilesSize - oldFilesSize : 0n;
      const usePreReserved = typeof reservedBytes !== "undefined";

      await prisma.$transaction(async tx => {
        const classData = await tx.class.findUnique({
          where: { classId },
          select: { storageQuotaBytes: true, storageUsedBytes: true }
        });

        if (!classData) {
          const err: RequestError = {
            name: "Not Found",
            status: 404,
            message: "Class not found.",
            expected: true
          };
          throw err;
        }

        if (!usePreReserved) {
          const projectedUsage = classData.storageUsedBytes + additionalBytesNeeded;
          if (projectedUsage > classData.storageQuotaBytes) {
            const err: RequestError = {
              name: "Content Too Large",
              status: 413,
              message: "Class storage quota will be exceeded",
              expected: true
            };
            throw err;
          }

          if (additionalBytesNeeded > 0n) {
            await tx.class.update({
              where: { classId },
              data: { storageUsedBytes: { increment: additionalBytesNeeded } }
            });
          }
        }
        else if (classData.storageUsedBytes > classData.storageQuotaBytes) {
          const err: RequestError = {
            name: "Content Too Large",
            status: 413,
            message: "Class storage quota will be exceeded",
            expected: true
          };
          throw err;
        }

        await tx.upload.update({
          where: { uploadId },
          data: {
            accountId,
            status: "queued",
            errorReason: null,
            reservedBytes: usePreReserved ? (reservedBytes ?? 0n) : additionalBytesNeeded
          }
        });
      });

      const jobData = {
        uploadId,
        classId,
        tempFiles: tempFiles.map(file => ({
          path: file.path,
          originalName: file.originalname,
          mimetype: file.mimetype,
          size: file.size
        })),
        replaceUpload: {
          oldStoredFiles: uploadData.Files.map(file => file.storedFileName),
          oldTotalBytes: oldFilesSize.toString()
        }
      };

      try {
        await queueJob(QUEUE_KEYS.FILE_PROCESSING, jobData);
      }
      catch (error) {
        const bytesToRelease = usePreReserved ? (reservedBytes ?? 0n) : additionalBytesNeeded;
        await prisma.$transaction(async tx => {
          if (bytesToRelease > 0n) {
            await tx.class.update({
              where: { classId },
              data: { storageUsedBytes: { decrement: bytesToRelease } }
            });
          }
          await tx.upload.update({
            where: { uploadId },
            data: {
              status: "failed",
              errorReason: error instanceof Error ? error.message : "queue_failed",
              reservedBytes: 0n
            }
          });
        });
        // remove the physical files on the system
        await removeTempFiles(files);
        if (bytesToRelease > 0n && typeof error === "object" && error !== null) {
          (error as Record<string, unknown>).reservationRolledBack = true;
        }
        throw error;
      }
    }

    // update non-file related data later
    await prisma.upload.update({
      where: { uploadId: uploadId, classId },
      data: { uploadName, uploadDescription, uploadType, teamId }
    });

    await invalidateCache(CACHE_KEY_PREFIXES.UPLOADMETADATA, session.classId!);

    emitSocketToClass(classId, SOCKET_EVENTS.UPLOADS);
    logger.info(`Upload for class ${classId} was edited ${hasFiles ? "with" : "without"} files`);
  },

  async deleteUpload(
    params: deleteUploadTypeParams,
    session: Session & Partial<SessionData>
  ) {
    const { id: uploadId } = params;
    const classId = parseInt(session.classId!, 10);

    const uploadData = await prisma.upload.findUnique({
      where: { uploadId },
      include: { Files: true }
    });

    if (!uploadData || uploadData.classId !== classId) {
      const err: RequestError = {
        name: "Not Found",
        status: 404,
        message: "Upload not found.",
        expected: true
      };
      throw err;
    }

    await isValidTeamId(uploadData.teamId, session);

    await removeUpload(uploadData);
  },

  async pinUpload(
    params: pinUploadTypeParams,
    body: pinUploadTypeBody,
    session: Session & Partial<SessionData>
  ) {
    const { pinStatus } = body;
    const { id: uploadId } = params;
    const classId = parseInt(session.classId!, 10);

    const updated = await prisma.upload.updateMany({
      where: {
        uploadId: uploadId,
        classId
      },
      data: {
        isPinned: pinStatus
      }
    });

    if (updated.count === 0) {
      const err: RequestError = {
        name: "Not Found",
        status: 404,
        message: "Upload not found",
        expected: true
      };
      throw err;
    }

    await invalidateCache(CACHE_KEY_PREFIXES.UPLOADMETADATA, classId.toString());

    emitSocketToClass(classId, SOCKET_EVENTS.UPLOADS);
  },

  async addUploadRequest(
    body: addUploadRequestTypeBody,
    session: Session & Partial<SessionData>
  ) {
    const { uploadRequestName, teamId } = body;
    const classId = parseInt(session.classId!, 10);

    await isValidTeamId(teamId, session);

    await prisma.uploadRequest.create({
      data: {
        uploadRequestName: uploadRequestName,
        classId,
        teamId
      }
    });

    await invalidateCache(CACHE_KEY_PREFIXES.UPLOADREQUESTS, classId.toString());

    emitSocketToClass(classId, SOCKET_EVENTS.UPLOAD_REQUESTS);
    logger.info(`Upload Request added for class: ${classId}`);
  },

  async getUploadRequests(session: Session & Partial<SessionData>) {
    const classId = parseInt(session.classId!, 10);

    const getUploadRequestsCacheKey = generateCacheKey(CACHE_KEY_PREFIXES.UPLOADREQUESTS, session.classId!);
    const cachedData = await redisClient.get(getUploadRequestsCacheKey);

    if (cachedData) {
      try {
        return JSON.parse(cachedData);
      }
      catch (error) {
        logger.error(`Error parsing Redis data: ${error}`);
        // Fall through to fetch from database
      }
    }

    const uploadRequests = await prisma.uploadRequest.findMany({
      where: { classId },
      orderBy: { uploadRequestId: "desc" }
    });

    try {
      await updateCacheData(uploadRequests, getUploadRequestsCacheKey);
    }
    catch (err) {
      logger.error(`Error updating Redis data: ${err}`);
      // Continue without caching
    }

    const stringified = JSON.stringify(uploadRequests, BigIntreplacer);
    return JSON.parse(stringified);
  },

  async deleteUploadRequest(
    params: deleteUploadRequestTypeParams,
    session: Session & Partial<SessionData>
  ) {
    const { id: uploadRequestId } = params;
    const classId = parseInt(session.classId!, 10);

    // Check if upload request exists and belongs to this class
    const existingRequest = await prisma.uploadRequest.findUnique({
      where: { uploadRequestId }
    });

    if (!existingRequest || existingRequest.classId !== classId) {
      const err: RequestError = {
        name: "Not Found",
        status: 404,
        message: "Upload request not found",
        expected: true
      };
      throw err;
    }

    await isValidTeamId(existingRequest.teamId, session);

    await prisma.uploadRequest.delete({ where: { uploadRequestId } });

    await invalidateCache(CACHE_KEY_PREFIXES.UPLOADREQUESTS, classId.toString());

    emitSocketToClass(classId, SOCKET_EVENTS.UPLOAD_REQUESTS);
  }
};

export default uploadService;
