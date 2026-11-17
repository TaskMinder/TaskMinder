import "express-session";
import "express";

declare module "express-session" {
  interface SessionData {
    account?: {
      accountId: number;
      username: string;
    };
    classId?: string;
    csrfToken?: string;
    // end of moderation panel login (set by panel password)
    moderatorUntil?: number;
  }
}
declare module "express" {
  interface Request {
    file?: Express.Multer.File;
    allFiles?: Express.Multer.File[];
    apiVersion?: string;
  }
}