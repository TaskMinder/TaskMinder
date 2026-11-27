import express, { Request } from "express";
import rateLimit from "express-rate-limit";
import reportController from "../controllers/report.controller.js";
import checkAccess from "../middleware/access.middleware.js";
import { createReportSchema } from "../schemas/report.schema.js";
import { validate } from "../middleware/validation.middleware.js";

// report rate limiters: per reporter, as whole school can share one IP;
// loose IP limit stays as backstop against new anonymous sessions
const reportIpLimiter = rateLimit({ windowMs: 60 * 1000, limit: 60 });
const createReportLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 5,
  // runs after access check, so session exists
  keyGenerator: (req: Request) => req.session.account ? `account:${req.session.account.accountId}` : `session:${req.sessionID}`
});

const router = express.Router();

// anonymous sessions may report too
router.post("/", reportIpLimiter, checkAccess(["CLASS"]), createReportLimiter, validate(createReportSchema), reportController.createReport);

export default router;
