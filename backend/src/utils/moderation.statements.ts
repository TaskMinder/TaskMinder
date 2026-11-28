import { APP_URL, SUPPORT_EMAIL } from "../config/mail.js";
import type { DecisionGround, ModerationAction, ReportCategory } from "../prisma/generated/prisma/enums.js";

// decision mails to reporters (DSA Art. 16(5)) and statement of reasons for bans (Art. 17): decision, ground,
// made by a person after a report, how to appeal, court stays open (Art. 17(3)(f)).
// no appeal deadline: Art. 20 does not apply to micro and small providers (Art. 19(1))

const TERMS_URL = `${APP_URL}/about#terms-of-use`;

const DECISION_LABELS: Record<ModerationAction, string> = {
  dismiss: "Wir sehen keinen Verstoß",
  remove: "Wir haben die relevanten Inhalte gelöscht",
  ban: "Wir haben das relevante Konto gesperrt",
  remove_and_ban: "Wir haben die relevanten Inhalte gelöscht und das zugehörige Konto gesperrt",
  rotate_class_code: "Wir haben den Klassencode geändert"
};

// content was deleted before the decision
const ALREADY_DELETED_LABELS: Partial<Record<ModerationAction, string>> = {
  remove: "Die relevanten Inhalte waren bereits gelöscht",
  remove_and_ban: "Die relevanten Inhalte waren bereits gelöscht und wir haben das zugehörige Konto gesperrt"
};

const GROUND_LABELS: Record<DecisionGround, string> = {
  terms: `Verstoß gegen Nr. 3 unserer Nutzungsbedingungen (${TERMS_URL})`,
  illegal: "Rechtswidriger Inhalt, die Rechtsgrundlage steht in der Begründung"
};

const CATEGORY_LABELS: Record<ReportCategory, string> = {
  illegal: "Rechtswidrig",
  harassment: "Belästigung",
  hate: "Hass",
  sexual: "Sexuelle Inhalte",
  spam: "Spam",
  privacy: "Privatsphäre",
  other: "Sonstiges"
};

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString("de-DE", { timeZone: "Europe/Berlin", dateStyle: "long" });
}

function groundAndReason(ground: DecisionGround | null, reason: string | null): string[] {
  return [
    ground ? `Grund: ${GROUND_LABELS[ground]}` : "",
    reason ? `Begründung: ${reason}` : ""
  ].filter(line => line !== "");
}

// reference: what to name in the appeal
function appealParagraph(reference: string, replyable: boolean): string {
  const channel = replyable ? `antworte auf diese E-Mail oder schreib an ${SUPPORT_EMAIL}` : `schreib an ${SUPPORT_EMAIL}`;
  return [
    `Wenn du die Entscheidung für falsch hältst, ${channel}.`,
    `Nenne ${reference} und erkläre kurz, warum. Das Moderationsteam prüft die Entscheidung dann erneut und antwortet dir.`,
    "Dein Recht, vor Gericht gegen die Entscheidung vorzugehen, bleibt davon unberührt."
  ].join(" ");
}

// DSA Art. 16(5)
export function reporterDecisionMail(
  reportId: number,
  action: ModerationAction,
  ground: DecisionGround | null,
  reason: string,
  contentAlreadyDeleted: boolean
): { subject: string; text: string } {
  const decision = contentAlreadyDeleted ? ALREADY_DELETED_LABELS[action] ?? DECISION_LABELS[action] : DECISION_LABELS[action];
  return {
    subject: `TaskMinder: Entscheidung zu deiner Meldung #${reportId}`,
    text: [
      `Hallo,\n\ndeine Meldung #${reportId} wurde vom Moderationsteam geprüft. ${decision}.`,
      groundAndReason(ground, reason || null).join("\n"),
      appealParagraph(`die Meldung #${reportId}`, true),
      "Dein TaskMinder-Team"
    ].filter(paragraph => paragraph !== "").join("\n\n")
  };
}

// DSA Art. 16(4)
export function reporterReceiptMail(reportId: number, category: ReportCategory, createdAt: number): { subject: string; text: string } {
  return {
    subject: `TaskMinder: Meldung #${reportId} erhalten`,
    text: [
      `Hallo,\n\nwir haben deine Meldung #${reportId} (${CATEGORY_LABELS[category]}) vom ${formatDate(createdAt)} erhalten.`,
      "Sie wird derzeit von unserem Moderationsteam geprüft. Sobald die Prüfung abgeschlossen ist, informieren wir dich über das Ergebnis.",
      "Dein TaskMinder-Team"
    ].join("\n\n")
  };
}

// DSA Art. 17, shown on every request of banned account
export function banStatement(account: { bannedAt: number; banGround: DecisionGround | null; banReason: string | null }): string {
  return [
    `Dein Konto wurde am ${formatDate(account.bannedAt)} gesperrt. Die Sperre gilt für ganz TaskMinder, bis wir sie aufheben.`,
    groundAndReason(account.banGround, account.banReason).join("\n"),
    "Die Entscheidung beruht auf einer Meldung und wurde vom Moderationsteam geprüft.",
    appealParagraph("deinen Nutzernamen", false)
  ].filter(paragraph => paragraph !== "").join("\n\n");
}
