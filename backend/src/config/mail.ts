import { Resend } from "resend";
import { envConfig } from "./env.js";
import logger from "./logger.js";

// operator inbox and sender for moderation mails, also the address for appeals
export const SUPPORT_EMAIL = "support@taskminder.de";
// base of the links in mails and moderation statements
export const APP_URL = envConfig.nodeEnv === "DEVELOPMENT" ? "http://localhost:3000" : "https://app.taskminder.de";

const resend = envConfig.resendApiKey ? new Resend(envConfig.resendApiKey) : null;

// failures are logged and never thrown, callers must not fail because of mail
export async function sendMail({ to, subject, text }: { to: string; subject: string; text: string }): Promise<void> {
  if (!resend) {
    logger.info(`Mail not sent (no RESEND_API_KEY) to ${to}: ${subject}\n${text}`);
    return;
  }
  try {
    const { error } = await resend.emails.send({ from: SUPPORT_EMAIL, to, subject, text });
    if (error) {
      logger.error(`Failed to send mail "${subject}": ${error.message}`);
    }
  }
  catch (err) {
    logger.error(`Failed to send mail "${subject}": ${err}`);
  }
}
