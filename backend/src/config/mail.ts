import { Resend } from "resend";
import { envConfig } from "./env.js";
import logger from "./logger.js";

const resend = envConfig.resendApiKey ? new Resend(envConfig.resendApiKey) : null;

// failures are logged and never thrown, callers must not fail because of mail
export async function sendMail({ to, subject, text }: { to: string; subject: string; text: string }): Promise<void> {
  if (!resend) {
    logger.info(`Mail not sent (no RESEND_API_KEY) to ${to}: ${subject}\n${text}`);
    return;
  }
  try {
    const { error } = await resend.emails.send({ from: envConfig.moderationEmailFrom, to, subject, text });
    if (error) {
      logger.error(`Failed to send mail "${subject}": ${error.message}`);
    }
  }
  catch (err) {
    logger.error(`Failed to send mail "${subject}": ${err}`);
  }
}
