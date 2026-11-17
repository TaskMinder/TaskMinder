import { timingSafeEqual } from "crypto";
import { Session, SessionData } from "express-session";
import { prisma } from "../config/prisma.js";
import { envConfig } from "../config/env.js";
import { acquireLock, redisClient } from "../config/redis.js";
import { sendMail } from "../config/mail.js";
import logger from "../config/logger.js";
import { RequestError } from "../@types/requestError.js";
import { encryptionManager } from "../utils/encryption.manager.js";
import { removeHomework } from "./homework.service.js";
import { removeEvent } from "./event.service.js";
import { removeUpload } from "./upload.service.js";
import { removeLoggedOutSessions, rotateClassCode } from "./class.service.js";
import { ROLES } from "../middleware/access.middleware.js";
import { refreshReportedFlags } from "./report.service.js";
import { DecisionGround, ModerationAction, appealDeadline, reporterDecisionMail } from "../utils/moderation.statements.js";
import {
  getReportTypeParams,
  loginTypeBody,
  resolveReportTypeBody,
  resolveReportTypeParams,
  unbanAccountTypeParams
} from "../schemas/moderation.schema.js";

type Report = NonNullable<Awaited<ReturnType<typeof prisma.report.findUnique>>>;
type BanTarget = NonNullable<resolveReportTypeBody["banTarget"]>;
type AccountInfo = { username: string; bannedAt: bigint | null; onlyAdmin: boolean } | null;

// short, since the panel can remove content and ban accounts
const MODERATOR_SESSION_MS = 3 * 60 * 60 * 1000;
const OVERVIEW_RESOLVED_REPORTS = 20;
const REMOVABLE_TARGET_TYPES = ["homework", "event", "upload"];

function allowedActions(report: Report): ModerationAction[] {
  const canRemove = REMOVABLE_TARGET_TYPES.includes(report.targetType) && report.classId !== null;
  const canBan = report.targetAccountId !== null || report.editorAccountId !== null;
  const actions: ModerationAction[] = ["dismiss"];
  if (canRemove) actions.push("remove");
  if (canBan) actions.push("ban");
  if (canRemove && canBan) actions.push("remove_and_ban");
  // anonymous or unknown authors can only be locked out by rotating the class code
  if (!canBan && report.classId !== null) actions.push("rotate_class_code");
  return actions;
}

// the account a ban hits; the author unless the operator picked the last editor
function banAccountIdOf(report: Report, banTarget: BanTarget | undefined): number | null {
  return banTarget === "editor" ? report.editorAccountId : report.targetAccountId;
}

async function loadReport(reportId: number): Promise<Report> {
  const report = await prisma.report.findUnique({ where: { reportId } });
  if (!report) {
    const err: RequestError = {
      name: "Not Found",
      status: 404,
      message: "Diese Meldung existiert nicht oder wurde nach Ablauf der Aufbewahrungsfrist gelöscht",
      expected: true
    };
    throw err;
  }
  return report;
}

async function loadOpenReport(reportId: number): Promise<Report> {
  const report = await prisma.report.findUnique({ where: { reportId } });
  if (!report || report.resolvedAt !== null) {
    const err: RequestError = {
      name: "Gone",
      status: 410,
      message: "Diese Meldung ist bereits bearbeitet oder existiert nicht mehr",
      expected: true
    };
    throw err;
  }
  return report;
}

// reuses the regular delete logic; content already deleted by users is skipped
async function removeReportedContent(report: Report): Promise<void> {
  const classId = report.classId!;
  if (report.targetType === "homework") {
    const homework = await prisma.homework.findFirst({ where: { homeworkId: report.targetId, classId }, select: { accountId: true } });
    if (homework) await removeHomework(report.targetId, classId, homework.accountId);
  }
  else if (report.targetType === "event") {
    const event = await prisma.event.findFirst({ where: { eventId: report.targetId, classId }, select: { accountId: true } });
    if (event) await removeEvent(report.targetId, classId, event.accountId);
  }
  else {
    const upload = await prisma.upload.findFirst({ where: { uploadId: report.targetId, classId }, include: { Files: true } });
    if (upload) await removeUpload(upload);
  }
}

async function banAccount(accountId: number, ground: DecisionGround, reason: string): Promise<void> {
  await prisma.account.update({
    where: { accountId },
    data: { bannedAt: BigInt(Date.now()), banGround: ground, banReason: reason }
  });
  // the auth cache would otherwise delay the ban by up to 15min
  await redisClient.del(`auth_user:${accountId}`);
  logger.info(`account ${accountId} was banned`);
}

async function notifyReporters(
  reports: { reportId: number; reporterContact: string | null }[],
  action: ModerationAction,
  ground: DecisionGround | null,
  reason: string,
  decidedAt: number
): Promise<void> {
  for (const report of reports) {
    try {
      await sendMail({
        to: encryptionManager.decrypt(report.reporterContact!),
        ...reporterDecisionMail(report.reportId, action, ground, reason, decidedAt)
      });
    }
    catch (err) {
      logger.error(`Failed to notify reporter of report ${report.reportId}: ${err}`);
    }
  }
}

// every action but dismiss restricts something, so it needs a ground and a reason (DSA Art. 17); a ban needs its account
function assertDecisionAllowed(
  report: Report,
  action: ModerationAction,
  ground: DecisionGround | null,
  reason: string,
  banAccountId: number | null
): void {
  if (
    !allowedActions(report).includes(action)
    || (action !== "dismiss" && (!reason || ground === null))
    || (isBan(action) && banAccountId === null)
  ) {
    const err: RequestError = {
      name: "Bad Request",
      status: 400,
      message: "Maßnahme für diese Meldung nicht erlaubt, oder Sperrziel, Grund oder Begründung fehlt",
      expected: true
    };
    throw err;
  }
}

function isBan(action: ModerationAction): boolean {
  return action === "ban" || action === "remove_and_ban";
}

function removesContent(action: ModerationAction): boolean {
  return action === "remove" || action === "remove_and_ban";
}

// a banned user still knows the class code, so the ban forms offer rotating it as well
async function applyDecision(
  report: Report,
  action: ModerationAction,
  ground: DecisionGround | null,
  reason: string,
  banAccountId: number | null,
  alsoRotateClassCode: boolean
): Promise<void> {
  if (removesContent(action)) {
    await removeReportedContent(report);
  }
  if (isBan(action)) {
    await banAccount(banAccountId!, ground!, reason);
  }
  if (action === "rotate_class_code" || (isBan(action) && alsoRotateClassCode && report.classId !== null)) {
    await rotateClassCode(report.classId!);
    await removeLoggedOutSessions(report.classId!);
  }
}

// a banned admin cannot act, so a class whose only admin is banned cannot be managed any more
async function isOnlyActiveAdmin(accountId: number): Promise<boolean> {
  const membership = await prisma.joinedClass.findUnique({
    where: { accountId },
    select: { classId: true, permissionLevel: true }
  });
  if (membership?.permissionLevel !== ROLES.ADMIN) {
    return false;
  }
  const otherActiveAdmins = await prisma.joinedClass.count({
    where: {
      classId: membership.classId,
      permissionLevel: ROLES.ADMIN,
      accountId: { not: accountId },
      Account: { bannedAt: null }
    }
  });
  return otherActiveAdmins === 0;
}

async function findAccountInfo(accountId: number | null): Promise<AccountInfo> {
  if (accountId === null) {
    return null;
  }
  const account = await prisma.account.findUnique({ where: { accountId }, select: { username: true, bannedAt: true } });
  return account && { ...account, onlyAdmin: await isOnlyActiveAdmin(accountId) };
}

const moderationService = {
  async login(reqBody: loginTypeBody, session: Session & Partial<SessionData>) {
    const expected = envConfig.moderationPassword;
    // both sides are hashed, so the compare has a fixed length
    const isPasswordValid = expected !== null && timingSafeEqual(
      Buffer.from(encryptionManager.hash(reqBody.password), "utf8"),
      Buffer.from(encryptionManager.hash(expected), "utf8")
    );
    if (!isPasswordValid) {
      const err: RequestError = {
        name: "Unauthorized",
        status: 401,
        message: "Falsches Passwort",
        expected: true
      };
      throw err;
    }
    session.moderatorUntil = Date.now() + MODERATOR_SESSION_MS;
    return session.moderatorUntil;
  },

  async logout(session: Session & Partial<SessionData>) {
    delete session.moderatorUntil;
  },

  async getOverview() {
    const open = await prisma.report.findMany({
      where: { resolvedAt: null },
      select: { reportId: true, category: true, targetType: true, targetId: true, classId: true, description: true, createdAt: true },
      orderBy: { createdAt: "asc" }
    });
    const resolved = await prisma.report.findMany({
      where: { resolvedAt: { not: null } },
      select: { reportId: true, action: true, decisionGround: true, decisionReason: true, resolvedAt: true },
      orderBy: { resolvedAt: "desc" },
      take: OVERVIEW_RESOLVED_REPORTS
    });
    const banned = await prisma.account.findMany({
      where: { bannedAt: { not: null } },
      select: { accountId: true, username: true, banGround: true, banReason: true, bannedAt: true },
      orderBy: { bannedAt: "asc" }
    });
    return { open, resolved, banned };
  },

  // resolved reports stay readable until they are deleted, so appeals can be checked against them
  async getReport(reqParams: getReportTypeParams) {
    const { id: reportId } = reqParams;
    const report = await loadReport(reportId);
    const isOpen = report.resolvedAt === null;

    const author = await findAccountInfo(report.targetAccountId);
    const editor = await findAccountInfo(report.editorAccountId);
    const earlierOnTarget = await prisma.report.count({
      where: { targetType: report.targetType, targetId: report.targetId, reportId: { lt: reportId } }
    });
    const earlierOnAuthor = report.targetAccountId === null
      ? 0
      : await prisma.report.count({ where: { targetAccountId: report.targetAccountId, reportId: { lt: reportId } } });
    // a decision applies to every open report on the target, so the operator should know how many there are
    const otherOpenOnTarget = isOpen
      ? await prisma.report.count({
        where: { targetType: report.targetType, targetId: report.targetId, resolvedAt: null, reportId: { not: reportId } }
      })
      : 0;

    // the reporter's contact and session hash stay on the server
    const { reporterKey, reporterContact, ...rest } = report;
    return {
      report: {
        ...rest,
        reporterAccountId: reporterKey.startsWith("account:") ? Number(reporterKey.slice("account:".length)) : null,
        hasReporterContact: reporterContact !== null
      },
      author,
      editor,
      earlierOnTarget,
      earlierOnAuthor,
      otherOpenOnTarget,
      actions: isOpen ? allowedActions(report) : [],
      appealUntil: isOpen ? null : appealDeadline(Number(report.resolvedAt))
    };
  },

  async resolveReport(reqParams: resolveReportTypeParams, reqBody: resolveReportTypeBody) {
    const { id: reportId } = reqParams;
    const { action, reason, banTarget, rotateClassCode: alsoRotateClassCode } = reqBody;
    // a dismissal restricts nothing, so it has no ground
    const ground = action === "dismiss" ? null : reqBody.ground ?? null;
    const loaded = await loadOpenReport(reportId);

    const banAccountId = banAccountIdOf(loaded, banTarget);
    assertDecisionAllowed(loaded, action, ground, reason, banAccountId);

    // resolving a target twice in parallel (double click, two reports on it) would apply its decision twice;
    // the ttl is long enough for removing files and rotating a class code
    const lockKey = `moderation_lock:${loaded.targetType}:${loaded.targetId}`;
    if (!await acquireLock(lockKey, 60)) {
      const err: RequestError = {
        name: "Conflict",
        status: 409,
        message: "Diese Meldung wird gerade bearbeitet",
        expected: true
      };
      throw err;
    }
    try {
      // a request that held the lock before us may have resolved the report by now
      const report = await loadOpenReport(reportId);
      await applyDecision(report, action, ground, reason, banAccountId, alsoRotateClassCode === true);

      // other open reports on the same target are resolved the same way
      const sameTarget = { targetType: report.targetType, targetId: report.targetId, resolvedAt: null };
      const withContact = await prisma.report.findMany({
        where: { ...sameTarget, reporterContact: { not: null } },
        select: { reportId: true, reporterContact: true }
      });
      // everyone whose words are gone hears about it: the author and a different last editor
      const noticeRecipients = [report.targetAccountId, report.editorAccountId].filter(accountId => accountId !== null);
      const decidedAt = Date.now();
      await prisma.$transaction(async tx => {
        await tx.report.updateMany({
          where: sameTarget,
          data: { action, decisionGround: ground, decisionReason: reason || null, resolvedAt: BigInt(decidedAt), reporterContact: null }
        });
        if (removesContent(action) && noticeRecipients.length > 0) {
          await tx.moderationNotice.createMany({
            data: noticeRecipients.map(accountId => ({
              accountId,
              reportId: report.reportId,
              targetType: report.targetType,
              ground: ground!,
              reason,
              createdAt: BigInt(decidedAt)
            }))
          });
        }
      });
      // the "reported" flag of the target goes away for the whole class, whatever the decision was
      if (report.classId !== null) {
        await refreshReportedFlags(report.classId, [report.targetType]);
      }
      void notifyReporters(withContact, action, ground, reason, decidedAt);
    }
    finally {
      await redisClient.del(lockKey);
    }

    logger.info(`report ${reportId} resolved with action ${action}`);
  },

  async unbanAccount(reqParams: unbanAccountTypeParams) {
    const { id: accountId } = reqParams;
    const unbanned = await prisma.account.updateMany({
      where: { accountId, bannedAt: { not: null } },
      data: { bannedAt: null, banGround: null, banReason: null }
    });
    if (unbanned.count === 0) {
      const err: RequestError = {
        name: "Not Found",
        status: 404,
        message: "Gesperrtes Konto nicht gefunden",
        expected: true
      };
      throw err;
    }
    logger.info(`account ${accountId} was unbanned`);
  }
};

export default moderationService;
