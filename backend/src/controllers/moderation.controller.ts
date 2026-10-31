import { Request, Response, NextFunction } from "express";
import moderationService from "../services/moderation.service.js";
import { ensureCsrfSessionToken } from "../middleware/csrfProtection.middleware.js";

export const getReviewPage = async (req: Request<{ id: string }>, res: Response, next: NextFunction): Promise<void> => {
  try {
    const html = await moderationService.getReviewPage(
      { id: Number(req.params.id) },
      { token: String(req.query.token) },
      ensureCsrfSessionToken(req)
    );
    res.status(200).type("html").send(html);
  }
  catch (error) {
    next(error);
  }
};

export const resolveReport = async (req: Request<{ id: string }>, res: Response, next: NextFunction): Promise<void> => {
  try {
    const html = await moderationService.resolveReport({ id: Number(req.params.id) }, req.body);
    res.status(200).type("html").send(html);
  }
  catch (error) {
    next(error);
  }
};

export default {
  getReviewPage,
  resolveReport
};
