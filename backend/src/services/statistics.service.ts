import { prisma } from "../config/prisma.js";
import { redisClient, STATISTICS_CACHE_KEY, statisticsCacheExpiration } from "../config/redis.js";
import logger from "../config/logger.js";
import { BigIntreplacer } from "../utils/validate.functions.js";

export type Statistics = {
  registeredClasses: number;
  registeredUsers: number;
  createdHomework: number;
  createdEvents: number;
  createdHomeworkAndEvents: number;
};

async function getStatistics(): Promise<Statistics> {
  const cached = await redisClient.get(STATISTICS_CACHE_KEY).catch(err => {
    logger.error(`Error reading Redis ${STATISTICS_CACHE_KEY} cache: ${err}`);
    return null;
  });

  if (cached) {
    try {
      return JSON.parse(cached) as Statistics;
    }
    catch (error) {
      logger.error(`Error parsing Redis ${STATISTICS_CACHE_KEY} cache: ${error}`);
      // fall through to prevent crashes and rely on DB
    }
  }

  const [registeredClasses, registeredUsers, createdHomework, createdEvents] = await prisma.$transaction([
    prisma.class.count({
      where: { isTestClass: false }
    }),
    prisma.account.aggregate({
      _max: { accountId: true }
    }),
    prisma.homework.aggregate({
      _max: { homeworkId: true }
    }),
    prisma.event.aggregate({
      _max: { eventId: true }
    })
  ]).then(([classes, accounts, homework, events]) => [
    classes,
    accounts._max.accountId ?? 0,
    homework._max.homeworkId ?? 0,
    events._max.eventId ?? 0
  ]);

  const statistics: Statistics = {
    registeredClasses,
    registeredUsers,
    createdHomework,
    createdEvents,
    createdHomeworkAndEvents: createdHomework + createdEvents
  };

  try {
    await redisClient.set(STATISTICS_CACHE_KEY, JSON.stringify(statistics, BigIntreplacer),
      { expiration: { type: "EX", value: statisticsCacheExpiration } });
  }
  catch (err) {
    logger.error(`Error updating Redis ${STATISTICS_CACHE_KEY} cache: ${err}`);
  }

  return statistics;
}

export default {
  getStatistics
};
