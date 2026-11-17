import { Request, Response, NextFunction } from "express";
import accountService from "../services/account.service.js";

const regenerateSession = (
  req: Request,
  preservedData: { classId?: string; csrfToken?: string }
): Promise<void> => {
  return new Promise((resolve, reject) => {
    req.session.regenerate(err => {
      if (err) {
        reject(err);
        return;
      }
      if (preservedData.classId) {
        req.session.classId = preservedData.classId;
      }
      if (preservedData.csrfToken) {
        req.session.csrfToken = preservedData.csrfToken;
      }
      resolve();
    });
  });
};

export const registerAccount = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    await regenerateSession(req, {
      classId: req.session.classId,
      csrfToken: req.session.csrfToken
    });
    await accountService.registerAccount(req.body, req.session);
    res.sendStatus(201);
  }
  catch (error) {
    next(error);
  }
};

export const loginAccount = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    await regenerateSession(req, {
      classId: req.session.classId,
      csrfToken: req.session.csrfToken
    });
    await accountService.loginAccount(req.body, req.session);
    res.sendStatus(200);
  }
  catch (error) {
    next(error);
  }
};

export const logoutAccount = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    await accountService.logoutAccount(req.session);
    await regenerateSession(req, {
      classId: req.session.classId,
      csrfToken: req.session.csrfToken
    });
    res.sendStatus(200);
  }
  catch (error) {
    next(error);
  }
};

export const deleteAccount = async (req: Request<{ id: string }>, res: Response, next: NextFunction): Promise<void> => {
  try {
    await accountService.deleteAccount(req.body, req.session);
    await regenerateSession(req, {
      classId: req.session.classId,
      csrfToken: req.session.csrfToken
    });
    res.sendStatus(200);
  }
  catch (error) {
    next(error);
  }
};

export const getAuth = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const response = await accountService.getAuth(req.session);
    res.status(200).json(response);
  }
  catch (error) {
    next(error);
  }
};

export const changeUsername = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    await accountService.changeUsername(req.body, req.session);
    res.sendStatus(200);
  }
  catch (error) {
    next(error);
  }
};

export const changePassword = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    await accountService.changePassword(req.body, req.session);
    res.sendStatus(200);
  }
  catch (error) {
    next(error);
  }
};

export const checkUsername = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const response = await accountService.checkUsername({ username: String(req.query.username ?? "") });
    res.status(200).json(response);
  }
  catch (error) {
    next(error);
  }
};

export const getNotices = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const notices = await accountService.getNotices(req.session);
    res.status(200).json(notices);
  }
  catch (error) {
    next(error);
  }
};

export const markNoticeSeen = async (req: Request<{ id: string }>, res: Response, next: NextFunction): Promise<void> => {
  try {
    await accountService.markNoticeSeen({ id: Number(req.params.id) }, req.session);
    res.sendStatus(200);
  }
  catch (error) {
    next(error);
  }
};

export default {
  registerAccount,
  loginAccount,
  logoutAccount,
  deleteAccount,
  getAuth,
  checkUsername,
  changeUsername,
  changePassword,
  getNotices,
  markNoticeSeen
};
