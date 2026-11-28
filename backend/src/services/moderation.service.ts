import { timingSafeEqual } from "crypto";
import { isDeepStrictEqual } from "node:util";
import { Request } from "express";
import { Db, prisma } from "../config/prisma.js";
import { envConfig } from "../config/env.js";
import { CACHE_KEY_PREFIXES, invalidateCache } from "../config/redis.js";
import logger from "../config/logger.js";
import { disconnectAccountSockets, emitSocketToClass, SOCKET_EVENTS } from "../config/socket.js";
import { destroySession, MODERATOR_SESSION_MS, regenerateSession } from "../config/session.js";
import { encryptionManager } from "../utils/encryption.manager.js";
import { throwError } from "../utils/common.functions.js";
import { processMailQueue, queueMails } from "../utils/mail.queue.js";
import { ensureCsrfSessionToken } from "../middleware/csrfProtection.middleware.js";
import { announceHomeworkRemoval } from "./homework.service.js";
import { announceEventRemoval } from "./event.service.js";
import { announceUploadRemoval, deleteUploadRecord, openUploadFile } from "./upload.service.js";
import { announceClassCodeChange, removeLoggedOutSessions, removeMemberData, rotateClassCode } from "./class.service.js";
import { loadReportTarget } from "./report.service.js";
import { ROLES } from "../middleware/access.middleware.js";
import { reporterDecisionMail } from "../utils/moderation.statements.js";
import { DecisionGround, ModerationAction, ReportTargetType } from "../prisma/generated/prisma/enums.js";
import { Prisma } from "../prisma/generated/prisma/client.js";
import {
  BanDecision,
  getReportFileTypeParams,
  getReportTypeParams,
  loginTypeBody,
  resolveReportTypeBody,
  resolveReportTypeParams,
  unbanAccountTypeParams
} from "../schemas/moderation.schema.js";

type Report = NonNullable<Awaited<ReturnType<typeof prisma.report.findUnique>>>;
type AccountInfo = {
  accountId: number;
  username: string;
  // deleted account cannot be banned
  deleted: boolean;
  bannedAt: bigint | null;
} | null;
// panel password is shared, so decisions are logged with the panel login they came from
export type Moderator = { ip: string | undefined; sessionId: string };
// runs after commit: caches and sockets
type AnnounceRemoval = () => Promise<void>;
// class the banned account was removed from; promotedAccountId: new admin, null when none was needed or possible
type ClassRemoval = { classId: number; promotedAccountId: number | null };
type AppliedDecision = {
  // null when nothing was removed (also when content was already gone)
  announceRemoval: AnnounceRemoval | null;
  classRemoval: ClassRemoval | null;
};
type ClaimedReport = { reportId: number; reporterContact: string | null };
type QueuedMail = Parameters<typeof queueMails>[1][number];

const OVERVIEW_RESOLVED_REPORTS = 20;
const REMOVABLE_TARGET_TYPES: ReportTargetType[] = ["homework", "event", "upload"];

// bannable: author and last editor that are neither deleted nor banned yet
function allowedActions(report: Report, bannable: number[]): ModerationAction[] {
  const canRemove = REMOVABLE_TARGET_TYPES.includes(report.targetType) && report.classId !== null;
  const canBan = bannable.length > 0;
  const actions: ModerationAction[] = ["dismiss"];
  if (canRemove) actions.push("remove");
  if (canBan) actions.push("ban");
  if (canRemove && canBan) actions.push("remove_and_ban");
  // locks out anonymous authors and editors
  if (report.classId !== null) actions.push("rotate_class_code");
  return actions;
}

function isBannable(account: AccountInfo): account is NonNullable<AccountInfo> {
  return account !== null && !account.deleted && account.bannedAt === null;
}

function bannableAccountIds(author: AccountInfo, editor: AccountInfo): number[] {
  return [...new Set([author, editor].filter(isBannable).map(account => account.accountId))];
}

function banAccountIdOf(report: Report, banTarget: BanDecision["banTarget"]): number | null {
  return banTarget === "editor" ? report.editorAccountId : report.targetAccountId;
}

function isBanDecision(decision: resolveReportTypeBody): decision is BanDecision {
  return decision.action === "ban" || decision.action === "remove_and_ban";
}

function removesContent(action: ModerationAction): boolean {
  return action === "remove" || action === "remove_and_ban";
}

function describeModerator(moderator: Moderator): string {
  return `by moderator ip ${moderator.ip ?? "unknown"}, session ${encryptionManager.hash(moderator.sessionId).slice(0, 12)}`;
}

// open: 410 when already decided
async function loadReport(reportId: number, { open = false } = {}): Promise<Report> {
  const report = await prisma.report.findUnique({ where: { reportId } });
  if (open && (!report || report.resolvedAt !== null)) {
    throwError("Gone", 410, "Diese Meldung ist bereits bearbeitet oder existiert nicht mehr");
  }
  if (!report) {
    throwError("Not Found", 404, "Diese Meldung existiert nicht oder wurde nach Ablauf der Aufbewahrungsfrist gelöscht");
  }
  return report;
}

// open reports one decision resolves: same target in same class
function sameTargetFilter(report: Report): Prisma.ReportWhereInput {
  return { targetType: report.targetType, targetId: report.targetId, classId: report.classId };
}

// resolving is the claim: a parallel decision waits for the rows, then finds them resolved;
// reporter key is only needed for dedupe of open reports, so it leaves with the claim
async function claimReports(
  tx: Db,
  where: Prisma.ReportWhereInput,
  data: Prisma.ReportUpdateManyMutationInput
): Promise<ClaimedReport[]> {
  return await tx.report.updateManyAndReturn({
    where: { ...where, resolvedAt: null },
    data: { ...data, reporterKey: null },
    select: { reportId: true, reporterContact: true }
  });
}

// null when content is already gone; the delete count is the existence check (a read locks nothing)
async function deleteReportedContent(tx: Db, report: Report): Promise<AnnounceRemoval | null> {
  const classId = report.classId!;
  if (report.targetType === "homework") {
    const where = { homeworkId: report.targetId, classId };
    const homework = await tx.homework.findFirst({ where, select: { accountId: true } });
    const { count } = await tx.homework.deleteMany({ where });
    return homework && count > 0 ? () => announceHomeworkRemoval(classId, homework.accountId) : null;
  }
  if (report.targetType === "event") {
    const where = { eventId: report.targetId, classId };
    const event = await tx.event.findFirst({ where, select: { accountId: true } });
    const { count } = await tx.event.deleteMany({ where });
    return event && count > 0 ? () => announceEventRemoval(classId, event.accountId) : null;
  }
  if (report.targetType !== "upload") {
    return null;
  }
  const upload = await tx.upload.findFirst({
    where: { uploadId: report.targetId, classId },
    select: { uploadId: true, classId: true, status: true, reservedBytes: true, Files: true }
  });
  if (!upload || !await deleteUploadRecord(tx, upload)) {
    return null;
  }
  return () => announceUploadRemoval(upload);
}

// class without admin gets its longest member as admin; null when no one was promoted
async function promoteAdminIfMissing(tx: Db, classId: number): Promise<number | null> {
  const admin = await tx.joinedClass.findFirst({ where: { classId, permissionLevel: ROLES.ADMIN }, select: { accountId: true } });
  if (admin !== null) {
    return null;
  }
  const longestMember = await tx.joinedClass.findFirst({ where: { classId }, orderBy: { joinedClassId: "asc" }, select: { accountId: true } });
  if (longestMember === null) {
    return null;
  }
  await tx.joinedClass.update({ where: { accountId: longestMember.accountId }, data: { permissionLevel: ROLES.ADMIN } });
  return longestMember.accountId;
}

// first ban stays (409 for a second); banned account leaves its class, an unban does not restore it
async function banAccount(tx: Db, accountId: number, ground: DecisionGround, reason: string, bannedAt: number): Promise<ClassRemoval | null> {
  const banned = await tx.account.updateMany({
    where: { accountId, bannedAt: null },
    data: { bannedAt: BigInt(bannedAt), banGround: ground, banReason: reason }
  });
  if (banned.count === 0) {
    throwError("Conflict", 409, "Dieses Konto ist bereits gesperrt");
  }
  const membership = await tx.joinedClass.findUnique({ where: { accountId }, select: { classId: true } });
  if (membership === null) {
    return null;
  }
  const { classId } = membership;
  await tx.joinedClass.delete({ where: { accountId } });
  await removeMemberData(tx, accountId, classId);
  return { classId, promotedAccountId: await promoteAdminIfMissing(tx, classId) };
}

async function findAccountInfo(accountId: number | null): Promise<AccountInfo> {
  if (accountId === null) {
    return null;
  }
  const account = await prisma.account.findUnique({ where: { accountId }, select: { username: true, bannedAt: true, deletedAt: true } });
  if (!account) {
    return null;
  }
  const { deletedAt, ...rest } = account;
  return { accountId, ...rest, deleted: deletedAt !== null };
}

// author and last editor; one lookup when author edited last
async function findReportAccounts(report: Report): Promise<[AccountInfo, AccountInfo]> {
  const author = findAccountInfo(report.targetAccountId);
  const editor = report.editorAccountId === report.targetAccountId ? author : findAccountInfo(report.editorAccountId);
  return await Promise.all([author, editor]);
}

async function assertDecisionAllowed(report: Report, decision: resolveReportTypeBody): Promise<void> {
  const bannable = bannableAccountIds(...await findReportAccounts(report));
  if (!allowedActions(report, bannable).includes(decision.action)) {
    throwError("Bad Request", 400, "Maßnahme für diese Meldung nicht erlaubt");
  }
  if (isBanDecision(decision)) {
    const banAccountId = banAccountIdOf(report, decision.banTarget);
    if (banAccountId === null || !bannable.includes(banAccountId)) {
      throwError("Bad Request", 400, "Dieses Konto kann nicht gesperrt werden: Es fehlt oder ist bereits gesperrt");
    }
  }
}

function rotatesClassCode(report: Report, decision: resolveReportTypeBody): boolean {
  const rotate = decision.action === "rotate_class_code" || ("rotateClassCode" in decision && decision.rotateClassCode === true);
  return rotate && report.classId !== null;
}

// one transaction: a refused or failed step applies nothing, so the decision can be made again
async function applyDecision(tx: Db, report: Report, decision: resolveReportTypeBody, decidedAt: number): Promise<AppliedDecision> {
  const ground = decision.action === "dismiss" ? null : decision.ground;
  const resolution = { decisionGround: ground, decisionReason: decision.reason || null, resolvedAt: BigInt(decidedAt) };
  // first, so a second decision on this report (double click) waits here and then changes nothing
  const claimed = await claimReports(tx, sameTargetFilter(report), { ...resolution, action: decision.action });
  if (!claimed.some(claimedReport => claimedReport.reportId === report.reportId)) {
    throwError("Gone", 410, "Diese Meldung ist bereits bearbeitet oder existiert nicht mehr");
  }

  let classRemoval: ClassRemoval | null = null;
  // a ban holds everywhere: open reports on the account from every class are resolved with it
  let accountReports: ClaimedReport[] = [];
  if (isBanDecision(decision)) {
    const bannedAccountId = banAccountIdOf(report, decision.banTarget)!;
    classRemoval = await banAccount(tx, bannedAccountId, decision.ground, decision.reason, decidedAt);
    accountReports = await claimReports(tx, { targetType: "account", targetId: bannedAccountId }, { ...resolution, action: "ban" });
  }
  const announceRemoval = removesContent(decision.action) ? await deleteReportedContent(tx, report) : null;
  if (rotatesClassCode(report, decision)) {
    await rotateClassCode(report.classId!, tx);
  }

  // DSA Art. 16(5): mails are queued with the decision; contact leaves the report, the queue keeps it until sent
  await tx.report.updateMany({
    where: { reportId: { in: [...claimed, ...accountReports].map(claimedReport => claimedReport.reportId) } },
    data: { reporterContact: null }
  });
  const mailsFor = (reports: ClaimedReport[], action: ModerationAction, contentAlreadyDeleted: boolean): QueuedMail[] =>
    reports.flatMap(({ reportId, reporterContact }) => reporterContact === null ? [] : [{
      recipient: reporterContact,
      ...reporterDecisionMail(reportId, action, ground, decision.reason, contentAlreadyDeleted)
    }]);
  await queueMails(tx, [
    ...mailsFor(claimed, decision.action, removesContent(decision.action) && announceRemoval === null),
    ...mailsFor(accountReports, "ban", false)
  ]);
  return { announceRemoval, classRemoval };
}

// after commit: failed steps are only logged and do not skip the others
async function announceDecision(report: Report, decision: resolveReportTypeBody, applied: AppliedDecision): Promise<void> {
  void processMailQueue();
  const steps: (() => unknown)[] = [];
  if (applied.announceRemoval !== null) {
    steps.push(applied.announceRemoval);
  }
  if (isBanDecision(decision)) {
    const accountId = banAccountIdOf(report, decision.banTarget)!;
    steps.push(() => disconnectAccountSockets(accountId));
    logger.info(`account ${accountId} was banned`);
  }
  const { classRemoval } = applied;
  if (classRemoval !== null) {
    const { classId, promotedAccountId } = classRemoval;
    // removed uploader shows up in upload metadata
    steps.push(() => invalidateCache(CACHE_KEY_PREFIXES.UPLOADMETADATA, classId.toString()));
    steps.push(() => emitSocketToClass(classId, SOCKET_EVENTS.MEMBERS));
    steps.push(() => emitSocketToClass(classId, SOCKET_EVENTS.UPLOADS));
    const promoted = promotedAccountId === null ? "" : `, account ${promotedAccountId} was made admin`;
    logger.info(`banned account was removed from class ${classId}${promoted}`);
  }
  if (rotatesClassCode(report, decision)) {
    const classId = report.classId!;
    steps.push(() => announceClassCodeChange(classId));
    steps.push(() => removeLoggedOutSessions(classId));
  }
  // async wrapper turns synchronous throws into rejections
  const results = await Promise.allSettled(steps.map(async step => await step()));
  for (const result of results) {
    if (result.status === "rejected") {
      logger.error(`Report ${report.reportId} was resolved, but announcing the decision failed: ${result.reason}`);
    }
  }
}

const moderationService = {
  async login(reqBody: loginTypeBody, req: Request) {
    const expected = envConfig.moderationPassword;
    // hashed, so both sides have the same length
    const isPasswordValid = expected !== null && timingSafeEqual(
      Buffer.from(encryptionManager.hash(reqBody.password), "utf8"),
      Buffer.from(encryptionManager.hash(expected), "utf8")
    );
    if (!isPasswordValid) {
      throwError("Unauthorized", 401, "Falsches Passwort");
    }
    // new session id and CSRF token on login
    await regenerateSession(req);
    req.session.moderatorUntil = Date.now() + MODERATOR_SESSION_MS;
    logger.info(`moderation login ${describeModerator({ ip: req.ip, sessionId: req.sessionID })}`);
    return { loginUntil: req.session.moderatorUntil, csrfToken: ensureCsrfSessionToken(req) };
  },

  async logout(req: Request) {
    await destroySession(req);
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
    // deleted accounts are purged with their ban
    const banned = await prisma.account.findMany({
      where: { bannedAt: { not: null }, deletedAt: null },
      select: { accountId: true, username: true, banGround: true, banReason: true, bannedAt: true },
      orderBy: { bannedAt: "asc" }
    });
    return { open, resolved, banned };
  },

  // resolved reports stay readable until deleted, for appeals
  async getReport(reqParams: getReportTypeParams) {
    const { id: reportId } = reqParams;
    const report = await loadReport(reportId);
    const isOpen = report.resolvedAt === null;
    const sameTarget = { targetType: report.targetType, targetId: report.targetId };

    const [[author, editor], earlierOnTarget, earlierOnAuthor, otherOpenOnTarget, current] = await Promise.all([
      findReportAccounts(report),
      prisma.report.count({ where: { ...sameTarget, reportId: { lt: reportId } } }),
      report.targetAccountId === null
        ? 0
        : prisma.report.count({ where: { targetAccountId: report.targetAccountId, reportId: { lt: reportId } } }),
      isOpen ? prisma.report.count({ where: { ...sameTargetFilter(report), resolvedAt: null, reportId: { not: reportId } } }) : 0,
      // content as it is now; null when gone (or account left class)
      report.classId === null ? null : loadReportTarget(report.targetType, report.targetId, report.classId)
    ]);

    return {
      // reporter's identity and contact stay on server
      report: { ...report, reporterKey: undefined, reporterContact: undefined, hasReporterContact: report.reporterContact !== null },
      current: current?.content ?? null,
      changedSinceReport: current !== null && !isDeepStrictEqual(current.content, report.snapshot),
      author,
      editor,
      earlierOnTarget,
      earlierOnAuthor,
      otherOpenOnTarget,
      actions: isOpen ? allowedActions(report, bannableAccountIds(author, editor)) : []
    };
  },

  // always as download, so the panel's origin never renders reported content
  async getReportFile(reqParams: getReportFileTypeParams) {
    const { id: reportId, fileId } = reqParams;
    const report = await loadReport(reportId);
    if (report.targetType !== "upload" || report.classId === null) {
      throwError("Not Found", 404, "Zu dieser Meldung gibt es keine Dateien");
    }
    return await openUploadFile(fileId, { classId: report.classId, uploadId: report.targetId }, "attachment");
  },

  async resolveReport(reqParams: resolveReportTypeParams, decision: resolveReportTypeBody, moderator: Moderator) {
    const { id: reportId } = reqParams;
    const report = await loadReport(reportId, { open: true });
    await assertDecisionAllowed(report, decision);
    const decidedAt = Date.now();
    const applied = await prisma.$transaction(tx => applyDecision(tx, report, decision, decidedAt));
    await announceDecision(report, decision, applied);

    const newClassCode = decision.action !== "rotate_class_code" && rotatesClassCode(report, decision) ? " and a new class code" : "";
    logger.info(`report ${reportId} resolved with action ${decision.action}${newClassCode} ${describeModerator(moderator)}`);
  },

  async unbanAccount(reqParams: unbanAccountTypeParams, moderator: Moderator) {
    const { id: accountId } = reqParams;
    const unbanned = await prisma.account.updateMany({
      where: { accountId, bannedAt: { not: null } },
      data: { bannedAt: null, banGround: null, banReason: null }
    });
    if (unbanned.count === 0) {
      throwError("Not Found", 404, "Gesperrtes Konto nicht gefunden");
    }
    logger.info(`account ${accountId} was unbanned ${describeModerator(moderator)}`);
  }
};

export default moderationService;
