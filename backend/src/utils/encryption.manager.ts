import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes
} from "crypto";
import logger from "../config/logger.js";
import { requireBase64Key } from "../config/env.js";

const ENCRYPTION_PREFIX = "enc:v1:";
// Derive a fixed 32-byte salt from a descriptive string
const HKDF_SALT = createHash("sha256")
  .update("TaskMinder-Encryption-Key-Salt-v1", "utf8")
  .digest();

const deriveKey = (masterKey: Buffer, info: string): Buffer =>
  Buffer.from(hkdfSync("sha256", masterKey, HKDF_SALT, Buffer.from(info), 32));

const deriveLookupHash = (lookupKey: Buffer, plaintext: string): string =>
  createHmac("sha256", lookupKey)
    .update(plaintext, "utf8")
    .digest("base64");

const parseBase64Key = (keyValue: string, envName: string): Buffer => {
  const key = Buffer.from(keyValue, "base64");
  if (key.length !== 32) {
    throw new Error(`${envName} must be 32 bytes (base64).`);
  }
  return key;
};

export class EncryptionManager {
  private readonly primaryEncKey: Buffer;
  private readonly lookupKey: Buffer;
  private readonly secondaryEncKeys: Buffer[];
  private readonly decryptKeys: Buffer[];

  private constructor(primaryKey: Buffer, secondaryKeys: Buffer[], lookupKey: Buffer) {
    this.primaryEncKey = deriveKey(primaryKey, "taskminder:enc");
    this.lookupKey = deriveKey(lookupKey, "taskminder:lookup");
    this.secondaryEncKeys = secondaryKeys.map(key => deriveKey(key, "taskminder:enc"));
    this.decryptKeys = [
      this.primaryEncKey,
      ...this.secondaryEncKeys
    ];
  }

  static fromEnv(): EncryptionManager {
    // still use requireBase64Key(..) instead of loading from config since manager can be called as standalone singleton
    const primaryKeyValue = requireBase64Key("ENCRYPTION_KEY");
    const secondaryKeyValue = requireBase64Key("ENCRYPTION_KEY_SECONDARY");
    const lookupKeyValue = requireBase64Key("ENCRYPTION_KEY_LOOKUP");

    const primaryKey = parseBase64Key(primaryKeyValue, "ENCRYPTION_KEY");
    const lookupKey = parseBase64Key(lookupKeyValue, "ENCRYPTION_KEY_LOOKUP");
    const secondaryKeys = [parseBase64Key(secondaryKeyValue, "ENCRYPTION_KEY_SECONDARY")];

    return new EncryptionManager(primaryKey, secondaryKeys, lookupKey);
  }

  isEncrypted(value: string): boolean {
    return value.startsWith(ENCRYPTION_PREFIX);
  }

  hash(plaintext: string): string {
    return deriveLookupHash(this.lookupKey, plaintext);
  }

  encrypt(plaintext: string): string {
    if (this.isEncrypted(plaintext)) {
      return plaintext;
    }

    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.primaryEncKey, iv);
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final()
    ]);
    const tag = cipher.getAuthTag();

    return `${ENCRYPTION_PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${ciphertext.toString("base64")}`;
  }

  private decryptWithKeys(payload: string, keys: Buffer[], { logFailure = true } = {}): string {
    if (!this.isEncrypted(payload)) {
      return payload;
    }

    const parts = payload.split(":");
    if (parts.length !== 5) {
      throw new Error("Invalid encrypted payload format.");
    }

    const iv = Buffer.from(parts[2], "base64");
    const tag = Buffer.from(parts[3], "base64");
    const ciphertext = Buffer.from(parts[4], "base64");

    for (const key of keys) {
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, iv);
        decipher.setAuthTag(tag);
        const plaintext = Buffer.concat([
          decipher.update(ciphertext),
          decipher.final()
        ]);
        return plaintext.toString("utf8");
      }
      catch {
        // Intentionally do not log per-key failures to avoid timing/log side-channels
        continue;
      }
    }
    if (logFailure) {
      logger.error("Unable to decrypt payload with available keys.");
    }
    throw new Error("Unable to decrypt payload with available keys.");
  }

  decrypt(payload: string): string {
    return this.decryptWithKeys(payload, this.decryptKeys);
  }

  decryptWithSecondary(payload: string): string {
    return this.decryptWithKeys(payload, this.secondaryEncKeys);
  }

  // for key rotation (decrypt() falls back to secondary): null when not under primary key, not logged
  decryptWithPrimaryOnly(payload: string): string | null {
    if (!this.isEncrypted(payload)) {
      return null;
    }
    try {
      return this.decryptWithKeys(payload, [this.primaryEncKey], { logFailure: false });
    }
    catch {
      return null;
    }
  }
}

export const encryptionManager = EncryptionManager.fromEnv();
