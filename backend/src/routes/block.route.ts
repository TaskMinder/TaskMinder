import express from "express";
import rateLimit from "express-rate-limit";
import blockController from "../controllers/block.controller.js";
import checkAccess from "../middleware/access.middleware.js";
import { addBlockSchema, deleteBlockSchema } from "../schemas/block.schema.js";
import { validate } from "../middleware/validation.middleware.js";

// block rate limiters
const readBlockLimiter = rateLimit({ windowMs: 1000, limit: 30 });
const writeBlockLimiter = rateLimit({ windowMs: 1000, limit: 10 });
// blocking also files a report, so it gets the strict report limit
const createBlockLimiter = rateLimit({ windowMs: 60 * 1000, limit: 5 });

const router = express.Router();

router.get("/", readBlockLimiter, checkAccess(["CLASS", "ACCOUNT"]), blockController.getBlocks);
router.post("/", createBlockLimiter, checkAccess(["CLASS", "ACCOUNT"]), validate(addBlockSchema), blockController.addBlock);
router.delete("/:accountId", writeBlockLimiter, checkAccess(["CLASS", "ACCOUNT"]), validate(deleteBlockSchema), blockController.deleteBlock);

export default router;
