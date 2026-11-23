import multer, { FileFilterCallback } from "multer";
import {
  ALLOWED_MIMES,
  ALLOWED_EXTENSIONS,
  EXPECTED_MIMES_BY_EXTENSION,
  MIME_CANONICAL_ALIASES,
  TEMP_DIR,
  MAX_FILE_SIZE,
  MAX_FILES_PER_UPLOAD,
  MAX_FILES_PER_CLASS
} from "../config/upload.js";
import path from "path";
import { Request, Response, NextFunction } from "express";
import mime from "mime-types";
import { RequestError } from "../@types/requestError.js";
import { randomUUID } from "crypto";
import { prisma } from "../config/prisma.js";
import { Prisma } from "../prisma/generated/prisma/client.js";
import { getUploadedFiles, performUploadCleanup, registerReservedBytes, registerTempFiles } from "../utils/upload.cleanup.js";

const normalizeMimeType = (mimeType: string): string => MIME_CANONICAL_ALIASES[mimeType] ?? mimeType;

const MULTIPART_PARSE_ERRORS = new Set([
  "Unexpected end of form",
  "Unexpected end of file",
  "Malformed part header",
  "Multipart: Boundary not found"
]);

//
// normalizes file requests into one consistent format
//
export const normalizeFiles = (req: Request,
  res: Response,
  next: NextFunction): void => {
  // getUploadedFiles normalizes the files or returns [] if invalid
  const files = getUploadedFiles(req, res);
  if (files.length === 0) {
    const err: RequestError = {
      name: "Bad Request",
      status: 400,
      message: "No file was uploaded",
      expected: true
    };
    return next(err);
  }
  req.allFiles = files;
  res.locals.allFiles = files;
  registerTempFiles(res, files);
  next();
};

//
// normalizes file requests but allows empty uploads (used for edit metadata-only)
//
export const normalizeFilesOptional = (req: Request,
  res: Response,
  next: NextFunction): void => {
  const files = getUploadedFiles(req, res);
  if (files.length === 0) {
    req.allFiles = [];
    res.locals.allFiles = [];
    return next();
  }
  req.allFiles = files;
  res.locals.allFiles = files;
  registerTempFiles(res, files);
  next();
};

//
// preflight quota check with atomic reservation
//
export const preflightStorageQuotaCheck = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const files = (res.locals.allFiles as Express.Multer.File[]) ?? [];
  const totalUploadSize = files.reduce((sum, file) => sum + BigInt(file.size), 0n);

  if (totalUploadSize <= 0n) {
    const err: RequestError = {
      name: "Bad Request",
      status: 400,
      message: "No files were uploaded",
      expected: true
    };
    return next(err);
  }
  const classIdNum = parseInt(req.session.classId!, 10);

  try {
    await prisma.$transaction(async tx => {
      await reserveStorage(tx, classIdNum, totalUploadSize);
    });

    // Store reserved amount in res.locals for service layer
    res.locals.reservedBytes = totalUploadSize;
    // reserves the storage in res.locals.uploadCleanupState
    registerReservedBytes(res, totalUploadSize);
    next();
  }
  catch (error) {
    next(error);
  }
};

//
// preflight quota check for edit uploads
//
export const preflightEditStorageQuotaCheck = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const files = (res.locals.allFiles as Express.Multer.File[]) ?? [];
  // if there are no files, skip this middleware
  if (files.length === 0){
    res.locals.filesChanged = false;
    return next();
  }
  const totalUploadSize = files.reduce((sum, file) => sum + BigInt(file.size ?? 0), 0n);

  if (totalUploadSize <= 0n) {
    const err: RequestError = {
      name: "Bad Request",
      status: 400,
      message: "This request indicates that files were uploaded, but their size is <= 0",
      expected: true
    };
    return next(err);
  }

  const classIdNum = parseInt(req.session.classId!, 10);
  const uploadId = Number(req.params.id);

  if (Number.isNaN(uploadId)) {
    const err: RequestError = {
      name: "Bad Request",
      status: 400,
      message: "Invalid upload id.",
      expected: true
    };
    return next(err);
  }

  try {
    await prisma.$transaction(async tx => {
      const uploadData = await tx.upload.findUnique({
        where: { uploadId },
        include: { Files: true }
      });

      if (!uploadData || uploadData.classId !== classIdNum) {
        const err: RequestError = {
          name: "Not Found",
          status: 404,
          message: "Upload not found.",
          expected: true
        };
        throw err;
      }

      const oldFilesSize = uploadData.Files.reduce((sum, file) => sum + BigInt(file.size), 0n);
      const additionalBytesNeeded = totalUploadSize > oldFilesSize ? totalUploadSize - oldFilesSize : 0n;

      if (additionalBytesNeeded <= 0n) {
        res.locals.reservedBytes = 0n;
        registerReservedBytes(res, 0n);
        return;
      }

      await reserveStorage(tx, classIdNum, additionalBytesNeeded);

      res.locals.reservedBytes = additionalBytesNeeded;
      registerReservedBytes(res, additionalBytesNeeded);
    });

    next();
  }
  catch (error) {
    next(error);
  }
};

//
// check if current upload would exceed the max file upload limit per class
//
export const checkClassFileCountLimit = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  // session.classId sertainly exists here because the access check ran before it
  const classId = parseInt(req.session.classId!, 10);

  const fileCount = await prisma.fileMetadata.count({
    where: {
      Upload: {
        classId: classId
      }
    }
  });

  // TODO @Mingqi: is does not count the files that are being uploaded, 
  // since this would be computationally more expensive, consider to move after other middleware, where filesCount is available.
  if (fileCount >= MAX_FILES_PER_CLASS) {
    const err: RequestError = {
      name: "Content Too Large",
      status: 413,
      message: "Upload limit reached: this class already has the maximum number of files allowed.",
      expected: true
    };
    return next(err);
  }

  next();
};

//
// Attach cleanup/rollback hooks for non-error responses or aborted connections
//
export const attachUploadCleanupOnFail = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  // avoid double cleanup
  let finalized = false;

  const detachListeners = (): void => {
    // remove all listeners
    res.off("finish", onFinish);
    res.off("close", onClose);
    res.off("error", onError);
    if (res.locals.uploadCleanupListeners) {
      delete res.locals.uploadCleanupListeners;
    }
  };

  const cleanup = async (reason: string): Promise<void> => {
    // if already finalized, return
    if (finalized) return;
    finalized = true;

    await performUploadCleanup(req, res, reason);
    // remove listeners
    detachListeners();
  };

  // Run cleanup on aborted connections or non-2xx/3xx responses
  const onFinish = (): void => {
    if (res.statusCode >= 400) {
      void cleanup("non-success response");
    }
    else {
      detachListeners();
    }
  };
  // Treat as an abort and cleanup
  const onClose = (): void => {
    // connection closed before the response was fully sent
    if (!res.writableEnded) {
      void cleanup("aborted connection");
    }
    else {
      detachListeners();
    }
  };
  // Always cleanup at error
  const onError = (): void => {
    void cleanup("response error");
  };

  // listener functions
  res.on("finish", onFinish);
  res.on("close", onClose);
  res.on("error", onError);

  res.locals.uploadCleanupListeners = { onFinish, onClose, onError };
  next();
};

//
// Temp storage before file is scanned and sanitized
//
export const tempStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, TEMP_DIR);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = randomUUID();
    const detectedExt = mime.extension(file.mimetype) || path.extname(file.originalname).substring(1);
    cb(null, `${uniqueSuffix}.${detectedExt}`);
  }
});

//
// Filter for MIME type and extension based on client-provided info
//
export const secureFileFilter = (
  req: Request,
  file: Express.Multer.File,
  cb: FileFilterCallback
): void => {
  // Check extension
  const ext = path.extname(file.originalname).toLowerCase();
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    const err: RequestError = {
      name: "Bad Request",
      status: 400,
      message: "MIME-Type not supported",
      expected: true
    };
    return cb(err);
  }

  // Check client-provided MIME type
  if (!ALLOWED_MIMES.includes(file.mimetype)) {
    const err: RequestError = {
      name: "Bad Request",
      status: 400,
      message: "MIME-Type not supported",
      expected: true
    };
    return cb(err);
  }

  // Check for obvious mismatches
  const expectedMime = mime.lookup(file.originalname);
  const normalizedExpectedMime = expectedMime ? normalizeMimeType(expectedMime.toString()) : false;
  const normalizedClaimedMime = normalizeMimeType(file.mimetype);
  const allowedMimesForExtension = EXPECTED_MIMES_BY_EXTENSION[ext];

  if (normalizedExpectedMime && normalizedExpectedMime !== normalizedClaimedMime) {
    const extensionAllowsMime = allowedMimesForExtension?.includes(file.mimetype) ?? false;
    if (extensionAllowsMime) {
      return cb(null, true);
    }
    const err: RequestError = {
      name: "Bad Request",
      status: 400,
      message: "MIME-Type not supported",
      expected: true
    };
    return cb(err);
  }

  cb(null, true);
};

//
// Multer upload instance configured with storage, filter, and limits
//
export const secureUpload = multer({
  storage: tempStorage,
  fileFilter: secureFileFilter,
  limits: {
    fileSize: MAX_FILE_SIZE,
    files: MAX_FILES_PER_UPLOAD
  }
});

//
// Wrapper to catch Multer errors (specifically file size limit)
//
export const handleFileUpload = (req: Request, res: Response, next: NextFunction): void => {
  const upload = secureUpload.array("files", MAX_FILES_PER_UPLOAD);

  upload(req, res, err => {
    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") {
        const error: RequestError = {
          name: "Content Too Large",
          status: 413,
          message: "File size limit exceeded",
          expected: true
        };
        return next(error);
      }
      if (err.code === "LIMIT_UNEXPECTED_FILE") {
        const error: RequestError = {
          name: "Bad Request",
          status: 413,
          message: "Too many files uploaded",
          expected: true
        };
        return next(error);
      }
      const error: RequestError = {
        name: "Bad Request",
        status: 400,
        message: err.message,
        expected: true
      };
      return next(error);
    }
    // busboy parse errors (e.g. truncated multipart body from iOS WebKit or aborted uploads)
    // are client errors, not server errors
    if (err instanceof Error && MULTIPART_PARSE_ERRORS.has(err.message)) {
      const error: RequestError = {
        name: "Bad Request",
        status: 400,
        message: "Upload incomplete: the file data could not be read completely",
        expected: true
      };
      return next(error);
    }
    if (err) {
      return next(err);
    }

    next();
  });
};

//
// sums the file sizes and reserves the storage
//
const reserveStorage = async (
  tx: Prisma.TransactionClient,
  classIdNum: number,
  bytesToReserve: bigint
): Promise<void> => {
  const classQuota = await tx.class.findUnique({
    where: { classId: classIdNum },
    select: {
      storageQuotaBytes: true,
      storageUsedBytes: true
    }
  });
  if (!classQuota) {
    const err: RequestError = {
      name: "Not Found",
      status: 404,
      message: "Class not found",
      expected: true
    };
    throw err;
  }
  if (classQuota.storageUsedBytes + bytesToReserve > classQuota.storageQuotaBytes) {
    const err: RequestError = {
      name: "Content Too Large",
      status: 413,
      message: "Class storage quota will be exceeded",
      expected: true
    };
    throw err;
  }
  await tx.class.update({
    where: { classId: classIdNum },
    data: {
      storageUsedBytes: {
        increment: bytesToReserve
      }
    }
  });
};

export default {
  secureUpload,
  handleFileUpload,
  attachUploadCleanupOnFail,
  preflightStorageQuotaCheck,
  preflightEditStorageQuotaCheck,
  checkClassFileCountLimit,
  normalizeFiles,
  normalizeFilesOptional
};
