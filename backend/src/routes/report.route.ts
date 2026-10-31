import express from "express";
import rateLimit from "express-rate-limit";
import reportController from "../controllers/report.controller.js";
import checkAccess from "../middleware/access.middleware.js";
import { createReportSchema } from "../schemas/report.schema.js";
import { validate } from "../middleware/validation.middleware.js";

// report rate limiter
const createReportLimiter = rateLimit({ windowMs: 60 * 1000, limit: 5 });

const router = express.Router();

// anonymous sessions may report too
router.post("/", createReportLimiter, checkAccess(["CLASS"]), validate(createReportSchema), reportController.createReport);

export default router;
