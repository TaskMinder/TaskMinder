import { timingSafeEqual } from "crypto";
import { prisma } from "../config/prisma.js";
import { redisClient } from "../config/redis.js";
import { sendMail } from "../config/mail.js";
import logger from "../config/logger.js";
import { RequestError } from "../@types/requestError.js";
import { encryptionManager } from "../utils/encryption.manager.js";
import { signReviewToken } from "./report.service.js";
import { removeHomework } from "./homework.service.js";
import { removeEvent } from "./event.service.js";
import { removeUpload } from "./upload.service.js";
import { removeLoggedOutSessions, rotateClassCode } from "./class.service.js";
import {
  getReviewPageTypeParams,
  getReviewPageTypeQuery,
  resolveReportTypeBody,
  resolveReportTypeParams
} from "../schemas/moderation.schema.js";

type Report = NonNullable<Awaited<ReturnType<typeof prisma.report.findUnique>>>;
type ModerationAction = resolveReportTypeBody["action"];

const REMOVABLE_TARGET_TYPES = ["homework", "event", "upload"];

const DECISION_LABELS: Record<ModerationAction, string> = {
  dismiss: "Keine Maßnahme",
  remove: "Inhalt entfernt",
  ban: "Konto gesperrt",
  remove_and_ban: "Inhalt entfernt und Konto gesperrt",
  rotate_class_code: "Klassencode geändert"
};

function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderPage(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>${escapeHtml(title)}</title>
<style>body{font-family:sans-serif;max-width:48rem;margin:1rem auto;padding:0 1rem}pre{white-space:pre-wrap;background:#eee;padding:.5rem}
form{border-top:1px solid #ccc;padding:.5rem 0}textarea{width:100%}</style></head><body>${body}</body></html>`;
}

function allowedActions(report: Report): ModerationAction[] {
  const canRemove = REMOVABLE_TARGET_TYPES.includes(report.targetType) && report.classId !== null;
  const canBan = report.targetAccountId !== null;
  const actions: ModerationAction[] = ["dismiss"];
  if (canRemove) actions.push("remove");
  if (canBan) actions.push("ban");
  if (canRemove && canBan) actions.push("remove_and_ban");
  // anonymous or unknown authors can only be locked out by rotating the class code
  if (!canBan && report.classId !== null) actions.push("rotate_class_code");
  return actions;
}

// token is `${expiresAt}.${hmac}`; links die once the report is no longer open
async function loadOpenReport(reportId: number, token: string): Promise<Report> {
  const [expiresAt, signature] = token.split(".");
  const expected = Buffer.from(signReviewToken(reportId, Number(expiresAt)), "utf8");
  const provided = Buffer.from(signature ?? "", "utf8");
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected) || Number(expiresAt) < Date.now()) {
    const err: RequestError = {
      name: "Forbidden",
      status: 403,
      message: "Invalid or expired review link",
      expected: true
    };
    throw err;
  }

  const report = await prisma.report.findUnique({ where: { reportId } });
  if (!report || report.status !== "open") {
    const err: RequestError = {
      name: "Gone",
      status: 410,
      message: "This report is already resolved or no longer exists",
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

async function banAccount(accountId: number, reason: string): Promise<void> {
  await prisma.account.update({
    where: { accountId },
    data: { bannedAt: BigInt(Date.now()), banReason: reason }
  });
  // the auth cache would otherwise delay the ban by up to 15min
  await redisClient.del(`auth_user:${accountId}`);
  logger.info(`account ${accountId} was banned`);
}

async function notifyReporters(
  reports: { reportId: number; reporterContact: string | null }[],
  action: ModerationAction,
  reason: string
): Promise<void> {
  for (const report of reports) {
    try {
      await sendMail({
        to: encryptionManager.decrypt(report.reporterContact!),
        subject: `TaskMinder: Entscheidung zu Meldung #${report.reportId}`,
        text: [
          `Wir haben deine Meldung #${report.reportId} geprüft.`,
          `Entscheidung: ${DECISION_LABELS[action]}`,
          reason ? `Begründung: ${reason}` : ""
        ].join("\n").trim()
      });
    }
    catch (err) {
      logger.error(`Failed to notify reporter of report ${report.reportId}: ${err}`);
    }
  }
}

function renderActionForm(report: Report, action: ModerationAction, token: string, csrfToken: string): string {
  return `<form method="post" action="/moderation/reports/${report.reportId}/resolve">
<input type="hidden" name="token" value="${escapeHtml(token)}"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}">
<input type="hidden" name="action" value="${action}">
<textarea name="reason" maxlength="1000" rows="2" placeholder="reason"${action === "dismiss" ? "" : " required"}></textarea>
<button type="submit">${action}</button></form>`;
}

const moderationService = {
  async getReviewPage(reqParams: getReviewPageTypeParams, reqQuery: getReviewPageTypeQuery, csrfToken: string) {
    const { id: reportId } = reqParams;
    const { token } = reqQuery;
    const report = await loadOpenReport(reportId, token);

    const author = report.targetAccountId === null
      ? null
      : await prisma.account.findUnique({ where: { accountId: report.targetAccountId }, select: { username: true, bannedAt: true } });
    const earlierOnTarget = await prisma.report.count({
      where: { targetType: report.targetType, targetId: report.targetId, reportId: { lt: reportId } }
    });
    const earlierOnAuthor = report.targetAccountId === null
      ? 0
      : await prisma.report.count({ where: { targetAccountId: report.targetAccountId, reportId: { lt: reportId } } });

    const rows: [string, unknown][] = [
      ["Created", new Date(Number(report.createdAt)).toISOString()],
      ["Category", report.category],
      ["Target", `${report.targetType} #${report.targetId}`],
      ["Class", report.classId ?? "-"],
      ["Author", author ? `#${report.targetAccountId} ${author.username}${author.bannedAt ? " (banned)" : ""}` : "unknown / anonymous"],
      ["Reporter", report.reporterAccountId === null ? "anonymous" : `#${report.reporterAccountId}`],
      ["Reporter contact", report.reporterContact ? "yes" : "no"],
      ["Earlier reports on target", earlierOnTarget],
      ["Earlier reports on author", earlierOnAuthor],
      ["Description", report.description ?? "-"]
    ];

    return renderPage(`Report #${reportId}`, `<h1>Report #${reportId}</h1>
<dl>${rows.map(([key, value]) => `<dt>${key}</dt><dd>${escapeHtml(value)}</dd>`).join("")}</dl>
<h2>Snapshot</h2><pre>${escapeHtml(JSON.stringify(report.snapshot, null, 2))}</pre>
<h2>Actions</h2>${allowedActions(report).map(action => renderActionForm(report, action, token, csrfToken)).join("")}`);
  },

  async resolveReport(reqParams: resolveReportTypeParams, reqBody: resolveReportTypeBody) {
    const { id: reportId } = reqParams;
    const { token, action, reason } = reqBody;
    const report = await loadOpenReport(reportId, token);

    if (!allowedActions(report).includes(action) || (action !== "dismiss" && !reason)) {
      const err: RequestError = {
        name: "Bad Request",
        status: 400,
        message: "Action not allowed for this report or reason missing",
        expected: true
      };
      throw err;
    }

    const removesContent = action === "remove" || action === "remove_and_ban";
    if (removesContent) {
      await removeReportedContent(report);
    }
    if (action === "ban" || action === "remove_and_ban") {
      await banAccount(report.targetAccountId!, reason);
    }
    if (action === "rotate_class_code") {
      await rotateClassCode(report.classId!);
      await removeLoggedOutSessions(report.classId!);
    }

    // other open reports on the same target are resolved the same way
    const sameTarget = { targetType: report.targetType, targetId: report.targetId, status: "open" };
    const withContact = await prisma.report.findMany({
      where: { ...sameTarget, reporterContact: { not: null } },
      select: { reportId: true, reporterContact: true }
    });
    await prisma.$transaction(async tx => {
      await tx.report.updateMany({
        where: sameTarget,
        data: { status: "resolved", action, decisionReason: reason || null, resolvedAt: BigInt(Date.now()), reporterContact: null }
      });
      if (removesContent && report.targetAccountId !== null) {
        await tx.moderationNotice.create({
          data: { accountId: report.targetAccountId, action, targetType: report.targetType, reason, createdAt: BigInt(Date.now()) }
        });
      }
    });
    void notifyReporters(withContact, action, reason);

    logger.info(`report ${reportId} resolved with action ${action}`);
    return renderPage(`Report #${reportId}`, `<h1>Report #${reportId} resolved</h1><p>Action: ${action}</p>`);
  }
};

export default moderationService;
