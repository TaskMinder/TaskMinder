import { envConfig } from "./env.js";
import logger from "./logger.js";

// operator inbox and sender for moderation mails, also address for appeals
export const SUPPORT_EMAIL = "support@taskminder.de";
// base of links in mails and moderation statements
export const APP_URL = envConfig.nodeEnv === "DEVELOPMENT" ? "http://localhost:3000" : "https://app.taskminder.de";

const BREVO_URL = "https://api.brevo.com/v3/smtp/email";
const SENDER = { name: "TaskMinder", email: SUPPORT_EMAIL };
const TIMEOUT_MS = 10_000;

// Brevo enforces its daily quota itself; queued mails are retried when it refuses
export async function sendMail({ to, subject, text }: { to: string; subject: string; text: string }): Promise<void> {
  if (!envConfig.brevoApiKey) {
    logger.info(`Mail not sent (no BREVO_API_KEY) to ${to}: ${subject}\n${text}`);
    return;
  }
  const response = await fetch(BREVO_URL, {
    method: "POST",
    headers: {
      "api-key": envConfig.brevoApiKey,
      "content-type": "application/json",
      accept: "application/json"
    },
    body: JSON.stringify({ sender: SENDER, to: [{ email: to }], subject, textContent: text }),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  if (!response.ok) {
    throw new Error(`Brevo rejected mail "${subject}" with ${response.status}: ${await response.text()}`);
  }
}
