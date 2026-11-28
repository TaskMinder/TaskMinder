import express, { Request } from "express";
import rateLimit from "express-rate-limit";
import reportController from "../controllers/report.controller.js";
import checkAccess from "../middleware/access.middleware.js";
import { createReportSchema } from "../schemas/report.schema.js";
import { validate } from "../middleware/validation.middleware.js";

// per reporter, as a whole school can share one IP; IP limit against new anonymous sessions
const reporterKey = (req: Request): string => req.session.account ? `account:${req.session.account.accountId}` : `session:${req.sessionID}`;
const reportIpLimiter = rateLimit({ windowMs: 60 * 1000, limit: 60 });
const createReportLimiter = rateLimit({ windowMs: 60 * 1000, limit: 5, keyGenerator: reporterKey });
// daily cap, so one reporter cannot use up the daily mail quota with many contact addresses
const dailyReportLimiter = rateLimit({ windowMs: 24 * 60 * 60 * 1000, limit: 20, keyGenerator: reporterKey });

const router = express.Router();

// anonymous members may report too
router.post(
  "/",
  reportIpLimiter,
  checkAccess(["CLASS"]),
  createReportLimiter,
  dailyReportLimiter,
  validate(createReportSchema),
  reportController.createReport
);

export default router;
