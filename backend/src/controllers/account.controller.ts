import { Request, Response, NextFunction } from "express";
import accountService from "../services/account.service.js";
import { regenerateSession } from "../config/session.js";

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

export default {
  registerAccount,
  loginAccount,
  logoutAccount,
  deleteAccount,
  getAuth,
  checkUsername,
  changeUsername,
  changePassword
};
