import express from "express";
import rateLimit from "express-rate-limit";
import moderationController from "../controllers/moderation.controller.js";
import checkAccess from "../middleware/access.middleware.js";
import {
  getReportFileSchema,
  getReportSchema,
  loginSchema,
  resolveReportSchema,
  unbanAccountSchema
} from "../schemas/moderation.schema.js";
import { validate } from "../middleware/validation.middleware.js";
import { sendCsrfToken } from "../middleware/csrfProtection.middleware.js";

// moderation rate limiters
const moderationLimiter = rateLimit({ windowMs: 60 * 1000, limit: 30 });
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10 });

const router = express.Router();

// at /moderation/api (outside /api): not versioned with app,
// and service worker caches /api responses (NEVER for moderation data)
router.use(moderationLimiter, (req, res, next) => {
  res.set({ "Cache-Control": "no-store", "X-Robots-Tag": "noindex" });
  next();
});

// panel session is separate from app session -> own CSRF token
router.get("/csrf-token", sendCsrfToken);
router.post("/login", loginLimiter, validate(loginSchema), moderationController.login);

router.use(checkAccess(["MODERATOR"])); // everything below needs panel login
router.post("/logout", moderationController.logout);
router.get("/overview", moderationController.getOverview);
router.get("/reports/:id", validate(getReportSchema), moderationController.getReport);
router.get("/reports/:id/files/:fileId", validate(getReportFileSchema), moderationController.getReportFile);
router.post("/reports/:id/resolve", validate(resolveReportSchema), moderationController.resolveReport);
router.post("/accounts/:id/unban", validate(unbanAccountSchema), moderationController.unbanAccount);

export default router;
