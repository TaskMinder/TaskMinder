import { Db, prisma } from "../config/prisma.js";
import { MailBudgetExceededError, sendMail } from "../config/mail.js";
import { acquireLock, releaseLock } from "../config/redis.js";
import logger from "../config/logger.js";
import { encryptionManager } from "./encryption.manager.js";

// mails reporters are owed (receipt DSA Art. 16(4), decision Art. 16(5)): queued in the transaction
// that makes them due, so a decision never commits without its mails; sent and retried by processMailQueue
type QueuedMail = {
  // already encrypted with encryption manager (reporterContact as stored)
  recipient: string;
  subject: string;
  text: string;
};
type MailQueueEntry = NonNullable<Awaited<ReturnType<typeof prisma.mailQueue.findFirst>>>;

// one run sends at most one batch: with send timeout of 10s it ends long before lock expires
const BATCH_SIZE = 20;
const LOCK_KEY = "mail_queue_lock";
const LOCK_TTL_SECONDS = 5 * 60;
const RETRY_MS = 60 * 60 * 1000;
// outlasts Brevo outages and days with used-up budget; a mail failing for longer is dropped and logged
const GIVE_UP_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export async function queueMails(db: Db, mails: QueuedMail[]): Promise<void> {
  if (mails.length === 0) {
    return;
  }
  const now = BigInt(Date.now());
  await db.mailQueue.createMany({ data: mails.map(mail => ({ ...mail, nextAttemptAt: now, createdAt: now })) });
}

// failed send or used-up daily budget: tried again in an hour, dropped once it fails for too long
async function reschedule(mail: MailQueueEntry, error: unknown): Promise<void> {
  const now = Date.now();
  if (now - Number(mail.createdAt) > GIVE_UP_AFTER_MS) {
    await prisma.mailQueue.delete({ where: { mailId: mail.mailId } });
    logger.error(`Mail "${mail.subject}" dropped after failing for a week: ${error}`);
    return;
  }
  const nextAttemptAt = now + RETRY_MS;
  await prisma.mailQueue.update({ where: { mailId: mail.mailId }, data: { nextAttemptAt: BigInt(nextAttemptAt) } });
  logger.warn(`Mail "${mail.subject}" not sent, retried at ${new Date(nextAttemptAt).toISOString()}: ${error}`);
}

// false when daily budget is used up, so the rest of the batch waits as well
async function sendQueuedMail(mail: MailQueueEntry): Promise<boolean> {
  try {
    await sendMail({ to: encryptionManager.decrypt(mail.recipient), subject: mail.subject, text: mail.text });
  }
  catch (error) {
    await reschedule(mail, error);
    return !(error instanceof MailBudgetExceededError);
  }
  await prisma.mailQueue.delete({ where: { mailId: mail.mailId } });
  return true;
}

// sends due mails, oldest first; runs every minute and right after mails are queued,
// lock keeps runs from overlapping (one mail would be sent twice); never throws
export async function processMailQueue(): Promise<void> {
  const lockToken = await acquireLock(LOCK_KEY, LOCK_TTL_SECONDS).catch(error => {
    logger.error(`Mail queue not processed, lock failed: ${error}`);
    return null;
  });
  if (lockToken === null) {
    return;
  }
  try {
    const due = await prisma.mailQueue.findMany({
      where: { nextAttemptAt: { lte: Date.now() } },
      orderBy: [{ nextAttemptAt: "asc" }, { mailId: "asc" }],
      take: BATCH_SIZE
    });
    for (const mail of due) {
      if (!await sendQueuedMail(mail)) {
        break;
      }
    }
  }
  catch (error) {
    logger.error(`Mail queue run failed: ${error}`);
  }
  finally {
    await releaseLock(LOCK_KEY, lockToken);
  }
}
