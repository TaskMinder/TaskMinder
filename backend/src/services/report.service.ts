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
// reporters can type in any address, so one address gets mails for only a few reports a day (no mail bombing of others);
// all other mail volume is bounded by the daily budget in sendMail, reporter mails past it wait in mail queue
const REPORTS_PER_CONTACT_PER_DAY = 3;
// past it operator is not mailed per report any more, reports are still counted in daily digest
const OPERATOR_MAILS_PER_DAY = 50;
const PANEL_URL = `${APP_URL}/moderation`;

// ids app shows as "all" or "other" instead of team or subject
const ALL_TEAMS = -1;
const OTHER_SUBJECT = -1;

type ReportTarget = {
  targetAccountId: number | null;
  // last editor as stored: same id as author when author edited last, null after anonymous edit
  editorAccountId: number | null;
  // what class sees, with names instead of ids, as JSON (bigints as strings); never file bytes
  content: Prisma.InputJsonObject;
  // personal (account-scoped) homework or event: only its owner sees it
  personal: boolean;
};

// identifies reporter for dedupe; anonymous members by their session
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
  // uploader is whoever uploaded current files; last editor may only have changed name or description
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

// target of class with its author and content, for snapshot and for panel's view of it (now)
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

// operator mail holds no user content, moderation panel shows it
async function notifyOperator(reportId: number, report: createReportTypeBody, createdAt: number): Promise<void> {
  const time = new Date(createdAt).toISOString();
  if (await underLimit("report_notify:operator", OPERATOR_MAILS_PER_DAY, DAY_SECONDS)) {
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
    logger.warn(`Operator mail for report ${reportId} skipped, daily cap reached. It is counted in the daily digest`);
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

// false when reporter already has open report on this target (unique index on open reports, see migration)
async function fileReport(
  report: createReportTypeBody,
  target: ReportTarget,
  session: Session & Partial<SessionData>
): Promise<boolean> {
  const { targetType, targetId, category, description, contactEmail } = report;
  const classId = parseInt(session.classId!, 10);
  // over cap report is still filed, just without contact
  const reporterContact = contactEmail !== undefined
    && await underLimit(`report_mail:${encryptionManager.hash(contactEmail.toLowerCase())}`, REPORTS_PER_CONTACT_PER_DAY, DAY_SECONDS)
    ? encryptionManager.encrypt(contactEmail)
    : null;
  const createdAt = Date.now();
  let reportId: number;
  try {
    reportId = await prisma.$transaction(async tx => {
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
      return newReport.reportId;
    });
  }
  catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return false;
    }
    throw error;
  }
  // independent of each other, so failed operator mail will not let receipt fail (DSA Art. 16(4));
  // receipt was queued with report and is retried, operator mail is best effort (daily digest covers it)
  void notifyOperator(reportId, report, createdAt)
    .catch(error => logger.error(`Failed to notify the operator about report ${reportId}: ${error}`));
  void processMailQueue();
  return true;
}

const reportService = {
  async createReport(reqBody: createReportTypeBody, session: Session & Partial<SessionData>) {
    const target = await loadReportTarget(reqBody.targetType, reqBody.targetId, parseInt(session.classId!, 10));
    // personal items are only seen by their owner, so there is nothing to report
    if (!target || target.personal) {
      throwError("Not Found", 404, "Report target not found in this class");
    }
    return await fileReport(reqBody, target, session);
  }
};

export default reportService;
