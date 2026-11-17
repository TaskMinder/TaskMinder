import { APP_URL, SUPPORT_EMAIL } from "../config/mail.js";
import type { resolveReportTypeBody } from "../schemas/moderation.schema.js";

// German texts that tell people about a moderation decision:
// - the decision mail to reporters (DSA Art. 16(5))
// - the statement of reasons for removed content and for bans (DSA Art. 17)
// Every text says what was decided, on which ground, that a person decided after a report,
// and how to appeal. The panel texts are used in frontend/src/pages/moderation.

export type ModerationAction = resolveReportTypeBody["action"];
export type DecisionGround = NonNullable<resolveReportTypeBody["ground"]>;

// decision can be appealed for six months after it was made (minimum DSA Art. 20(1))
// sets for complaint systems, and resolved reports are kept for as long (see cleanupModerationRecords)
export const APPEAL_PERIOD_MONTHS = 6;

const TERMS_URL = `${APP_URL}/about#terms-of-use`;

// for the reporter
const DECISION_LABELS: Record<ModerationAction, string> = {
  dismiss: "Wir sehen keinen Verstoß",
  remove: "Wir haben die relevanten Inhalte gelöscht",
  ban: "Wir haben das relevante Konto gesperrt",
  remove_and_ban: "Wir haben die relevanten Inhalte gelöscht und das zugehörige Konto gesperrt",
  rotate_class_code: "Wir haben den Klassencode geändert"
};

const GROUND_LABELS: Record<DecisionGround, string> = {
  terms: `Verstoß gegen Nr. 3 unserer Nutzungsbedingungen (${TERMS_URL})`,
  illegal: "Rechtswidriger Inhalt, die Rechtsgrundlage steht in der Begründung"
};

export const CATEGORY_LABELS: Record<string, string> = {
  illegal: "Rechtswidrig",
  harassment: "Belästigung",
  hate: "Hass",
  sexual: "Sexuelle Inhalte",
  spam: "Spam",
  privacy: "Privatsphäre",
  other: "Sonstiges"
};

// who gets notice: author and different last editor; uploads have no editor
const REMOVED_ITEM_LABELS: Record<string, string> = {
  homework: "Eine Hausaufgabe, die du erstellt oder zuletzt bearbeitet hast,",
  event: "Ein Ereignis, das du erstellt oder zuletzt bearbeitet hast,",
  upload: "Eine Datei, die du hochgeladen hast,"
};

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString("de-DE", { timeZone: "Europe/Berlin", dateStyle: "long" });
}

export function appealDeadline(decidedAt: number): number {
  const deadline = new Date(decidedAt);
  deadline.setMonth(deadline.getMonth() + APPEAL_PERIOD_MONTHS);
  return deadline.getTime();
}

function groundAndReason(ground: string | null, reason: string | null): string[] {
  return [
    ground ? `Grund: ${GROUND_LABELS[ground as DecisionGround] ?? ground}` : "",
    reason ? `Begründung: ${reason}` : ""
  ].filter(line => line !== "");
}

// how to appeal; `reference` what person names in appeal so we find decision
function appealParagraph(decidedAt: number, reference: string, replyable: boolean): string {
  const channel = replyable ? `antworte auf diese E-Mail oder schreib an ${SUPPORT_EMAIL}` : `schreib an ${SUPPORT_EMAIL}`;
  return [
    `Wenn du die Entscheidung für falsch hältst, ${channel}, spätestens am ${formatDate(appealDeadline(decidedAt))}.`,
    `Nenne ${reference} und erkläre kurz, warum. Das Moderationsteam prüft die Entscheidung dann erneut und antwortet dir.`
  ].join(" ");
}

// DSA Art. 16(5): reporter hears decision and how appeal
export function reporterDecisionMail(
  reportId: number,
  action: ModerationAction,
  ground: string | null,
  reason: string,
  decidedAt: number
): { subject: string; text: string } {
  return {
    subject: `TaskMinder: Entscheidung zu deiner Meldung #${reportId}`,
    text: [
      `Hallo,\n\ndeine Meldung #${reportId} wurde vom Moderationsteam geprüft. ${DECISION_LABELS[action]}.`,
      groundAndReason(ground, reason || null).join("\n"),
      appealParagraph(decidedAt, `die Meldung #${reportId}`, true),
      "Dein TaskMinder-Team"
    ].filter(paragraph => paragraph !== "").join("\n\n")
  };
}

// DSA Art. 16(4): confirms receipt of report
export function reporterReceiptMail(reportId: number, category: string, createdAt: number): { subject: string; text: string } {
  return {
    subject: `TaskMinder: Meldung #${reportId} erhalten`,
    text: [
      `Hallo,\n\nwir haben deine Meldung #${reportId} (${CATEGORY_LABELS[category] ?? category}) vom ${formatDate(createdAt)} erhalten.`,
      "Sie wird derzeit von unserem Moderationsteam geprüft. Sobald die Prüfung abgeschlossen ist, informieren wir dich über das Ergebnis.",
      "Dein TaskMinder-Team"
    ].join("\n\n")
  };
}

// DSA Art. 17: statement of reasons for author and last editor of removed content
export function removalStatement(notice: {
  reportId: number;
  targetType: string;
  ground: string;
  reason: string;
  createdAt: number;
}): string {
  const item = REMOVED_ITEM_LABELS[notice.targetType] ?? "Ein Inhalt von dir";
  return [
    `${item} wurde am ${formatDate(notice.createdAt)} aus deiner Klasse gelöscht.`,
    groundAndReason(notice.ground, notice.reason).join("\n"),
    `Die Entscheidung beruht auf einer Meldung (Meldung #${notice.reportId}) und wurde vom Moderationsteam geprüft. `
      + "Gelöscht wurde nur dieser Inhalt.",
    appealParagraph(notice.createdAt, `die Meldung #${notice.reportId}`, false)
  ].join("\n\n");
}

// DSA Art. 17: statement of reasons for banned account, shown on every request it makes
export function banStatement(account: { bannedAt: number; banGround: string | null; banReason: string | null }): string {
  return [
    `Dein Konto wurde am ${formatDate(account.bannedAt)} gesperrt. Die Sperre gilt für ganz TaskMinder, bis wir sie aufheben.`,
    groundAndReason(account.banGround, account.banReason).join("\n"),
    "Die Entscheidung beruht auf einer Meldung und wurde vom Moderationsteam geprüft.",
    appealParagraph(account.bannedAt, "deinen Nutzernamen", false)
  ].filter(paragraph => paragraph !== "").join("\n\n");
}
