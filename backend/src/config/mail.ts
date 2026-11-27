import { envConfig } from "./env.js";
import logger from "./logger.js";
import { redisClient } from "./redis.js";

// operator inbox and sender for moderation mails, also address for appeals
export const SUPPORT_EMAIL = "support@taskminder.de";
// base of links in mails and moderation statements
export const APP_URL = envConfig.nodeEnv === "DEVELOPMENT" ? "http://localhost:3000" : "https://app.taskminder.de";

const BREVO_URL = "https://api.brevo.com/v3/smtp/email";
const SENDER = { name: "TaskMinder", email: SUPPORT_EMAIL };
const TIMEOUT_MS = 10_000;
// Brevo free plan: 300 mails a day, counted here per UTC day for every mail sent.
// if Brevo's day starts at another hour, Brevo itself rejects the rest; queued mails are retried either way
const MAILS_PER_DAY = 300;
const BUDGET_KEY_TTL_SECONDS = 2 * 24 * 60 * 60;

export class MailBudgetExceededError extends Error {}

async function takeFromDailyBudget(): Promise<boolean> {
  const key = `mail_budget:${new Date().toISOString().slice(0, 10)}`;
  const [count] = await redisClient.multi().incr(key).expire(key, BUDGET_KEY_TTL_SECONDS, "NX").exec();
  return Number(count) <= MAILS_PER_DAY;
}

// throws MailBudgetExceededError past the daily budget: queued mails are retried later,
// operator mails are covered by the daily digest
export async function sendMail({ to, subject, text }: { to: string; subject: string; text: string }): Promise<void> {
  if (!envConfig.brevoApiKey) {
    logger.info(`Mail not sent (no BREVO_API_KEY) to ${to}: ${subject}\n${text}`);
    return;
  }
  if (!await takeFromDailyBudget()) {
    throw new MailBudgetExceededError(`Daily mail budget of ${MAILS_PER_DAY} used up, mail "${subject}" not sent`);
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
