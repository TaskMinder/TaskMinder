import { Request, Response, NextFunction } from "express";
import reportService from "../services/report.service.js";

export const createReport = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const created = await reportService.createReport(req.body, req.session, req.ip);
    // open report by same reporter on same target is no-op
    res.sendStatus(created ? 201 : 200);
  }
  catch (error) {
    next(error);
  }
};

export default {
  createReport
};
