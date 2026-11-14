import { APP_URL, SUPPORT_EMAIL } from "../config/mail.js";
import type { resolveReportTypeBody } from "../schemas/moderation.schema.js";

// German texts that tell people about a moderation decision:
// - the decision mail to reporters (DSA Art. 16(5))
// - the statement of reasons for removed content and for bans (DSA Art. 17)
// Every text says what was decided, on which ground, that a person decided after a report,
// and how to appeal. The panel texts live in frontend/src/pages/moderation.

export type ModerationAction = resolveReportTypeBody["action"];
export type DecisionGround = NonNullable<resolveReportTypeBody["ground"]>;

// a decision can be appealed for six months after it was made; that is the minimum DSA Art. 20(1)
// sets for complaint systems, and resolved reports are kept for as long (see cleanupModerationRecords)
export const APPEAL_PERIOD_MONTHS = 6;

const TERMS_URL = `${APP_URL}/about#terms-of-use`;

// past tense, for the reporter
const DECISION_LABELS: Record<ModerationAction, string> = {
  dismiss: "Wir sehen keinen Verstoß und unternehmen nichts",
  remove: "Wir haben den Inhalt gelöscht",
  ban: "Wir haben das Konto gesperrt",
  remove_and_ban: "Wir haben den Inhalt gelöscht und das Konto gesperrt",
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

// who gets a notice: the author and a different last editor; uploads have no editor
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

// how to appeal; `reference` is what the person names in the appeal so we find the decision
function appealParagraph(decidedAt: number, reference: string, replyable: boolean): string {
  const channel = replyable ? `antworte auf diese E-Mail oder schreib an ${SUPPORT_EMAIL}` : `schreib an ${SUPPORT_EMAIL}`;
  return [
    `Wenn du die Entscheidung für falsch hältst, ${channel}, spätestens am ${formatDate(appealDeadline(decidedAt))}.`,
    `Nenne ${reference} und erkläre kurz, warum. Ein Mensch prüft die Entscheidung dann noch einmal und antwortet dir.`,
    "Unabhängig davon kannst du vor Gericht gegen die Entscheidung vorgehen."
  ].join(" ");
}

const HUMAN_DECISION = "Ein Mensch hat die Meldung geprüft und entschieden, ohne automatisierte Mittel.";

// DSA Art. 16(5): the reporter hears the decision and how to appeal it
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
      `Hallo,\n\nwir haben deine Meldung #${reportId} geprüft. ${DECISION_LABELS[action]}.`,
      groundAndReason(ground, reason || null).join("\n"),
      HUMAN_DECISION,
      appealParagraph(decidedAt, `die Meldung #${reportId}`, true),
      "Dein TaskMinder-Team"
    ].filter(paragraph => paragraph !== "").join("\n\n")
  };
}

// DSA Art. 16(4): confirms the receipt of a report
export function reporterReceiptMail(reportId: number, category: string, createdAt: number): { subject: string; text: string } {
  return {
    subject: `TaskMinder: Meldung #${reportId} erhalten`,
    text: [
      `Hallo,\n\nwir haben deine Meldung #${reportId} (${CATEGORY_LABELS[category] ?? category}) vom ${formatDate(createdAt)} erhalten.`,
      "Ein Mensch prüft sie, und wir schreiben dir, sobald wir entschieden haben.",
      "Dein TaskMinder-Team"
    ].join("\n\n")
  };
}

// DSA Art. 17: statement of reasons for the author and the last editor of removed content
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
    `Die Entscheidung beruht auf einer Meldung (Meldung #${notice.reportId}). ${HUMAN_DECISION} `
      + "Gelöscht wurde nur dieser Inhalt.",
    appealParagraph(notice.createdAt, `die Meldung #${notice.reportId}`, false)
  ].join("\n\n");
}

// DSA Art. 17: statement of reasons for a banned account, shown on every request it makes
export function banStatement(account: { bannedAt: number; banGround: string | null; banReason: string | null }): string {
  return [
    `Dein Konto wurde am ${formatDate(account.bannedAt)} gesperrt. Die Sperre gilt für ganz TaskMinder, bis wir sie aufheben.`,
    groundAndReason(account.banGround, account.banReason).join("\n"),
    `Die Entscheidung beruht auf einer Meldung. ${HUMAN_DECISION}`,
    appealParagraph(account.bannedAt, "deinen Nutzernamen", false)
      + " Heben wir die Sperre auf, kannst du dein Konto sofort wieder nutzen."
  ].filter(paragraph => paragraph !== "").join("\n\n");
}
