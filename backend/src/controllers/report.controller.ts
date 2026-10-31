import { Request, Response, NextFunction } from "express";
import reportService from "../services/report.service.js";

export const createReport = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const created = await reportService.createReport(req.body, req.session);
    // an open report by the same reporter on the same target is a no-op
    res.sendStatus(created ? 201 : 200);
  }
  catch (error) {
    next(error);
  }
};

export default {
  createReport
};
