import { Request, Response, NextFunction } from "express";
import reportService from "../services/report.service.js";

export const createReport = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const created = await reportService.createReport(req.body, req.session);
    // 200: same reporter already has an open report on the target
    res.sendStatus(created ? 201 : 200);
  }
  catch (error) {
    next(error);
  }
};

export default {
  createReport
};
