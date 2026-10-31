import express from "express";
import rateLimit from "express-rate-limit";
import userController from "../controllers/account.controller.js";
import checkAccess from "../middleware/access.middleware.js";
import { validate } from "../middleware/validation.middleware.js";
import { 
  changePasswordSchema, 
  changeUsernameSchema, 
  checkUsernameSchema, 
  deleteAccountSchema, 
  loginAccountSchema, 
  markNoticeSeenSchema,
  registerAccountSchema 
} from "../schemas/account.schema.js";

// account rate limiter
export const authLimiter = rateLimit({ windowMs: 1000, limit: 10 });

const router = express.Router();

router.post("/register", authLimiter, validate(registerAccountSchema), userController.registerAccount);
router.post("/login", authLimiter, validate(loginAccountSchema), userController.loginAccount);
router.delete("/me", authLimiter, checkAccess(["ACCOUNT"]), validate(deleteAccountSchema), userController.deleteAccount);
router.patch("/username", authLimiter, checkAccess(["ACCOUNT"]), validate(changeUsernameSchema), userController.changeUsername);
router.patch("/password", authLimiter, checkAccess(["ACCOUNT"]), validate(changePasswordSchema), userController.changePassword);
router.get("/auth", authLimiter, userController.getAuth);
router.post("/logout", authLimiter, checkAccess(["ACCOUNT"]), userController.logoutAccount);
router.get("/check-username", authLimiter, validate(checkUsernameSchema), userController.checkUsername);
router.get("/notices", authLimiter, checkAccess(["ACCOUNT"]), userController.getNotices);
router.post("/notices/:id/seen", authLimiter, checkAccess(["ACCOUNT"]), validate(markNoticeSeenSchema), userController.markNoticeSeen);

export default router;
