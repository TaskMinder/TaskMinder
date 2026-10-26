import { CACHE_KEY_PREFIXES, dequeueJob, QUEUE_KEYS } from "../config/redis.js";
import { invalidateCache } from "../config/redis.js";
import logger from "../config/logger.js";
import { prisma } from "../config/prisma.js";
import fs from "fs/promises";
import path from "path";
import {
  FINAL_UPLOADS_DIR,
  QUARANTINE_DIR,
  SANITIZED_DIR,
  CLAMSCAN_TIMEOUT,
  GHOSTSCRIPT_TIMEOUT,
  MAX_IMAGE_PIXELS,
  TEMP_DIR,
  EXPECTED_MIMES_BY_EXTENSION,
  MIME_CANONICAL_ALIASES
} from "../config/upload.js";
import { execFile, ExecException } from "child_process";
import { promisify } from "util";
import sharp from "sharp";
import { randomUUID } from "crypto";
import { emitSocketToClass, SOCKET_EVENTS } from "../config/socket.js";
import { RequestError } from "../@types/requestError.js";
import { fileTypeFromFile } from "file-type";
import { StringDecoder } from "string_decoder";

const execFileAsync = promisify(execFile);

const TEXT_MIME_TYPES = new Set(["text/plain", "text/markdown", "text/csv"]);
const normalizeMimeType = (mimeType: string): string => MIME_CANONICAL_ALIASES[mimeType] ?? mimeType;

const SAMPLE_SIZE = 8192;
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

const ensureDirExists = async (dirPath: string): Promise<void> => {
  try {
    await fs.mkdir(dirPath, { recursive: true });
  }
  catch (error) {
    logger.error(`Failed to create directory ${dirPath}: ${error}`);
    throw error;
  }
};

let gsCommand: string | null = null;
let clamavEnabled = false;

type FileProcessingJob = {
  uploadId: number;
  classId: number;
  tempFiles: Array<{
    path: string;
    originalName: string;
    mimetype: string;
    size: number;
  }>;
  replaceUpload?: {
    oldStoredFiles: string[];
    oldTotalBytes: string;
  };
};

//
// script called in server.ts at server startup 
// to avoid excessive which calls at every upload request and path checking
// 
export const initializeUploadWorkerServices = async (): Promise<void> => {

  await Promise.all([
    ensureDirExists(TEMP_DIR),
    ensureDirExists(QUARANTINE_DIR),
    ensureDirExists(SANITIZED_DIR),
    ensureDirExists(FINAL_UPLOADS_DIR)
  ]);

  try {
    // check if clamdscan (ClamAV) is installed on the system
    await execFileAsync("which", ["clamdscan"]);
  }
  catch {
    logger.warn("ClamAV (clamdscan) not found in worker. Please install it..");
    process.exit(1);
  }

  try {
    // this checks if clamdscan is really running on at least development machines
    // in production, this app is executed in docker compose which installs and starts clamAV
    await execFileAsync("clamdscan", ["--ping", "5"]);
    logger.info("ClamAV (clamdscan) enabled for worker");
    clamavEnabled = true;
  }
  catch {
    clamavEnabled = true;
    logger.error("clamdscan is not reachable with --ping 5. In production, this app should be running with docker compose, skipping for now");
  }

  try {
    await execFileAsync("which", ["gs"]);
    gsCommand = "gs";
    logger.info("Ghostscript enabled for worker");
  }
  catch {
    logger.warn("Ghostscript not found in worker. Please install it.");
    process.exit(1);
  }
};

// @codescene(disable:"Complex Method")
// This is disabled as the complexity is caused by the try catche and if blocks
// This function just let clasmAV scan the requested file for malware
// Another main ache point for code scene is the error extraction
const scanFileClamAV = async (filePath: string, originalName: string): Promise<void> => {
  if (!clamavEnabled) return;

  try {
    await execFileAsync("clamdscan", ["--no-summary", "--fdpass", filePath], { timeout: CLAMSCAN_TIMEOUT });
  }
  catch (error) {
    const scanError = error as ExecException & { stdout?: string; stderr?: string };
    if (scanError.code === 1 && scanError.stdout?.includes("FOUND")) {
      const quarantinePath = path.join(QUARANTINE_DIR, `${Date.now()}-${path.basename(originalName)}`);
      await fs.rename(filePath, quarantinePath).catch(() => { });
      logger.warn(`File quarantined: ${quarantinePath}`);
      const err: RequestError = {
        name: "Bad Request",
        status: 400,
        message: "File upload rejected: A potential threat was detected in the uploaded file",
        expected: true
      };
      throw err;
    }
    else {
      logger.error(`ClamAV scan failed: ${scanError}`);
      const err: RequestError = {
        name: "Internal Server Error",
        status: 500,
        message: "An error occurred while uploading the file",
        expected: true
      };
      throw err;
    }
  }
};

const verifyTextFile = async (filePath: string): Promise<void> => {
  const fileHandle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(SAMPLE_SIZE);
    const { bytesRead } = await fileHandle.read(buffer, 0, SAMPLE_SIZE, 0);
    const sample = buffer.subarray(0, bytesRead);

    // Strip UTF-8 BOM if present (common in Excel-exported CSVs)
    const payload = sample.subarray(0, 3).equals(UTF8_BOM)
      ? sample.subarray(3)
      : sample;

    // NUL byte check is cheap and catches the most obvious case
    // control-char-frequency check is overkill (ClamAV exists in the pipeline)
    if (payload.includes(0x00)) {
      const err: RequestError = {
        name: "Bad Request",
        status: 400,
        message: "Invalid text file encoding",
        expected: true
      };
      throw err;
    }

    const decoder = new StringDecoder("utf-8");
    const decoded = decoder.write(payload) + decoder.end();

    if (decoded.includes("\uFFFD")) {
      const err: RequestError = {
        name: "Bad Request",
        status: 400,
        message: "Invalid text file encoding",
        expected: true
      };
      throw err;
    }
  }
  finally {
    await fileHandle.close().catch(() => {
      logger.error("Failed to close file handle during text file type check");
    });
  }
};

const verifyFileType = async (filePath: string, claimedMime: string, originalName: string): Promise<string> => {
  const ext = path.extname(originalName).toLowerCase();
  const allowedMimesForExtension = EXPECTED_MIMES_BY_EXTENSION[ext];

  if (!allowedMimesForExtension) {
    const err: RequestError = {
      name: "Bad Request",
      status: 400,
      message: "MIME-Type is not supported",
      expected: true
    };
    throw err;
  }

  const normalizedClaimedMime = normalizeMimeType(claimedMime);
  const normalizedAllowedMimes = new Set(allowedMimesForExtension.map(normalizeMimeType));

  if (!normalizedAllowedMimes.has(normalizedClaimedMime)) {
    const err: RequestError = {
      name: "Bad Request",
      status: 400,
      message: "MIME-Type is not supported",
      expected: true
    };
    throw err;
  }

  if (TEXT_MIME_TYPES.has(normalizedClaimedMime)) {
    await verifyTextFile(filePath);
    return normalizedClaimedMime;
  }

  const detectedType = await fileTypeFromFile(filePath);
  const normalizedDetectedMime = detectedType ? normalizeMimeType(detectedType.mime) : null;
  if (!normalizedDetectedMime || !normalizedAllowedMimes.has(normalizedDetectedMime)) {
    const err: RequestError = {
      name: "Bad Request",
      status: 400,
      message: "MIME-Type is not supported",
      expected: true
    };
    throw err;
  }

  return normalizedDetectedMime;
};

const sanitizeImage = async (filePath: string, mimetype: string): Promise<number> => {
  const sanitizedPath = path.join(SANITIZED_DIR, `sanitized-${path.basename(filePath)}`);

  try {
    const sharpInstance = sharp(filePath, { limitInputPixels: MAX_IMAGE_PIXELS }).rotate();

    if (mimetype === "image/png") {
      await sharpInstance.png({ compressionLevel: 9, effort: 8 }).toFile(sanitizedPath);
    }
    else {
      await sharpInstance.jpeg({ quality: 90 }).toFile(sanitizedPath);
    }

    await fs.unlink(filePath);
    await fs.rename(sanitizedPath, filePath);

    const stats = await fs.stat(filePath);
    return stats.size;
  }
  catch {
    await fs.unlink(sanitizedPath).catch(() => { });
    const err: RequestError = {
      name: "Internal Server Error",
      status: 500,
      message: "An error occured while uploading the file",
      expected: true
    };
    throw err;
  }
};

const sanitizePDF = async (filePath: string): Promise<number> => {
  if (!gsCommand) return (await fs.stat(filePath)).size;

  const sanitizedPath = path.join(SANITIZED_DIR, `sanitized-${path.basename(filePath)}`);
  const startedAt = Date.now();

  try {
    const gsArgs = [
      "-dPDFA=2",
      "-dBATCH",
      "-dNOPAUSE",
      "-dNOOUTERSAVE",
      "-dSAFER",
      "-sDEVICE=pdfwrite",
      // Start with ebook baseline
      "-dPDFSETTINGS=/ebook",
      // Override with custom resolution
      "-dColorImageResolution=200",
      "-dGrayImageResolution=200",
      "-dMonoImageResolution=600",
      // Improve JPEG quality from ebook default
      "-dJPEGQ=85",  // ebook uses ~75, printer uses ~90
      "-sColorConversionStrategy=RGB",
      "-sBlendConversionStrategy=Simple",
      "-dEmbedAllFonts=true",
      "-dSubsetFonts=true",
      "-dPDFACompatibilityPolicy=1",
      `-sOutputFile=${sanitizedPath}`,
      filePath
    ];

    await execFileAsync(gsCommand, gsArgs, { timeout: GHOSTSCRIPT_TIMEOUT });

    const stats = await fs.stat(sanitizedPath);
    if (!stats || stats.size === 0) {
      const err: RequestError = {
        name: "Internal Server Error",
        status: 500,
        message: "An error occured while uploading the file",
        expected: true
      };
      throw err;
    }

    await fs.unlink(filePath);
    await fs.rename(sanitizedPath, filePath);

    return stats.size;
  }
  catch (error) {
    const processError = error as ExecException & {
      stdout?: string;
      stderr?: string;
    };
    logger.error("PDF sanitization failed", {
      file: path.basename(filePath),
      durationMs: Date.now() - startedAt,
      errorMessage: processError.message,
      errorCode: processError.code,
      stderr: processError.stderr?.trim().slice(-4000)
    });
    await fs.unlink(sanitizedPath).catch(() => { });
    const err: RequestError = {
      name: "Internal Server Error",
      status: 500,
      message: "An error occured while uploading the file",
      expected: true
    };
    throw err;
  }
};

const processFile = async (
  file: FileProcessingJob["tempFiles"][0],
  classId: number
): Promise<{ storedFileName: string; finalSize: number; mimeType: string }> => {
  const verifiedMimeType = await verifyFileType(file.path, file.mimetype, file.originalName);
  await scanFileClamAV(file.path, file.originalName);

  // Sanitize based on type
  let finalSize = file.size;
  if (verifiedMimeType.startsWith("image/")) {
    finalSize = await sanitizeImage(file.path, verifiedMimeType);
  }
  else if (verifiedMimeType === "application/pdf") {
    finalSize = await sanitizePDF(file.path);
  }

  // Move to final destination
  const finalDirectory = path.join(FINAL_UPLOADS_DIR, classId.toString());
  await fs.mkdir(finalDirectory, { recursive: true });

  const ext = path.extname(file.originalName).toLowerCase().slice(1);
  if (!ext) {
    const err: RequestError = {
      name: "Bad Request",
      status: 400,
      message: "MIME-Type is not supported",
      expected: true
    };
    throw err;
  }

  // Use random UUID to store file
  const storedFileName = `${randomUUID()}.${ext}`;
  const finalPath = path.join(finalDirectory, storedFileName);

  await fs.rename(file.path, finalPath);

  return { storedFileName, finalSize, mimeType: verifiedMimeType };
};

// @codescene(disable:"Complex Method", disable: "Large Method")
// This is disabled because this job updates the files of an upload and processes them
// The code here is pretty straightforward and the complexity is caused by the for loop 
// (because there are multiple files)
const processJob = async (job: FileProcessingJob): Promise<void> => {
  const { uploadId, classId, tempFiles } = job;

  // Declare processedFiles outside try block so it's accessible in catch
  const processedFiles: Array<{ storedFileName: string; originalName: string; mimeType: string; size: number }> = [];
  let metadataReplaced = false;

  try {
    // Update status to processing
    const upload = await prisma.upload.findUnique({
      where: { uploadId },
      select: { reservedBytes: true }
    });

    // If no upload is available, file was already moved or deleted 
    // -> catch block, trying to delete metadata and real files
    if (!upload) {
      const err: RequestError = {
        name: "Not Found",
        status: 404,
        message: "File already deleted or moved",
        expected: true
      };
      throw err;
    }

    await prisma.upload.update({
      where: { uploadId },
      data: { status: "processing" }
    });

    // Invalidate cache when status changes to processing
    await invalidateCache(CACHE_KEY_PREFIXES.UPLOADMETADATA, classId.toString());

    let totalBytes = 0n;

    // Process each file
    for (const file of tempFiles) {
      const { storedFileName, finalSize, mimeType } = await processFile(file, classId);
      processedFiles.push({
        storedFileName,
        originalName: file.originalName,
        mimeType,
        size: finalSize
      });
      totalBytes += BigInt(finalSize);
    }

    // Store metadata and adjust storage atomically
    await prisma.$transaction(async tx => {
      if (job.replaceUpload) {
        await tx.fileMetadata.deleteMany({ where: { uploadId } });
      }

      for (const file of processedFiles) {
        await tx.fileMetadata.create({
          data: {
            uploadId,
            storedFileName: file.storedFileName,
            mimeType: file.mimeType,
            size: file.size,
            createdAt: BigInt(Date.now())
          }
        });
      }

      const baselineBytes = job.replaceUpload
        ? BigInt(job.replaceUpload.oldTotalBytes) + upload.reservedBytes
        : upload.reservedBytes;

      // Calculate storage adjustment
      const storageAdjustment = totalBytes - baselineBytes;

      // Adjust class storage (can be positive or negative)
      await tx.class.update({
        where: { classId },
        data: {
          storageUsedBytes: storageAdjustment >= 0n
            ? { increment: storageAdjustment }
            : { decrement: -storageAdjustment }
        }
      });

      // Mark upload as completed and clear reservation
      await tx.upload.update({
        where: { uploadId },
        data: {
          status: "completed",
          reservedBytes: 0n
        }
      });
    });

    if (job.replaceUpload) {
      metadataReplaced = true;
    }

    if (job.replaceUpload) {
      await Promise.all(
        job.replaceUpload.oldStoredFiles.map(storedFileName => {
          const filePath = path.join(FINAL_UPLOADS_DIR, classId.toString(), storedFileName);
          return fs.unlink(filePath).catch(() => { });
        })
      );
    }

    // Invalidate cache when status changes to completed
    await invalidateCache(CACHE_KEY_PREFIXES.UPLOADMETADATA, classId.toString());

    // Call socket functions for client update
    emitSocketToClass(classId, SOCKET_EVENTS.UPLOADS);

    logger.info(`Successfully processed upload ${uploadId} with ${processedFiles.length} file(s)`);
  }
  catch (error) {
    logger.error(`Failed to process upload ${uploadId}: `, error);

    // Clean up all temp files
    await Promise.all(tempFiles.map(f => fs.unlink(f.path).catch(() => { })));

    // Clean up any files that were already processed
    await Promise.all(
      processedFiles.map(file => {
        const filePath = path.join(FINAL_UPLOADS_DIR, classId.toString(), file.storedFileName);
        return fs.unlink(filePath).catch(() => { });
      })
    );

    // Mark upload as failed and release reserved storage
    const errorReason =
      error && typeof error === "object" && "message" in error
        ? String(error.message)
        : "unknown_error";

    await prisma.$transaction(async tx => {
      if (!job.replaceUpload || metadataReplaced) {
        // Delete any file metadata that was created
        await tx.fileMetadata.deleteMany({
          where: { uploadId }
        });
      }
      const upload = await tx.upload.findUnique({
        where: { uploadId },
        select: { reservedBytes: true }
      });

      if (upload) {
        if (upload.reservedBytes > 0n) {
          // Release reserved storage
          await tx.class.update({
            where: { classId },
            data: { storageUsedBytes: { decrement: upload.reservedBytes } }
          });
        }

        await tx.upload.update({
          where: { uploadId },
          data: {
            status: "failed",
            errorReason,
            reservedBytes: 0n
          }
        });
      }
    });

    await invalidateCache(CACHE_KEY_PREFIXES.UPLOADMETADATA, classId.toString());

    // Send socket events
    emitSocketToClass(classId, SOCKET_EVENTS.UPLOADS);
  }
};

let isRunning = false;

export const startUploadWorker = async (): Promise<void> => {
  if (isRunning) {
    logger.warn("Worker already running");
    return;
  }

  isRunning = true;
  logger.info("File processing worker started");

  while (isRunning) {
    try {
      const job = await dequeueJob(QUEUE_KEYS.FILE_PROCESSING) as FileProcessingJob | null;

      if (job) {
        await processJob(job);
      }
      else {
        // No jobs, wait a bit before checking again
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    catch (error) {
      logger.error("Worker error: ", error);
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
};

export const stopUploadWorker = (): void => {
  isRunning = false;
  logger.info("File processing worker stopped");
};
