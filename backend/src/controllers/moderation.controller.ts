import { Request, Response, NextFunction } from "express";
import moderationService, { Moderator } from "../services/moderation.service.js";
import { MODERATION_COOKIE } from "../config/session.js";
import { pipeUploadFile } from "./upload.controller.js";

function moderatorOf(req: Request): Moderator {
  return { ip: req.ip, sessionId: req.sessionID };
}

export const login = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    res.status(200).json(await moderationService.login(req.body, req));
  }
  catch (error) {
    next(error);
  }
};

export const logout = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    await moderationService.logout(req);
    res.clearCookie(MODERATION_COOKIE.name, { path: MODERATION_COOKIE.path });
    res.sendStatus(204);
  }
  catch (error) {
    next(error);
  }
};

export const getOverview = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const overview = await moderationService.getOverview();
    res.status(200).json({ ...overview, loginUntil: req.session.moderatorUntil });
  }
  catch (error) {
    next(error);
  }
};

export const getReport = async (req: Request<{ id: string }>, res: Response, next: NextFunction): Promise<void> => {
  try {
    const report = await moderationService.getReport({ id: Number(req.params.id) });
    res.status(200).json({ ...report, loginUntil: req.session.moderatorUntil });
  }
  catch (error) {
    next(error);
  }
};

export const getReportFile = async (req: Request<{ id: string; fileId: string }>, res: Response, next: NextFunction): Promise<void> => {
  try {
    const file = await moderationService.getReportFile({ id: Number(req.params.id), fileId: Number(req.params.fileId) });
    pipeUploadFile(file, res, next, "no-store");
  }
  catch (error) {
    next(error);
  }
};

export const resolveReport = async (req: Request<{ id: string }>, res: Response, next: NextFunction): Promise<void> => {
  try {
    await moderationService.resolveReport({ id: Number(req.params.id) }, req.body, moderatorOf(req));
    res.sendStatus(204);
  }
  catch (error) {
    next(error);
  }
};

export const unbanAccount = async (req: Request<{ id: string }>, res: Response, next: NextFunction): Promise<void> => {
  try {
    await moderationService.unbanAccount({ id: Number(req.params.id) }, moderatorOf(req));
    res.sendStatus(204);
  }
  catch (error) {
    next(error);
  }
};

export default {
  login,
  logout,
  getOverview,
  getReport,
  getReportFile,
  resolveReport,
  unbanAccount
};
