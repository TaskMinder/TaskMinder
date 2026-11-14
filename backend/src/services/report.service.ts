import { Session, SessionData } from "express-session";
import { prisma } from "../config/prisma.js";
import { APP_URL, SUPPORT_EMAIL, sendMail } from "../config/mail.js";
import {
  CACHE_KEY_PREFIXES,
  acquireLock,
  cacheExpiration,
  generateCacheKey,
  invalidateCache,
  redisClient
} from "../config/redis.js";
import { emitSocketToClass, SOCKET_EVENTS, type socketEvent } from "../config/socket.js";
import logger from "../config/logger.js";
import { RequestError } from "../@types/requestError.js";
import { encryptionManager } from "../utils/encryption.manager.js";
import { BigIntreplacer } from "../utils/validate.functions.js";
import { reporterReceiptMail } from "../utils/moderation.statements.js";
import { createReportTypeBody } from "../schemas/report.schema.js";

const HOUR_SECONDS = 60 * 60;
const DAY_SECONDS = 24 * HOUR_SECONDS;
// daily caps on accepted reporter contacts; each one gets at most two mails (receipt and decision)
const REPORTER_MAILS_PER_ADDRESS_PER_DAY = 3;
const REPORTER_MAILS_PER_IP_PER_DAY = 5;
const REPORTER_MAILS_PER_DAY = 50;
// past this many mails an hour the operator is not mailed per report any more,
// the reports are still filed and counted in the daily digest
const OPERATOR_MAILS_PER_HOUR = 20;
// new reports one class can file per hour, so one class cannot flood the queue
const REPORTS_PER_CLASS_PER_HOUR = 30;
// only these targets are items in a list that can carry a "reported" flag
const FLAGGABLE_TARGET_TYPES = ["homework", "event", "upload"] as const;
const PANEL_URL = `${APP_URL}/moderation`;

type ReportTarget = {
  targetAccountId: number | null;
  // last editor, only when it is not the author
  editorAccountId: number | null;
  snapshot: Record<string, unknown>;
};

type NewReport = {
  targetType: string;
  targetId: number;
  category: string;
  description?: string;
  contactEmail?: string;
};

type FlaggableTargetType = typeof FLAGGABLE_TARGET_TYPES[number];
type ReportedIds = Record<FlaggableTargetType, number[]>;

const SOCKET_EVENT_BY_TARGET_TYPE: Record<FlaggableTargetType, socketEvent> = {
  homework: SOCKET_EVENTS.HOMEWORK,
  event: SOCKET_EVENTS.EVENTS,
  upload: SOCKET_EVENTS.UPLOADS
};

function isFlaggableTargetType(targetType: string): targetType is FlaggableTargetType {
  return (FLAGGABLE_TARGET_TYPES as readonly string[]).includes(targetType);
}

// identifies the reporter for dedupe; anonymous members by their session
function reporterKeyOf(session: Session & Partial<SessionData>): string {
  return session.account
    ? `account:${session.account.accountId}`
    : `session:${encryptionManager.hash(session.id)}`;
}

function differingEditor(authorAccountId: number | null, lastEditorAccountId: number | null): number | null {
  return lastEditorAccountId !== null && lastEditorAccountId !== authorAccountId ? lastEditorAccountId : null;
}

// another user's personal item is reported as not found, like the authorize helpers
async function getHomeworkTarget(homeworkId: number, session: Session & Partial<SessionData>): Promise<ReportTarget> {
  const homework = await prisma.homework.findFirst({
    where: { homeworkId, classId: parseInt(session.classId!, 10) },
    select: {
      content: true,
      subjectId: true,
      assignmentDate: true,
      submissionDate: true,
      teamId: true,
      accountId: true,
      authorAccountId: true,
      lastEditorAccountId: true
    }
  });
  if (!homework || (homework.accountId !== null && homework.accountId !== session.account?.accountId)) {
    const err: RequestError = {
      name: "Not Found",
      status: 404,
      message: "Homework not found",
      expected: true
    };
    throw err;
  }
  const { authorAccountId, lastEditorAccountId, ...snapshot } = homework;
  return {
    targetAccountId: authorAccountId,
    editorAccountId: differingEditor(authorAccountId, lastEditorAccountId),
    snapshot
  };
}

async function getEventTarget(eventId: number, session: Session & Partial<SessionData>): Promise<ReportTarget> {
  const event = await prisma.event.findFirst({
    where: { eventId, classId: parseInt(session.classId!, 10) },
    select: {
      name: true,
      description: true,
      startDate: true,
      endDate: true,
      lesson: true,
      eventTypeId: true,
      teamId: true,
      accountId: true,
      authorAccountId: true,
      lastEditorAccountId: true
    }
  });
  if (!event || (event.accountId !== null && event.accountId !== session.account?.accountId)) {
    const err: RequestError = {
      name: "Not Found",
      status: 404,
      message: "Event not found",
      expected: true
    };
    throw err;
  }
  const { authorAccountId, lastEditorAccountId, ...snapshot } = event;
  return {
    targetAccountId: authorAccountId,
    editorAccountId: differingEditor(authorAccountId, lastEditorAccountId),
    snapshot
  };
}

async function getUploadTarget(uploadId: number, session: Session & Partial<SessionData>): Promise<ReportTarget> {
  const upload = await prisma.upload.findFirst({
    where: { uploadId, classId: parseInt(session.classId!, 10) },
    select: {
      uploadName: true,
      uploadDescription: true,
      uploadType: true,
      teamId: true,
      createdAt: true,
      accountId: true,
      Account: { select: { username: true } },
      Files: { select: { mimeType: true, size: true, createdAt: true } }
    }
  });
  if (!upload) {
    const err: RequestError = {
      name: "Not Found",
      status: 404,
      message: "Upload not found",
      expected: true
    };
    throw err;
  }
  const { accountId, Account, ...snapshot } = upload;
  return {
    targetAccountId: accountId,
    editorAccountId: null,
    snapshot: { ...snapshot, accountName: Account?.username ?? null }
  };
}

async function getAccountTarget(accountId: number, session: Session & Partial<SessionData>): Promise<ReportTarget> {
  const member = await prisma.joinedClass.findFirst({
    where: { accountId, classId: parseInt(session.classId!, 10) },
    select: { Account: { select: { username: true } } }
  });
  if (!member) {
    const err: RequestError = {
      name: "Not Found",
      status: 404,
      message: "Account not found in this class",
      expected: true
    };
    throw err;
  }
  return { targetAccountId: accountId, editorAccountId: null, snapshot: { username: member.Account.username } };
}

async function getClassTarget(classId: number, session: Session & Partial<SessionData>): Promise<ReportTarget> {
  const aClass = classId === parseInt(session.classId!, 10)
    ? await prisma.class.findUnique({ where: { classId }, select: { className: true } })
    : null;
  if (!aClass) {
    const err: RequestError = {
      name: "Not Found",
      status: 404,
      message: "Class not found",
      expected: true
    };
    throw err;
  }
  return { targetAccountId: null, editorAccountId: null, snapshot: aClass };
}

// the target must belong to the session's class; resolves the author and the snapshot
async function resolveReportTarget(
  targetType: string,
  targetId: number,
  session: Session & Partial<SessionData>
): Promise<ReportTarget> {
  switch (targetType) {
  case "homework":
    return await getHomeworkTarget(targetId, session);
  case "event":
    return await getEventTarget(targetId, session);
  case "upload":
    return await getUploadTarget(targetId, session);
  case "account":
    return await getAccountTarget(targetId, session);
  default:
    return await getClassTarget(targetId, session);
  }
}

async function hasOpenReport(reporterKey: string, report: NewReport): Promise<boolean> {
  const { targetType, targetId } = report;
  const existing = await prisma.report.findFirst({
    where: { reporterKey, targetType, targetId, resolvedAt: null },
    select: { reportId: true }
  });
  return existing !== null;
}

// ids of the homework, events and uploads of a class that have an open report; every viewer of the
// class sees the same flags, so they are cached per class and dropped when a report is filed or resolved
async function getReportedIds(classId: string): Promise<ReportedIds> {
  const cacheKey = generateCacheKey(CACHE_KEY_PREFIXES.REPORTEDIDS, classId);
  const cached = await redisClient.get(cacheKey);
  if (cached) {
    return JSON.parse(cached) as ReportedIds;
  }

  const openReports = await prisma.report.findMany({
    where: { classId: parseInt(classId, 10), resolvedAt: null, targetType: { in: [...FLAGGABLE_TARGET_TYPES] } },
    select: { targetType: true, targetId: true }
  });
  const reportedIds: ReportedIds = { homework: [], event: [], upload: [] };
  for (const { targetType, targetId } of openReports) {
    if (isFlaggableTargetType(targetType)) {
      reportedIds[targetType].push(targetId);
    }
  }
  try {
    await redisClient.set(cacheKey, JSON.stringify(reportedIds), { expiration: { type: "EX", value: cacheExpiration } });
  }
  catch (error) {
    logger.error(`Error updating Redis ${cacheKey} cache: ${error}`);
  }
  return reportedIds;
}

// the list responses carry the flag, so the cache is dropped and the class's clients reload their lists
export async function refreshReportedFlags(classId: number, targetTypes: string[]): Promise<void> {
  await invalidateCache(CACHE_KEY_PREFIXES.REPORTEDIDS, classId.toString());
  for (const targetType of new Set(targetTypes)) {
    if (isFlaggableTargetType(targetType)) {
      emitSocketToClass(classId, SOCKET_EVENT_BY_TARGET_TYPE[targetType]);
    }
  }
}

// author ids may live in the shared cache but never leave the server, so they are stripped here;
// items with an open report get isReported, the same for every viewer, until the operator decides
export async function flagReportedItems(
  items: Record<string, unknown>[],
  options: { readonly targetType: FlaggableTargetType; readonly idKey: string; readonly authorKeys: readonly string[] },
  session: Session & Partial<SessionData>
): Promise<Record<string, unknown>[]> {
  const reportedIds = new Set((await getReportedIds(session.classId!))[options.targetType]);
  return items.map(item => {
    const rest = { ...item };
    options.authorKeys.forEach(key => delete rest[key]);
    return { ...rest, isReported: reportedIds.has(rest[options.idKey] as number) };
  });
}

async function underLimit(key: string, limit: number, windowSeconds: number): Promise<boolean> {
  const count = await redisClient.incr(key);
  await redisClient.expire(key, windowSeconds, "NX");
  return count <= limit;
}

// operator mail holds no user content, the moderation panel shows it
async function notifyNewReport(reportId: number, report: NewReport, createdAt: number): Promise<void> {
  const time = new Date(createdAt).toISOString();
  if (await underLimit("report_notify:operator", OPERATOR_MAILS_PER_HOUR, HOUR_SECONDS)) {
    await sendMail({
      to: SUPPORT_EMAIL,
      subject: `TaskMinder report #${reportId}`,
      text: [
        `Report: #${reportId}`,
        `Category: ${report.category}`,
        `Target type: ${report.targetType}`,
        `Time: ${time}`,
        `Panel: ${PANEL_URL}`
      ].join("\n")
    });
  }
  else {
    logger.warn(`Operator mail for report ${reportId} skipped, hourly cap reached. It is counted in the daily digest`);
  }
  if (report.contactEmail) {
    await sendMail({ to: report.contactEmail, ...reporterReceiptMail(reportId, report.category, createdAt) });
  }
}

// reports whose mail got lost or capped would sit unseen otherwise
export async function sendOpenReportDigest(): Promise<void> {
  try {
    const openReports = await prisma.report.count({ where: { resolvedAt: null } });
    if (openReports > 0) {
      await sendMail({ to: SUPPORT_EMAIL, subject: `TaskMinder: ${openReports} open report(s)`, text: `Panel: ${PANEL_URL}` });
    }
  }
  catch (error) {
    logger.error(`Failed to send the open report digest: ${error}`);
  }
}

async function assertClassUnderReportCap(classId: number): Promise<void> {
  if (await underLimit(`report_class:${classId}`, REPORTS_PER_CLASS_PER_HOUR, HOUR_SECONDS)) {
    return;
  }
  const err: RequestError = {
    name: "Too Many Requests",
    status: 429,
    message: "This class has filed too many reports recently. Please try again later",
    expected: true
  };
  throw err;
}

// reporters can type in any address, so mails to them are capped per address, per IP and in total;
// over the cap the report is still filed, just without contact
async function allowReporterContact(email: string, ip: string | undefined): Promise<boolean> {
  return await underLimit(`report_mail:${encryptionManager.hash(email.toLowerCase())}`, REPORTER_MAILS_PER_ADDRESS_PER_DAY, DAY_SECONDS)
    && (ip === undefined || await underLimit(`report_mail_ip:${encryptionManager.hash(ip)}`, REPORTER_MAILS_PER_IP_PER_DAY, DAY_SECONDS))
    && await underLimit("report_mail:total", REPORTER_MAILS_PER_DAY, DAY_SECONDS);
}

// returns false when the reporter already has an open report on this target
async function fileReport(
  report: NewReport,
  target: ReportTarget,
  session: Session & Partial<SessionData>,
  ip?: string
): Promise<boolean> {
  const { targetType, targetId, category, description } = report;
  const classId = parseInt(session.classId!, 10);
  const reporterKey = reporterKeyOf(session);

  // find-then-create is not atomic
  const lockKey = `report_lock:${reporterKey}:${targetType}:${targetId}`;
  if (!await acquireLock(lockKey, 10)) {
    return false;
  }
  try {
    if (await hasOpenReport(reporterKey, report)) {
      return false;
    }
    await assertClassUnderReportCap(classId);

    const contactEmail = report.contactEmail && await allowReporterContact(report.contactEmail, ip)
      ? report.contactEmail
      : undefined;
    const createdAt = Date.now();
    const created = await prisma.report.create({
      data: {
        classId,
        targetType,
        targetId,
        targetAccountId: target.targetAccountId,
        editorAccountId: target.editorAccountId,
        reporterKey,
        reporterContact: contactEmail ? encryptionManager.encrypt(contactEmail) : null,
        category,
        description: description || null,
        snapshot: JSON.parse(JSON.stringify(target.snapshot, BigIntreplacer)),
        createdAt: BigInt(createdAt)
      },
      select: { reportId: true }
    });
    // the item now shows as reported to the whole class
    await refreshReportedFlags(classId, [targetType]);

    void notifyNewReport(created.reportId, { ...report, contactEmail }, createdAt)
      .catch(error => logger.error(`Failed to notify about report ${created.reportId}: ${error}`));
    return true;
  }
  finally {
    await redisClient.del(lockKey);
  }
}

const reportService = {
  async createReport(reqBody: createReportTypeBody, session: Session & Partial<SessionData>, ip?: string) {
    const target = await resolveReportTarget(reqBody.targetType, reqBody.targetId, session);
    return await fileReport(reqBody, target, session, ip);
  }
};

export default reportService;
