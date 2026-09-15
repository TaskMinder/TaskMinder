import session from "express-session";
import type { SessionData } from "express-session";
import logger from "./logger.js";
import { BigIntreplacer } from "../utils/validate.functions.js";

export const sessionTTLSeconds = 30 * 24 * 60 * 60; // 30 days

// express-session expects callback completion for each store operation
type Callback<T> = (err: Error | null, data?: T) => void;
export class RedisStore extends session.Store {
  // Redis client typing uses deeply nested generics (RedisClientType<...>) that cause
  // assignment failures when module paths resolve differently across files (known redis v4+ issue).
  // The actual runtime calls (.get, .set, .del, .expire) are safe, loosening to `any` here is intentional.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private client: any;
  private prefix: string;
  private defaultTTL: number;
  constructor(options: {
    // see explanation above
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client: any;
    prefix?: string;
    ttlSeconds?: number;
  }) {
    super();
    this.client = options.client;
    this.prefix = options.prefix ?? "sess:";
    this.defaultTTL = options.ttlSeconds ?? sessionTTLSeconds;
  }
  // Build the Redis key used for session payload storage.
  private key(sid: string): string {
    return `${this.prefix}${sid}`;
  }
  // Convert a stored Redis key back to sid, honoring custom prefixes.
  private sidFromSessionKey(sessionKey: string): string {
    if (sessionKey.startsWith(this.prefix)) {
      return sessionKey.slice(this.prefix.length);
    }
    return sessionKey;
  }
  // Reverse index key containing all session keys for one class.
  private classIndexKey(classId: string | number): string {
    return `class_sessions:${classId}`;
  }
  // Keep reverse index TTL bounded and in sync with active sessions.
  private async ensureClassIndexTTL(classId: string | number, ttlSeconds: number): Promise<void> {
    const indexKey = this.classIndexKey(classId);
    const desiredTTL = Math.max(ttlSeconds, this.defaultTTL);
    const currentTTL: number = await this.client.ttl(indexKey);

    if (currentTTL < desiredTTL) {
      await this.client.expire(indexKey, desiredTTL);
    }
  }
  // Session TTL follows cookie expiry; fallback to default if absent.
  private getTTL(sess: SessionData): number {
    const expires = sess.cookie?.expires;
    if (expires instanceof Date) {
      const ms: number = expires.getTime() - Date.now();
      return Math.max(Math.ceil(ms / 1000), 1);
    }
    return this.defaultTTL;
  }
  private formatStoreError(operation: string, err: unknown): Error {
    const error = err instanceof Error ? err : new Error("Unknown error");
    logger.error(`An error happened in the redis session store function ${operation}: ${error}`);
    return error;
  }
  private complete<T>(callback: Callback<T> | undefined, err: Error | null, data?: T): void {
    if (callback) {
      callback(err, data);
    }
  }
  // Load a session payload by sid.
  public async get(
    sid: string,
    callback: Callback<SessionData | null>
  ): Promise<void> {
    try {
      const data: string | null = await this.client.get(this.key(sid));
      if (data === null) {
        callback(null, null);
        return;
      }
      const parsed: SessionData = JSON.parse(data) as SessionData;
      callback(null, parsed);
    }
    catch (err: unknown) {
      this.complete(callback, this.formatStoreError("get", err));
    }
  }
  // Persist session payload and maintain class reverse index membership.
  public async set(
    sid: string,
    sess: SessionData,
    callback?: Callback<void>
  ): Promise<void> {
    try {
      const ttl: number = this.getTTL(sess);
      const sessionKey = this.key(sid);
      const previousRaw = await this.client.get(sessionKey);
      if (previousRaw) {
        const previousSession = JSON.parse(previousRaw) as SessionData;
        if (previousSession.classId && previousSession.classId !== sess.classId) {
          await this.removeClassSessionKey(previousSession.classId, sessionKey);
        }
      }
      await this.client.set(
        sessionKey,
        JSON.stringify(sess, BigIntreplacer),
        { EX: ttl }
      );
      // Maintain reverse index if session is associated with a class
      if (sess.classId) {
        await this.client.sAdd(this.classIndexKey(sess.classId), sessionKey);
        await this.ensureClassIndexTTL(sess.classId, ttl);
      }
      this.complete(callback, null);
    }
    catch (err: unknown) {
      this.complete(callback, this.formatStoreError("set", err));
    }
  }
  // Remove session payload and reverse-index membership.
  public async destroy(
    sid: string,
    callback?: Callback<void>
  ): Promise<void> {
    try {
      const sessionKey = this.key(sid);
      // Read before delete to know which class reverse index to clean.
      const raw = await this.client.get(sessionKey);
      if (raw) {
        const sess = JSON.parse(raw) as SessionData;
        if (sess.classId) {
          await this.removeClassSessionKey(sess.classId, sessionKey);
        }
      }
      await this.client.del(sessionKey);
      this.complete(callback, null);
    }
    catch (err: unknown) {
      this.complete(callback, this.formatStoreError("destroy", err));
    }
  }
  // Refresh primary session TTL and keep reverse index alive for rolling sessions.
  public async touch(
    sid: string,
    sess: SessionData,
    callback?: Callback<void>
  ): Promise<void> {
    try {
      const ttl: number = this.getTTL(sess);
      await this.client.expire(this.key(sid), ttl);
      if (sess.classId) {
        await this.ensureClassIndexTTL(sess.classId, ttl);
      }
      this.complete(callback, null);
    }
    catch (err: unknown) {
      this.complete(callback, this.formatStoreError("touch", err));
    }
  }
  // Return only currently live session keys and lazily prune stale index members.
  public async getClassSessionKeys(classId: string | number): Promise<string[]> {
    const sessionKeys = await this.client.sMembers(this.classIndexKey(classId));
    const liveSessionKeys: string[] = [];

    for (const sessionKey of sessionKeys) {
      const exists = await this.client.exists(sessionKey);
      if (exists) {
        liveSessionKeys.push(sessionKey);
        continue;
      }
      await this.removeClassSessionKey(classId, sessionKey);
    }

    return liveSessionKeys;
  }
  // Public helper used by class cleanup flow.
  public async removeClassSessionKey(classId: string | number, sessionKey: string): Promise<void> {
    await this.client.sRem(this.classIndexKey(classId), sessionKey);
  }
  // Convenience helper when callers hold full Redis keys instead of sids.
  public async destroyBySessionKey(sessionKey: string, callback?: Callback<void>): Promise<void> {
    await this.destroy(this.sidFromSessionKey(sessionKey), callback);
  }
}