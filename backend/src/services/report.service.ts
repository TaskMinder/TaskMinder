import { Session, SessionData } from "express-session";
import { prisma } from "../config/prisma.js";
import { Prisma } from "../prisma/generated/prisma/client.js";
import { ReportTargetType } from "../prisma/generated/prisma/enums.js";
import { APP_URL, SUPPORT_EMAIL, sendMail } from "../config/mail.js";
import { redisClient } from "../config/redis.js";
import logger from "../config/logger.js";
import { encryptionManager } from "../utils/encryption.manager.js";
import { throwError, BigIntreplacer } from "../utils/common.functions.js";
import { processMailQueue, queueMails } from "../utils/mail.queue.js";
import { reporterReceiptMail } from "../utils/moderation.statements.js";
import { createReportTypeBody } from "../schemas/report.schema.js";

const DAY_SECONDS = 24 * 60 * 60;
const HOUR_MS = 60 * 60 * 1000;
// reporters can type in any address: few mails per address and day, so no mail bombing of others
const REPORTS_PER_CONTACT_PER_DAY = 3;
const PANEL_URL = `${APP_URL}/moderation`;

// ids app shows as "all" or "other" instead of team or subject
const ALL_TEAMS = -1;
const OTHER_SUBJECT = -1;

type ReportTarget = {
  targetAccountId: number | null;
  // null after anonymous edit
  editorAccountId: number | null;
  // what class sees, names instead of ids; never file bytes
  content: Prisma.InputJsonObject;
  // personal homework or event, only its owner sees it
  personal: boolean;
};

// for dedupe; anonymous members by their session
function reporterKeyOf(session: Session & Partial<SessionData>): string {
  return session.account
    ? `account:${session.account.accountId}`
    : `session:${encryptionManager.hash(session.id)}`;
}

function toJson(value: object): Prisma.InputJsonObject {
  return JSON.parse(JSON.stringify(value, BigIntreplacer)) as Prisma.InputJsonObject;
}

// null when team was deleted
async function teamName(teamId: number, classId: number): Promise<string | null> {
  if (teamId === ALL_TEAMS) {
    return "Alle";
  }
  const team = await prisma.team.findFirst({ where: { teamId, classId }, select: { name: true } });
  return team?.name ?? null;
}

async function loadHomework(homeworkId: number, classId: number): Promise<ReportTarget | null> {
  const homework = await prisma.homework.findFirst({
    where: { homeworkId, classId },
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
  if (!homework) {
    return null;
  }
  const subject = homework.subjectId === OTHER_SUBJECT
    ? { subjectNameLong: "Sonstiges" }
    : await prisma.subjects.findFirst({ where: { subjectId: homework.subjectId, classId }, select: { subjectNameLong: true } });
  return {
    targetAccountId: homework.authorAccountId,
    editorAccountId: homework.lastEditorAccountId,
    personal: homework.accountId !== null,
    content: toJson({
      content: homework.content,
      subject: subject?.subjectNameLong ?? null,
      team: await teamName(homework.teamId, classId),
      assignmentDate: homework.assignmentDate,
      submissionDate: homework.submissionDate
    })
  };
}

async function loadEvent(eventId: number, classId: number): Promise<ReportTarget | null> {
  const event = await prisma.event.findFirst({
    where: { eventId, classId },
    select: {
      name: true,
      description: true,
      startDate: true,
      endDate: true,
      lesson: true,
      teamId: true,
      accountId: true,
      authorAccountId: true,
      lastEditorAccountId: true,
      EventType: { select: { name: true } }
    }
  });
  if (!event) {
    return null;
  }
  return {
    targetAccountId: event.authorAccountId,
    editorAccountId: event.lastEditorAccountId,
    personal: event.accountId !== null,
    content: toJson({
      name: event.name,
      description: event.description,
      eventType: event.EventType.name,
      team: await teamName(event.teamId, classId),
      startDate: event.startDate,
      endDate: event.endDate,
      lesson: event.lesson
    })
  };
}

async function loadUpload(uploadId: number, classId: number): Promise<ReportTarget | null> {
  const upload = await prisma.upload.findFirst({
    where: { uploadId, classId },
    select: {
      uploadName: true,
      uploadDescription: true,
      uploadType: true,
      teamId: true,
      createdAt: true,
      accountId: true,
      lastEditorAccountId: true,
      Account: { select: { username: true } },
      Files: { select: { fileMetaDataId: true, mimeType: true, size: true, createdAt: true }, orderBy: { fileMetaDataId: "asc" } }
    }
  });
  if (!upload) {
    return null;
  }
  // uploader of the current files; last editor may only have changed name or description
  return {
    targetAccountId: upload.accountId,
    editorAccountId: upload.lastEditorAccountId,
    personal: false,
    content: toJson({
      uploadName: upload.uploadName,
      uploadDescription: upload.uploadDescription,
      uploadType: upload.uploadType,
      team: await teamName(upload.teamId, classId),
      uploader: upload.Account?.username ?? null,
      createdAt: upload.createdAt,
      files: upload.Files
    })
  };
}

// null when account is not (any more) member of class
async function loadAccount(accountId: number, classId: number): Promise<ReportTarget | null> {
  const member = await prisma.joinedClass.findFirst({
    where: { accountId, classId },
    select: { Account: { select: { username: true } } }
  });
  if (!member) {
    return null;
  }
  return { targetAccountId: accountId, editorAccountId: null, personal: false, content: { username: member.Account.username } };
}

// for the snapshot and the panel's current view
export async function loadReportTarget(targetType: ReportTargetType, targetId: number, classId: number): Promise<ReportTarget | null> {
  switch (targetType) {
  case "homework":
    return await loadHomework(targetId, classId);
  case "event":
    return await loadEvent(targetId, classId);
  case "upload":
    return await loadUpload(targetId, classId);
  case "account":
    return await loadAccount(targetId, classId);
  default:
    return null;
  }
}

async function underLimit(key: string, limit: number, windowSeconds: number): Promise<boolean> {
  const [count] = await redisClient.multi().incr(key).expire(key, windowSeconds, "NX").exec();
  return Number(count) <= limit;
}

// hourly operator mail, only when reports came in during the last full hour (at most 24 a day);
// no user content in the mail, the panel shows it
export async function sendOpenReportDigest(): Promise<void> {
  try {
    const hourEnd = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
    const newReports = await prisma.report.count({
      where: { resolvedAt: null, createdAt: { gte: hourEnd - HOUR_MS, lt: hourEnd } }
    });
    if (newReports === 0) {
      return;
    }
    const openReports = await prisma.report.count({ where: { resolvedAt: null } });
    await sendMail({
      to: SUPPORT_EMAIL,
      subject: `TaskMinder: ${newReports} new report(s), ${openReports} open`,
      text: `Panel: ${PANEL_URL}`
    });
  }
  catch (error) {
    logger.error(`Failed to send the open report digest: ${error}`);
  }
}

// false when reporter already has an open report on this target (partial unique index, see migration)
async function fileReport(
  report: createReportTypeBody,
  target: ReportTarget,
  session: Session & Partial<SessionData>
): Promise<boolean> {
  const { targetType, targetId, category, description, contactEmail } = report;
  const classId = parseInt(session.classId!, 10);
  const contactKey = contactEmail === undefined ? null : `report_mail:${encryptionManager.hash(contactEmail.toLowerCase())}`;
  // over cap the reporter gets no receipt: refused, so it can be sent without email
  if (contactKey !== null && !await underLimit(contactKey, REPORTS_PER_CONTACT_PER_DAY, DAY_SECONDS)) {
    throwError("Too Many Requests", 429, "Too many reports with this email address today. Send it without email address or try again tomorrow");
  }
  const reporterContact = contactEmail === undefined ? null : encryptionManager.encrypt(contactEmail);
  const createdAt = Date.now();
  try {
    await prisma.$transaction(async tx => {
      const newReport = await tx.report.create({
        data: {
          classId,
          targetType,
          targetId,
          targetAccountId: target.targetAccountId,
          editorAccountId: target.editorAccountId,
          reporterKey: reporterKeyOf(session),
          reporterContact,
          category,
          description: description || null,
          snapshot: target.content,
          createdAt: BigInt(createdAt)
        },
        select: { reportId: true }
      });
      if (reporterContact !== null) {
        await queueMails(tx, [{ recipient: reporterContact, ...reporterReceiptMail(newReport.reportId, category, createdAt) }]);
      }
    });
  }
  catch (error) {
    // only filed reports use up the address's slots
    if (contactKey !== null) {
      await redisClient.decr(contactKey);
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return false;
    }
    throw error;
  }
  // receipt is queued with the report and retried; operator hears of it in the hourly digest
  void processMailQueue();
  return true;
}

const reportService = {
  async createReport(reqBody: createReportTypeBody, session: Session & Partial<SessionData>) {
    const target = await loadReportTarget(reqBody.targetType, reqBody.targetId, parseInt(session.classId!, 10));
    // only its owner sees a personal item
    if (!target || target.personal) {
      throwError("Not Found", 404, "Report target not found in this class");
    }
    // own account, or own item no one else edited since
    const accountId = session.account?.accountId;
    if (accountId !== undefined && target.targetAccountId === accountId
      && (reqBody.targetType === "account" || target.editorAccountId === accountId)) {
      throwError("Bad Request", 400, "You cannot report your own account or content");
    }
    return await fileReport(reqBody, target, session);
  }
};

export default reportService;
