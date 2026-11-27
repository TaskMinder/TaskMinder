import * as dotenv from "dotenv";
dotenv.config();
import { Db, prisma } from "../config/prisma.js";
import logger from "../config/logger.js";
import { encryptionManager } from "./encryption.manager.js";
import { requireBase64Key } from "../config/env.js";

// every row is updated in one transaction, so it needs more than the default 5s
const TRANSACTION_TIMEOUT_MS = 2 * 60 * 1000;

type Readable = { plaintext: string; underPrimary: boolean };

// rotation moves old primary key to ENCRYPTION_KEY_SECONDARY and sets a new primary;
// underPrimary: already under new primary key, else (old key or plaintext) it must be re-encrypted.
// decrypt() cannot tell, it falls back to secondary key; throws when neither key fits
function readForRotation(payload: string): Readable {
  const underPrimary = encryptionManager.decryptWithPrimaryOnly(payload);
  if (underPrimary !== null) {
    return { plaintext: underPrimary, underPrimary: true };
  }
  return { plaintext: encryptionManager.decryptWithSecondary(payload), underPrimary: false };
}

// null when neither key fits (encrypted with key older than secondary)
function tryReadForRotation(payload: string): Readable | null {
  try {
    return readForRotation(payload);
  }
  catch {
    return null;
  }
}

// re-encrypted when not under primary key, re-hashed when lookup key changed;
// class codes neither key decrypts stay as they are and are reported (admin can generate a new class code)
async function rotateClassCodes(tx: Db): Promise<{ updated: number; unreadableClassIds: number[] }> {
  const classes = await tx.class.findMany({ select: { classId: true, classCode: true, classCodeHash: true } });
  let updated = 0;
  const unreadableClassIds: number[] = [];
  for (const { classId, classCode, classCodeHash } of classes) {
    const readable = tryReadForRotation(classCode);
    if (readable === null) {
      unreadableClassIds.push(classId);
      continue;
    }
    const newHash = encryptionManager.hash(readable.plaintext);
    if (readable.underPrimary && newHash === classCodeHash) {
      continue;
    }
    await tx.class.update({
      where: { classId },
      data: { classCode: encryptionManager.encrypt(readable.plaintext), classCodeHash: newHash }
    });
    updated += 1;
  }
  return { updated, unreadableClassIds };
}

// reporter contacts of open reports and recipients of queued mails; one neither key decrypts can never be used,
// so it is removed (contact cleared, queued mail deleted)
async function rotateModerationContacts(tx: Db): Promise<{ updated: number; removed: number }> {
  let updated = 0;
  let removed = 0;
  const reports = await tx.report.findMany({
    where: { reporterContact: { not: null } },
    select: { reportId: true, reporterContact: true }
  });
  for (const { reportId, reporterContact } of reports) {
    const readable = tryReadForRotation(reporterContact!);
    if (readable?.underPrimary) {
      continue;
    }
    await tx.report.update({
      where: { reportId },
      data: { reporterContact: readable === null ? null : encryptionManager.encrypt(readable.plaintext) }
    });
    if (readable === null) removed += 1;
    else updated += 1;
  }
  const mails = await tx.mailQueue.findMany({ select: { mailId: true, recipient: true } });
  for (const { mailId, recipient } of mails) {
    const readable = tryReadForRotation(recipient);
    if (readable?.underPrimary) {
      continue;
    }
    if (readable === null) {
      await tx.mailQueue.delete({ where: { mailId } });
      removed += 1;
      continue;
    }
    await tx.mailQueue.update({ where: { mailId }, data: { recipient: encryptionManager.encrypt(readable.plaintext) } });
    updated += 1;
  }
  return { updated, removed };
}

async function rotateKeys(): Promise<void> {
  // still use requireBase64Key(..) here since rotation script can be called as standalone
  requireBase64Key("ENCRYPTION_KEY_SECONDARY");

  const { classCodes, contacts } = await prisma.$transaction(async tx => ({
    classCodes: await rotateClassCodes(tx),
    contacts: await rotateModerationContacts(tx)
  }), { timeout: TRANSACTION_TIMEOUT_MS });

  logger.info(`Key rotation complete. Re-encrypted ${classCodes.updated} class codes and ${contacts.updated} reporter contacts.`);
  if (contacts.removed > 0) {
    logger.warn(`${contacts.removed} reporter contacts could not be decrypted with either key and were removed.`);
  }
  if (classCodes.unreadableClassIds.length > 0) {
    logger.error(
      `${classCodes.unreadableClassIds.length} class codes could not be decrypted with either key and were left as they are ` +
      `(classes ${classCodes.unreadableClassIds.join(", ")}). An admin of each can generate a new class code.`
    );
    process.exitCode = 1;
  }
}

rotateKeys()
  .catch(error => {
    logger.error(`Failed to rotate keys: ${error}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
