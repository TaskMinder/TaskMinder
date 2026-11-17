import express from "express";
import rateLimit from "express-rate-limit";
import moderationController from "../controllers/moderation.controller.js";
import checkAccess from "../middleware/access.middleware.js";
import { getReportSchema, loginSchema, resolveReportSchema, unbanAccountSchema } from "../schemas/moderation.schema.js";
import { validate } from "../middleware/validation.middleware.js";

// moderation rate limiters
const moderationLimiter = rateLimit({ windowMs: 60 * 1000, limit: 30 });
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10 });

const router = express.Router();

// mounted at /moderation/api, outside /api: the panel is not versioned with the app,
// and the service worker caches /api responses, which must never happen to moderation data
router.use(moderationLimiter, (req, res, next) => {
  res.set({ "Cache-Control": "no-store", "X-Robots-Tag": "noindex" });
  next();
});

router.post("/login", loginLimiter, validate(loginSchema), moderationController.login);
router.post("/logout", checkAccess(["MODERATOR"]), moderationController.logout);

router.get("/overview", checkAccess(["MODERATOR"]), moderationController.getOverview);
router.get("/reports/:id", checkAccess(["MODERATOR"]), validate(getReportSchema), moderationController.getReport);
router.post("/reports/:id/resolve", checkAccess(["MODERATOR"]), validate(resolveReportSchema), moderationController.resolveReport);
router.post("/accounts/:id/unban", checkAccess(["MODERATOR"]), validate(unbanAccountSchema), moderationController.unbanAccount);

export default router;
