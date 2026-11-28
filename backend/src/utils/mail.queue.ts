import { Db, prisma } from "../config/prisma.js";
import { sendMail } from "../config/mail.js";
import logger from "../config/logger.js";
import { encryptionManager } from "./encryption.manager.js";

// mails reporters are owed (DSA Art. 16(4), (5)), queued in the transaction that makes them due
type QueuedMail = {
  // encrypted with encryption manager (reporterContact as stored)
  recipient: string;
  subject: string;
  text: string;
};
type MailQueueEntry = NonNullable<Awaited<ReturnType<typeof prisma.mailQueue.findFirst>>>;

const BATCH_SIZE = 20;
const RETRY_MS = 60 * 60 * 1000;
const GIVE_UP_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

// one server process, so a flag keeps runs from overlapping (and one mail from going out twice)
let running = false;

export async function queueMails(db: Db, mails: QueuedMail[]): Promise<void> {
  if (mails.length === 0) {
    return;
  }
  const now = BigInt(Date.now());
  await db.mailQueue.createMany({ data: mails.map(mail => ({ ...mail, nextAttemptAt: now, createdAt: now })) });
}

// retried in an hour, dropped after failing for a week
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

async function sendQueuedMail(mail: MailQueueEntry): Promise<void> {
  try {
    await sendMail({ to: encryptionManager.decrypt(mail.recipient), subject: mail.subject, text: mail.text });
  }
  catch (error) {
    await reschedule(mail, error);
    return;
  }
  await prisma.mailQueue.delete({ where: { mailId: mail.mailId } });
}

// sends due mails, oldest first; runs every minute and right after mails are queued; never throws
export async function processMailQueue(): Promise<void> {
  if (running) {
    return;
  }
  running = true;
  try {
    const due = await prisma.mailQueue.findMany({
      where: { nextAttemptAt: { lte: Date.now() } },
      orderBy: [{ nextAttemptAt: "asc" }, { mailId: "asc" }],
      take: BATCH_SIZE
    });
    for (const mail of due) {
      await sendQueuedMail(mail);
    }
  }
  catch (error) {
    logger.error(`Mail queue run failed: ${error}`);
  }
  finally {
    running = false;
  }
}
