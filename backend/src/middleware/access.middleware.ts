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

  // not cached: deletion and bans apply at once
  const account = await prisma.account.findUnique({
    where: { accountId: req.session.account.accountId },
    select: { deletedAt: true, bannedAt: true, banGround: true, banReason: true }
  });

  // account was deleted, invalid session
  if (!account || account.deletedAt !== null) {
    delete req.session.account;
    throwError(
      "Unauthorized",
      401,
      "Account not found. You have been logged out"
    );
  }
  // logout and account deletion stay open to banned account
  if (allowBanned && account.bannedAt !== null) {
    delete req.session.classId;
    return;
  }
  assertNotBanned(account, req.session);
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

// Session-based permission check, extracted so services can reuse the exact same
// logic (e.g. to gate shared vs. personal homework/events without a route-level role).
// Resolves the effective permission from the account's class membership, or the class
// default for anonymous users, repairs/clears stale session state, and throws when
// the level is insufficient.
export async function assertPermissionLevel(
  session: Session & Partial<SessionData>,
  requiredPermission: number
): Promise<void> {
  let effectivePermission = 0;

  if (session.account) {
    const joined = await prisma.joinedClass.findUnique({
      where: { accountId: session.account.accountId },
      select: { permissionLevel: true, classId: true }
    });

    if (!joined) {
      // a ban removes the account from its class: 403 with statement of reasons, login stays
      await assertSessionAccountNotBanned(session);
      // session is stale or tampered
      delete session.account;
      delete session.classId;
      throwError("Unauthorized", 401, "Account is not linked to any class");
    }

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

// banned account keeps login but no class, so it cannot stay on as anonymous member after logout
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

// for /join and accounts without class
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
