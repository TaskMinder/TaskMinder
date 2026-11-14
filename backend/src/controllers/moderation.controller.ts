import { Request, Response, NextFunction } from "express";
import moderationService from "../services/moderation.service.js";

export const login = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const loginUntil = await moderationService.login(req.body, req.session);
    res.status(200).json({ loginUntil });
  }
  catch (error) {
    next(error);
  }
};

export const logout = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    await moderationService.logout(req.session);
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

export const resolveReport = async (req: Request<{ id: string }>, res: Response, next: NextFunction): Promise<void> => {
  try {
    await moderationService.resolveReport({ id: Number(req.params.id) }, req.body);
    res.sendStatus(204);
  }
  catch (error) {
    next(error);
  }
};

export const unbanAccount = async (req: Request<{ id: string }>, res: Response, next: NextFunction): Promise<void> => {
  try {
    await moderationService.unbanAccount({ id: Number(req.params.id) });
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
  resolveReport,
  unbanAccount
};
