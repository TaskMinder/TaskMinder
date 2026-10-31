import { createHmac } from "crypto";
import { Session, SessionData } from "express-session";
import { prisma } from "../config/prisma.js";
import { envConfig } from "../config/env.js";
import { sendMail } from "../config/mail.js";
import { RequestError } from "../@types/requestError.js";
import { encryptionManager } from "../utils/encryption.manager.js";
import { BigIntreplacer } from "../utils/validate.functions.js";
import { createReportTypeBody } from "../schemas/report.schema.js";

const REVIEW_LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type ReportTarget = {
  targetAccountId: number | null;
  snapshot: Record<string, unknown>;
};

type NewReport = {
  targetType: string;
  targetId: number;
  category: string;
  description?: string;
  contactEmail?: string;
};

export function signReviewToken(reportId: number, expiresAt: number): string {
  return createHmac("sha256", envConfig.moderationLinkSecret).update(`${reportId}.${expiresAt}`).digest("hex");
}

export function createReviewLink(reportId: number): string {
  const expiresAt = Date.now() + REVIEW_LINK_TTL_MS;
  return `${envConfig.publicBaseUrl}/moderation/reports/${reportId}?token=${expiresAt}.${signReviewToken(reportId, expiresAt)}`;
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
      createdByAccountId: true,
      lastEditedByAccountId: true
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
  const { createdByAccountId, lastEditedByAccountId, ...snapshot } = homework;
  return { targetAccountId: lastEditedByAccountId ?? createdByAccountId, snapshot };
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
      createdByAccountId: true,
      lastEditedByAccountId: true
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
  const { createdByAccountId, lastEditedByAccountId, ...snapshot } = event;
  return { targetAccountId: lastEditedByAccountId ?? createdByAccountId, snapshot };
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
  return { targetAccountId: accountId, snapshot: { ...snapshot, accountName: Account?.username ?? null } };
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
  return { targetAccountId: accountId, snapshot: { username: member.Account.username } };
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
  return { targetAccountId: null, snapshot: aClass };
}

// the target must belong to the session's class; resolves the author and the snapshot
export async function resolveReportTarget(
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

// operator mail holds no user content, the review page shows it
async function notifyNewReport(reportId: number, report: NewReport, createdAt: number): Promise<void> {
  const time = new Date(createdAt).toISOString();
  await sendMail({
    to: envConfig.moderationEmailTo,
    subject: `TaskMinder report #${reportId}`,
    text: [
      `Report: #${reportId}`,
      `Category: ${report.category}`,
      `Target type: ${report.targetType}`,
      `Time: ${time}`,
      `Review: ${createReviewLink(reportId)}`
    ].join("\n")
  });
  if (report.contactEmail) {
    await sendMail({
      to: report.contactEmail,
      subject: `TaskMinder: Meldung #${reportId} erhalten`,
      text: [
        `Wir haben deine Meldung #${reportId} (${report.category}) vom ${time} erhalten.`,
        "Wir prüfen sie und informieren dich über unsere Entscheidung."
      ].join("\n")
    });
  }
}

// returns false when the reporter already has an open report on this target
export async function fileReport(
  report: NewReport,
  target: ReportTarget,
  session: Session & Partial<SessionData>
): Promise<boolean> {
  const { targetType, targetId, category, description, contactEmail } = report;
  const reporterKey = session.account
    ? `account:${session.account.accountId}`
    : `session:${encryptionManager.hash(session.id)}`;

  const existing = await prisma.report.findFirst({
    where: { reporterKey, targetType, targetId, status: "open" },
    select: { reportId: true }
  });
  if (existing) {
    return false;
  }

  const createdAt = Date.now();
  const created = await prisma.report.create({
    data: {
      classId: parseInt(session.classId!, 10),
      targetType,
      targetId,
      targetAccountId: target.targetAccountId,
      reporterAccountId: session.account?.accountId ?? null,
      reporterKey,
      reporterContact: contactEmail ? encryptionManager.encrypt(contactEmail) : null,
      category,
      description: description || null,
      snapshot: JSON.parse(JSON.stringify(target.snapshot, BigIntreplacer)),
      status: "open",
      createdAt: BigInt(createdAt)
    },
    select: { reportId: true }
  });

  void notifyNewReport(created.reportId, report, createdAt);
  return true;
}

const reportService = {
  async createReport(reqBody: createReportTypeBody, session: Session & Partial<SessionData>) {
    const target = await resolveReportTarget(reqBody.targetType, reqBody.targetId, session);
    return await fileReport(reqBody, target, session);
  }
};

export default reportService;
