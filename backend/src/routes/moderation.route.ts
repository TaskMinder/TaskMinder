import express from "express";
import rateLimit from "express-rate-limit";
import moderationController from "../controllers/moderation.controller.js";
import { getReviewPageSchema, resolveReportSchema } from "../schemas/moderation.schema.js";
import { validate } from "../middleware/validation.middleware.js";

// moderation rate limiter
const moderationLimiter = rateLimit({ windowMs: 60 * 1000, limit: 30 });

const router = express.Router();

// mounted outside /api since plain html forms cannot send X-API-Version
router.use(moderationLimiter, (req, res, next) => {
  res.set({ "Cache-Control": "no-store", "X-Robots-Tag": "noindex" });
  next();
});

router.get("/reports/:id", validate(getReviewPageSchema), moderationController.getReviewPage);
router.post("/reports/:id/resolve", validate(resolveReportSchema), moderationController.resolveReport);

export default router;
