import { Request, Response, NextFunction } from "express";
import { Session, SessionData } from "express-session";
import { prisma } from "../config/prisma.js";
import { redisClient } from "../config/redis.js";
import { banStatement } from "../utils/moderation.statements.js";
import { throwError } from "../utils/common.functions.js";
import type { DecisionGround } from "../prisma/generated/prisma/enums.js";

export const ROLES = {
  MEMBER: 0,
  EDITOR: 1,
  MANAGER: 2,
  ADMIN: 3
} as const;

// account checks are cached this long; a ban marks the key for as long
export const AUTH_USER_TTL_SECONDS = 15 * 60;

type AccessRequirement = "ACCOUNT" | "CLASS" | "MODERATOR" | keyof typeof ROLES;
type BanFields = { bannedAt: bigint | null; banGround: DecisionGround | null; banReason: string | null };

export default function checkAccess(requirements: AccessRequirement[], { allowBanned = false } = {}) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (requirements.includes("ACCOUNT")) {
        await checkAccountAccess(req, allowBanned);
      }

      if (requirements.includes("CLASS")) {
        await checkClassAccess(req, res);
        if (res.headersSent) {
          return;
        }
      }

      if (requirements.includes("MODERATOR")) {
        checkModeratorAccess(req);
      }

      const roleLevels = requirements.filter(
        r => r in ROLES
      ) as (keyof typeof ROLES)[];
      if (roleLevels.length > 0) {
        const requiredPermission = Math.max(...roleLevels.map(r => ROLES[r]));
        await checkPermissionLevel(req, requiredPermission);
      }

      return next();
    } 
    catch (err) {
      return next(err);
    }
  };
}

async function checkAccountAccess(req: Request, allowBanned: boolean): Promise<void> {
  if (!req.session.account) {
    throwError("Unauthorized", 401, "User not logged in");
  }

  const authUserRedis = await redisClient.get(`auth_user:${req.session.account.accountId}`);

  // only "true" passes; a ban writes "banned" so that requests in flight cannot cache the account as allowed
  if (authUserRedis !== "true") {
    const account = await prisma.account.findUnique({
      where: { accountId: req.session.account.accountId }
    });

    if (!account) {
      delete req.session.account;
      throwError(
        "Unauthorized",
        401,
        "Account not found. You have been logged out"
      );
    }
    // account was deleted, invalid session
    if (account.deletedAt !== null) {
      delete req.session.account;
      throwError(
        "Unauthorized",
        401,
        "Account not found. You have been logged out"
      );
    }
    if (allowBanned && account.bannedAt !== null) {
      // banned account passes without its class and is not cached ("true" in auth cache means not banned)
      delete req.session.classId;
      return;
    }
    assertNotBanned(account, req.session);
    // NX: never overwrites the "banned" marker of a ban that committed after the read above
    await redisClient.set(`auth_user:${req.session.account.accountId}`, "true", {
      expiration: { type: "EX", value: AUTH_USER_TTL_SECONDS },
      condition: "NX"
    });
  }
}

// the panel shows its login form on 401
function checkModeratorAccess(req: Request): void {
  if (!req.session.moderatorUntil || req.session.moderatorUntil < Date.now()) {
    delete req.session.moderatorUntil;
    throwError("Unauthorized", 401, "Nicht angemeldet oder Anmeldung abgelaufen");
  }
}

async function checkClassAccess(req: Request, res: Response): Promise<void> {
  if (!req.session.classId) {
    const legacyOrigin = Object.hasOwn(req.query, "legacy_origin") ? "?legacy_origin" : "";
    return res.redirect(302, `/join${legacyOrigin}`);
  }

  // Verify class exists
  const authClassRedis = await redisClient.get(`auth_class:${req.session.classId}`);
  if (!authClassRedis) {
    const aClass = await prisma.class.findUnique({
      where: { classId: parseInt(req.session.classId, 10) }
    });

    if (!aClass) {
      delete req.session.classId;
      throwError(
        "Not Found",
        404,
        "The selected class no longer exists. Please select another class"
      );
    }
    await redisClient.set(`auth_class:${req.session.classId}`, "true", {
      expiration: {type: "EX", value: 15 * 60} // 15min
    });
  }

  // If user is logged in, verify active membership
  if (req.session.account) {
    try {
      await assertPermissionLevel(req.session, ROLES.MEMBER);
    }
    catch (err) {
      // Membership check failed — session is stale or kicked
      delete req.session.classId;
      throw err;
    }
  }
}

async function checkPermissionLevel(
  req: Request,
  requiredPermission: number
): Promise<void> {
  await assertPermissionLevel(req.session, requiredPermission);
}

// Session-based permission check
// resolves effective permission from account's class membership, or class
// default for anonymous users, repairs/clears stale session state, and throws when
// level is insufficient.
export async function assertPermissionLevel(
  session: Session & Partial<SessionData>,
  requiredPermission: number
): Promise<void> {
  let effectivePermission = 0;

  if (session.account) {
    const joined = await prisma.joinedClass.findUnique({
      where: { accountId: session.account.accountId },
      select: { permissionLevel: true, classId: true, Account: { select: { bannedAt: true, banGround: true, banReason: true } } }
    });

    if (!joined) {
      // session is stale or tampered
      delete session.account;
      delete session.classId;
      throwError("Unauthorized", 401, "Account is not linked to any class");
    }
    // there is no account -> session index, so bans are enforced here at check time
    assertNotBanned(joined.Account, session);

    if (session.classId) {
      const sessionClassId = parseInt(session.classId, 10);
      if (sessionClassId !== joined.classId) {
        // prevent cross-class access via forged/stale session.classId
        delete session.classId;
        throwError("Forbidden", 403, "Selected class does not match account membership");
      }
    }
    else {
      // keep session consistent
      session.classId = joined.classId.toString();
    }
    effectivePermission = joined.permissionLevel;
  }
  else if (session.classId) {
    const aClass = await prisma.class.findUnique({
      where: { classId: parseInt(session.classId, 10) },
      select: { defaultPermissionLevel: true }
    });
    effectivePermission = aClass?.defaultPermissionLevel ?? 0;
  }

  if (effectivePermission < requiredPermission) {
    throwError(
      "Forbidden",
      403,
      "The permission level is not sufficient to perform this action"
    );
  }
}

// banned account keeps login but loses class, so it cannot stay on as anonymous member after logout
export function assertNotBanned(account: BanFields, session: Session & Partial<SessionData>): void {
  if (account.bannedAt === null) {
    return;
  }
  delete session.classId;
  throwError(
    "Forbidden",
    403,
    banStatement({ bannedAt: Number(account.bannedAt), banGround: account.banGround, banReason: account.banReason })
  );
}

// for routes without access gate (/join): banned account must not get membership
export async function assertSessionAccountNotBanned(session: Session & Partial<SessionData>): Promise<void> {
  if (!session.account) {
    return;
  }
  const account = await prisma.account.findUnique({
    where: { accountId: session.account.accountId },
    select: { bannedAt: true, banGround: true, banReason: true }
  });
  if (account) {
    assertNotBanned(account, session);
  }
}
