import { createClient } from "redis";
import logger from "../config/logger.js";
import { RedisStore } from "./redis.session.js";
import { envConfig } from "./env.js";
import { BigIntreplacer } from "../utils/validate.functions.js";

export const CACHE_KEY_PREFIXES = {
  HOMEWORK: "homework_data",
  EVENT: "event_data",
  SUBSTITUTIONS: "substitutions_data",
  LESSON: "lesson_data",
  EVENTTYPE: "event_type_data",
  EVENTTYPESTYLE: "event_type_styles",
  SUBJECT: "subject_data",
  TEAMS: "teams_data",
  UPLOADMETADATA: "upload_metadata",
  UPLOADREQUESTS: "upload_requests",
  STATISTICS: "site_statistics"
} as const;

export const QUEUE_KEYS = {
  FILE_PROCESSING: "file_processing_queue"
};

export type CacheKeyPrefix =
  (typeof CACHE_KEY_PREFIXES)[keyof typeof CACHE_KEY_PREFIXES];

// when accountId is provided the key addresses an account's personal cache partition
// (e.g. personal homework/events); without it the key addresses the shared class partition
export const generateCacheKey = (baseKey: CacheKeyPrefix, classId: string, accountId?: string): string => {
  if (!baseKey || !classId) {
    logger.error("Base Key or/and ClassId missing to generate redis cache key");
    throw new Error("Missing baseKey or classId for cache key generation");
  }
  const baseCacheKey = `cache:${baseKey}:${classId}`;
  return accountId ? `${baseCacheKey}:acc:${accountId}` : baseCacheKey;
};

export async function updateCacheData<T>(data: T[], key: string): Promise<void> {
  try {
    await redisClient.set(key, JSON.stringify(data, BigIntreplacer),
      { expiration: { type: "EX", value: cacheExpiration } });
  }
  catch (err) {
    logger.error(`Error updating Redis ${key} cache: ${err}`);
  }
}

// invalidate the partition a write touched: shared class cache when accountId is
// null, otherwise only affected account's personal cache
export async function invalidateCache(
  prefix: CacheKeyPrefix,
  classId: string,
  accountId?: string
): Promise<void> {
  // accountId targets a single account's personal partition; omitting it targets the shared partition
  const cacheKey = generateCacheKey(prefix, classId, accountId);
  try {
    await redisClient.del(cacheKey);
  }
  catch (err) {
    logger.error(`Error invalidating cache for ${cacheKey}: ${err}`);
  }
};

// standard cache expiration (60 min)
export const cacheExpiration = 3600;

// site-wide statistics cache expiration (5 min); matches the /stats
// Cache-Control max-age so server and client staleness line up
export const statisticsCacheExpiration = 300;

// site statistics is a single global key
export const STATISTICS_CACHE_KEY = `cache:${CACHE_KEY_PREFIXES.STATISTICS}`;

const redisHost = envConfig.nodeEnv === "DEVELOPMENT" ? "localhost" : "redis";
const redisUrl = `redis://${redisHost}:6379`;

export const redisClient = createClient({
  url: redisUrl
});
redisClient.on("error", (err: unknown) =>
  err instanceof Error ? logger.error(`Redis error: ${err}`) : logger.error("Unknown Redis error!")
);

// session store for express-session
export const redisStore = new RedisStore({
  client: redisClient,
  prefix: "sess:",
  ttlSeconds: 30 * 24 * 60 * 60 // 30 days
});

export const connectRedis = async (): Promise<void> => {
  try {
    if (!redisClient.isOpen) {
      await redisClient.connect();
      logger.info("Connected to Redis");
    }
  }
  catch (err: unknown) {
    if (err instanceof Error) {
      logger.error(`Error connecting to Redis: ${err}`);
      throw new Error("Redis connection failed", { cause: err });
    }
    logger.error("Unknown error connecting to Redis!");
    throw new Error("Redis connection failed", { cause: err });
  }
};

export const disconnectRedis = async (): Promise<void> => {
  try {
    if (redisClient.isOpen) {
      await redisClient.quit();
      logger.info("Disconnected from Redis");
    }
  }
  catch (err: unknown) {
    if (err instanceof Error) {
      logger.error(`Error disconnecting from Redis: ${err}`);
      throw new Error("Redis disconnect failed", { cause: err });
    }
    logger.error("Unknown error disconnecting from Redis!");
    throw new Error("Redis disconnect failed", { cause: err });
  }
};

export const queueJob = async (queueKey: string, jobData: unknown): Promise<void> => {
  await redisClient.lPush(queueKey, JSON.stringify(jobData, BigIntreplacer));
};

export const dequeueJob = async (queueKey: string): Promise<unknown | null> => {
  const job = await redisClient.rPop(queueKey);
  return job ? JSON.parse(job) : null;
};

export const getQueueLength = async (queueKey: string): Promise<number> => {
  return await redisClient.lLen(queueKey);
};
