import bcrypt from "bcrypt";
import { prisma } from "../config/prisma.js";
import { Session, SessionData } from "express-session";
import { RequestError } from "../@types/requestError.js";
import { CACHE_KEY_PREFIXES, redisClient } from "../config/redis.js";
import {
  changePasswordTypeBody,
  changeUsernameTypeBody,
  checkUsernameTypeQuery,
  deleteAccountTypeBody,
  loginAccountTypeBody,
  markNoticeSeenTypeParams,
  registerAccountTypeBody
} from "../schemas/account.schema.js";
import { invalidateCache } from "../config/redis.js";
import { assertNotBanned } from "../middleware/access.middleware.js";

const SALTROUNDS = 10;

export default {
  async getAuth(session: Session & Partial<SessionData>) {
    type AuthResponse = {
      loggedIn: boolean;
      classJoined: boolean;
      classId?: number;
      account?: {
        accountId: number;
        username: string;
      };
      permissionLevel?: number;
    };

    if (!session) {
      return { loggedIn: false, classJoined: false };
    }

    const res: AuthResponse = {
      loggedIn: false,
      classJoined: false
    };

    let accountIdInDatabase: number | undefined;

    if (session.account) {
      const accountInDb = await prisma.account.findFirst({
        where: { accountId: session.account.accountId, deletedAt: null },
        select: { accountId: true, username: true, bannedAt: true, banReason: true }
      });

      if (accountInDb) {
        assertNotBanned(accountInDb, session);
        res.loggedIn = true;
        accountIdInDatabase = accountInDb.accountId;
        res.account = { username: accountInDb.username, accountId: accountIdInDatabase };
        session.account = { accountId: accountInDb.accountId, username: accountInDb.username };
      }
      else {
        delete session.account;
      }
    }

    if (res.loggedIn && accountIdInDatabase) {
      const joinedClass = await prisma.joinedClass.findUnique({
        where: { accountId: accountIdInDatabase },
        select: { permissionLevel: true, classId: true }
      });

      if (joinedClass) {
        res.classJoined = true;
        res.permissionLevel = joinedClass.permissionLevel;
        res.classId = joinedClass.classId;
        session.classId = joinedClass.classId.toString();
      }
      else {
        delete session.classId;
        res.classJoined = false;
      }
    }

    else if (!res.loggedIn && session.classId) {
      const classId = parseInt(session.classId, 10);
      const classInDb = await prisma.class.findUnique({
        where: { classId},
        select: { defaultPermissionLevel: true, classId: true }
      });

      if (classInDb) {
        res.classJoined = true;
        res.classId = classInDb.classId;
        res.permissionLevel = classInDb.defaultPermissionLevel;
      }
      else {
        delete session.classId;
        res.classJoined = false;
      }
    }

    return res;
  },
  async registerAccount(reqBody: registerAccountTypeBody, session: Session & Partial<SessionData>) {
    const { username, password } = reqBody;
    // always use classId instead of session.classId
    // since session.classId can change during concurrent requests
    const classId = parseInt(session.classId!, 10);
    if (session.account) {
      const err: RequestError = {
        name: "Bad Request",
        status: 400,
        message: "Already logged in",
        expected: true
      };
      throw err;
    }

    const accountExists = await prisma.account.findFirst({
      where: { username: username, deletedAt: null }
    });
    if (accountExists) {
      const err: RequestError = {
        name: "Bad Request",
        status: 400,
        message: "The requested username is already registered!",
        expected: true
      };
      throw err;
    }

    const hashedPassword = await bcrypt.hash(password, SALTROUNDS);
    const account = await prisma.$transaction(async tx => {
      const newAccount = await tx.account.create({
        data: {
          username,
          password: hashedPassword,
          createdAt: BigInt(Date.now())
        }
      });

      if (classId) {
        // check if class exists -> delete classId from session
        const classExists = await tx.class.findUnique({
          where: { classId }
        });
        if (!classExists) {
          delete session.classId;
          return newAccount;
        }
        await tx.joinedClass.create({
          data: {
            accountId: newAccount.accountId,
            classId,
            permissionLevel: classExists.defaultPermissionLevel,
            createdAt: BigInt(Date.now())
          }
        });
      }

      return newAccount;
    });

    session.account = {
      username,
      accountId: account.accountId
    };
  },

  async logoutAccount(session: Session & Partial<SessionData>) {
    delete session.account;
  },

  async loginAccount(reqBody: loginAccountTypeBody, session: Session & Partial<SessionData>) {
    const { username, password } = reqBody;
    // always use classId instead of session.classId
    // since session.classId can change during concurrent requests
    const classId = parseInt(session.classId!, 10);
    if (session.account) {
      const err: RequestError = {
        name: "Bad Request",
        status: 400,
        message: "Already logged in",
        expected: true
      };
      throw err;
    }
    const account = await prisma.account.findFirst({
      where: {
        username: username,
        deletedAt: null
      }
    });
    if (!account) {
      const err: RequestError = {
        name: "Unauthorized",
        status: 401,
        message: "Invalid credentials",
        expected: true
      };
      throw err;
    }
    const isPasswordValid = await bcrypt.compare(password, account.password);
    if (!isPasswordValid) {
      const err: RequestError = {
        name: "Unauthorized",
        status: 401,
        message: "Invalid credentials",
        expected: true
      };
      throw err;
    }
    assertNotBanned(account, session);
    const accountId = account.accountId;
    session.account = { username, accountId };

    const joinedClassExists = await prisma.joinedClass.findUnique({
      where: {
        accountId: accountId
      }
    });
    if (joinedClassExists === null && classId) {
      // find if class exists
      const classInfo = await prisma.class.findUnique({
        where: { classId},
        select: { defaultPermissionLevel: true }
      });

      if (!classInfo) {
        delete session.classId;
        return;
      }

      // create joinedClass entry if class exists
      await prisma.joinedClass.create({
        data: {
          accountId: accountId,
          classId,
          permissionLevel: classInfo.defaultPermissionLevel,
          createdAt: BigInt(Date.now())
        }
      });
    }
    else if (joinedClassExists !== null) {
      session.classId = joinedClassExists.classId.toString();
    }
  },

  async deleteAccount(
    reqBody: deleteAccountTypeBody,
    session: Session & Partial<SessionData>
  ) {
    const { password } = reqBody;
    const accountId = session.account!.accountId;

    // account is certainly not soft-deleted and if found (accessMiddleware)
    // no deletedAt query needed
    const account = await prisma.account.findUnique({
      where: {
        accountId
      }
    });

    if (!account){
      delete session.account;
      const err: RequestError = {
        name: "Unauthorized",
        status: 401,
        message: "Account session invalid",
        expected: true
      };
      throw err;
    }
    // account and session.account certainly exist here 
    // -> checkAccess.checkAccount middleware
    const joinedClassAccount = await prisma.joinedClass.findUnique({
      where: {
        accountId
      }
    });
    // if user is in a class, evaluate if user is admin
    if (joinedClassAccount) {
      if (joinedClassAccount.permissionLevel === 3) {
        const err: RequestError = {
          name: "Conflict",
          status: 409,
          message: "The account is still an admin in a class, leave the class first",
          expected: true
        };
        throw err;
      }
    }
    const isPasswordValid = await bcrypt.compare(password, account.password);
    if (!isPasswordValid) {
      const err: RequestError = {
        name: "Unauthorized",
        status: 401,
        message: "Invalid credentials",
        expected: true
      };
      throw err;
    }
    await prisma.$transaction(async tx => {
      // mark account as deleted
      await tx.account.update({
        where: {
          accountId: account.accountId
        },
        data: {
          deletedAt: BigInt(Date.now())
        }
      });
      // delete related records in JoinedClass, JoinedTeams, and HomeworkCheck
      await tx.joinedClass.deleteMany({
        where: {
          accountId: account.accountId
        }
      });
      await tx.joinedTeams.deleteMany({
        where: {
          accountId: account.accountId
        }
      });
      await tx.homeworkCheck.deleteMany({
        where: {
          accountId: account.accountId
        }
      });
      // set relevant accountId in uploads to null
      await tx.upload.updateMany({
        where: {
          accountId: account.accountId
        },
        data: {
          accountId: null
        }
      });
    });
    if (joinedClassAccount){
      await invalidateCache(CACHE_KEY_PREFIXES.UPLOADMETADATA, joinedClassAccount.classId.toString());
    }
    await redisClient.del(`auth_user:${account.accountId}`);
    delete session.account;
  },

  async changeUsername(reqBody: changeUsernameTypeBody, session: Session & Partial<SessionData>) {
    const { password, newUsername } = reqBody;
    // soft delete needed, so prisma can find usernames which are not deleted
    // deletedAt needed
    const accountWithNewUsername = await prisma.account.findFirst({
      where: {
        username: newUsername,
        deletedAt: null
      }
    });

    if (accountWithNewUsername) {
      const err: RequestError = {
        name: "Conflict",
        status: 409,
        message: "Username already exists, please choose another username.",
        expected: true
      };
      throw err;
    }
    // account is certainly not soft-deleted and if found (accessMiddleware)
    // no deletedAt query needed
    const account = await prisma.account.findUnique({
      where: {
        accountId: session.account!.accountId
      }
    });

    const isPasswordValid = await bcrypt.compare(password, account!.password);
    if (!isPasswordValid) {
      const err: RequestError = {
        name: "Unauthorized",
        status: 401,
        message: "Invalid credentials",
        expected: true
      };
      throw err;
    }
    // account is certainly not soft-deleted and if found (accessMiddleware)
    // no deletedAt query needed
    await prisma.account.update({
      where: {
        accountId: session.account!.accountId
      },
      data: {
        username: newUsername
      }
    });

    // update upload metadata cache too, as names have to be refetched if user in a class
    const joinedClassAccount = await prisma.joinedClass.findUnique({
      where: {
        accountId: session.account!.accountId
      }
    });
    if (joinedClassAccount){
      await invalidateCache(CACHE_KEY_PREFIXES.UPLOADMETADATA, joinedClassAccount.classId.toString());
    }

    session.account = { username: newUsername, accountId: session.account!.accountId };
  },

  async changePassword(
    reqBody: changePasswordTypeBody,
    session: Session & Partial<SessionData>
  ) {
    const { oldPassword, newPassword } = reqBody;
    // account is certainly not soft-deleted and if found (accessMiddleware)
    // no deletedAt query needed
    const changePasswordAccount = await prisma.account.findUnique({
      where: {
        accountId: session.account!.accountId
      }
    });

    // check if newPassword contains username
    if (newPassword.toLowerCase().includes(changePasswordAccount!.username.toLowerCase())) {
      const err: RequestError = {
        name: "Bad Request",
        status: 400,
        message: "Password cannot contain username",
        expected: true
      };
      throw err;
    }

    const isPasswordValid = await bcrypt.compare(oldPassword, changePasswordAccount!.password);
    if (!isPasswordValid) {
      const err: RequestError = {
        name: "Unauthorized",
        status: 401,
        message: "Invalid credentials",
        expected: true
      };
      throw err;
    }
    const hashedPassword = await bcrypt.hash(newPassword, SALTROUNDS);
    // account is certainly not soft-deleted and if found (accessMiddleware)
    // no deletedAt query needed
    await prisma.account.update({
      where: {
        accountId: session.account!.accountId
      },
      data: {
        password: hashedPassword
      }
    });
  },

  async checkUsername(reqQuery: checkUsernameTypeQuery) {
    const { username } = reqQuery;
    const accountExists = await prisma.account.findFirst({
      where: { username: username, deletedAt: null }
    });
    return accountExists !== null;
  },

  async getNotices(session: Session & Partial<SessionData>) {
    return await prisma.moderationNotice.findMany({
      where: { accountId: session.account!.accountId, seenAt: null },
      select: { noticeId: true, action: true, targetType: true, reason: true, createdAt: true },
      orderBy: { createdAt: "desc" }
    });
  },

  async markNoticeSeen(reqParams: markNoticeSeenTypeParams, session: Session & Partial<SessionData>) {
    const { id: noticeId } = reqParams;
    const updated = await prisma.moderationNotice.updateMany({
      where: { noticeId, accountId: session.account!.accountId, seenAt: null },
      data: { seenAt: BigInt(Date.now()) }
    });
    if (updated.count === 0) {
      const err: RequestError = {
        name: "Not Found",
        status: 404,
        message: "Notice not found",
        expected: true
      };
      throw err;
    }
  }
};
