import { Request, Response, NextFunction } from "express";
import logger from "../config/logger.js";
import uploadService, { type GetUploadFileResult } from "../services/upload.service.js";
import { getUploadFileQuery } from "../schemas/upload.schema.js";

export const getUploadMetadata = async (
  req: Request, 
  res: Response, 
  next: NextFunction
): Promise<void> => {
  try {
    const uploadData = await uploadService.getUploadMetadata(req.session);
    res.status(200).json(uploadData);
  }
  catch (error) {
    next(error);
  }
};

// shared by app and moderation panel, "cacheControl" overrides file's own header
export function pipeUploadFile(
  { stream, headers }: GetUploadFileResult,
  res: Response,
  next: NextFunction,
  cacheControl = headers["Cache-Control"]
): void {
  res.setHeader("Content-Type", headers["Content-Type"]);
  res.setHeader("Content-Disposition", headers["Content-Disposition"]);
  res.setHeader("Cache-Control", cacheControl);

  stream.on("error", err => {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      logger.error("File not found on disk during streaming.");
      res.status(404).json({ message: "File not found on server." });
      return;
    }
    next(err);
  });
  res.on("close", () => {
    if (!res.writableEnded) {
      stream.destroy();
    }
  });
  stream.pipe(res);
}

export const getUploadFile = async (
  req: Request<
    { id: string },
    unknown, // ResBody: any/unknown
    unknown, // ReqBody: any/unknown (GET request has no body)
    getUploadFileQuery
  >, res: Response, next: NextFunction): Promise<void> => {
  try {
    const file = await uploadService.getUploadFile({ id: Number(req.params.id) }, req.query, req.session);
    pipeUploadFile(file, res, next);
  }
  catch (error) {
    next(error);
  }
};

export const editUpload = async (req: Request<{ id: string }>, res: Response, next: NextFunction): Promise<void> => {
  try {
    const files = (req.files as Express.Multer.File[]) ?? [];
    const reservedBytes = res.locals.reservedBytes as bigint;
    await uploadService.editUpload({ id: Number(req.params.id) }, req.body, req.session, files, reservedBytes);
    res.sendStatus(200);
  }
  catch (error) {
    if (error && typeof error === "object" && (error as Record<string, unknown>).reservationRolledBack) {
      res.locals.reservedBytes = 0n;
      res.locals.reservationReleased = true;
      if (res.locals.uploadCleanupState) {
        res.locals.uploadCleanupState.reservationReleased = true;
      }
    }
    next(error);
  }
};

export const deleteUpload = async (req: Request<{ id: string }>, res: Response, next: NextFunction): Promise<void> => {
  try {
    await uploadService.deleteUpload({ id: Number(req.params.id) }, req.session);
    res.sendStatus(200);
  }
  catch (error) {
    next(error);
  }
};

export const pinUpload = async (req: Request<{ id: string }>, res: Response, next: NextFunction): Promise<void> => {
  try {
    await uploadService.pinUpload({ id: Number(req.params.id) }, req.body, req.session);
    res.sendStatus(200);
  }
  catch (error) {
    next(error);
  }
};

export const queueFileUpload = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const files: Express.Multer.File[] = (res.locals.allFiles as Express.Multer.File[]);
    const reservedBytes = res.locals.reservedBytes as bigint;
    
    await uploadService.queueFileUpload(files, req.session, req.body, reservedBytes);
    
    res.sendStatus(200);
  }
  catch (error) {
    if (error && typeof error === "object" && (error as Record<string, unknown>).reservationRolledBack) {
      res.locals.reservedBytes = 0n;
      res.locals.reservationReleased = true;
      if (res.locals.uploadCleanupState) {
        res.locals.uploadCleanupState.reservationReleased = true;
      }
    }
    next(error);
  }
};

export const createUploadRequest = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    await uploadService.addUploadRequest(req.body, req.session);
    res.sendStatus(201);
  }
  catch (error) {
    next(error);
  }
};

export const getUploadRequests = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const uploadRequests = await uploadService.getUploadRequests(req.session);
    res.status(200).json(uploadRequests);
  }
  catch (error) {
    next(error);
  }
};

export const deleteUploadRequest = async (req: Request<{ id: string }>, res: Response, next: NextFunction): Promise<void> => {
  try {
    await uploadService.deleteUploadRequest({ id: Number(req.params.id) }, req.session);
    res.sendStatus(200);
  }
  catch (error) {
    next(error);
  }
};

export default {
  getUploadMetadata,
  getUploadFile,
  editUpload,
  deleteUpload,
  pinUpload,
  queueFileUpload,
  createUploadRequest,
  getUploadRequests,
  deleteUploadRequest
};