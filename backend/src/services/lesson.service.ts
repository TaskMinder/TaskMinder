import { CACHE_KEY_PREFIXES, generateCacheKey, redisClient } from "../config/redis.js";
import { prisma } from "../config/prisma.js";
import logger from "../config/logger.js";
import { BigIntreplacer, isValidTeamId, isValidSubjectId, dateChecker } from "../utils/validate.functions.js";
import { updateCacheData, invalidateCache } from "../config/redis.js";
import { Session, SessionData } from "express-session";
import { setLessonDataTypeBody } from "../schemas/lesson.schema.js";
import { emitSocketToClass, SOCKET_EVENTS } from "../config/socket.js";
import { Prisma } from "../prisma/generated/prisma/client.js";
import { RequestError } from "../@types/requestError.js";

const lessonService = {
  async setLessonData(
    reqData: setLessonDataTypeBody,
    session: Session & Partial<SessionData>
  ) {
    const { lessons } = reqData;
    for (const lesson of lessons) {
      dateChecker(lesson.startTime, lesson.endTime);
      await isValidTeamId(lesson.teamId, session);
      await isValidSubjectId(lesson.subjectId, session);
    }

    const classId = parseInt(session.classId!, 10);

    // Check if data actually changed
    const existingLessons = await prisma.lesson.findMany({
      where: { classId }
    });

    // Compare existing and new lessons
    const dataChanged = existingLessons.length !== lessons.length ||
      existingLessons.some(existing => {
        const matching = lessons.find(l =>
          l.lessonNumber === existing.lessonNumber &&
          l.weekDay === existing.weekDay
        );
        return !matching ||
          matching.teamId !== existing.teamId ||
          matching.subjectId !== existing.subjectId ||
          matching.room !== existing.room ||
          matching.startTime !== Number(existing.startTime) ||
          matching.endTime !== Number(existing.endTime);
      });

    try {
      await prisma.$transaction(async tx => {
        await tx.lesson.deleteMany({
          where: {
            classId
          }
        });

        for (const lesson of lessons) {
          await tx.lesson.create({
            data: {
              classId,
              lessonNumber: lesson.lessonNumber,
              weekDay: lesson.weekDay as 0 | 1 | 2 | 3 | 4,
              teamId: lesson.teamId,
              subjectId: lesson.subjectId,
              room: lesson.room,
              startTime: lesson.startTime,
              endTime: lesson.endTime,
              createdAt: BigInt(Date.now())
            }
          });
        }
      });
    } 
    catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        const reqErr: RequestError = {
          name: "Conflict",
          status: 409,
          message: "Duplicate lesson: two lessons share the same weekDay, lessonNumber, subjectId and teamId",
          expected: true
        };
        throw reqErr;
      }
      
      logger.error(`setLessonData failed with unexpected database error: ${err}`);
      throw err;
    }

    if (dataChanged) {
      await invalidateCache(CACHE_KEY_PREFIXES.LESSON, classId.toString());
      emitSocketToClass(classId, SOCKET_EVENTS.TIMETABLES);
      logger.info(`Lesson data changed for class: ${classId}`);
    }
  },
  async getLessonData(session: Session & Partial<SessionData>) {
    const classId = parseInt(session.classId!, 10);
    const getLessonDataCacheKey = generateCacheKey(CACHE_KEY_PREFIXES.LESSON, session.classId!);
    const cachedLessonData = await redisClient.get(getLessonDataCacheKey);

    if (cachedLessonData) {
      try {
        return JSON.parse(cachedLessonData);
      }
      catch (error) {
        logger.error(`Error parsing Redis cache: ${error}`);
        // fall through to prevent crashes and rely on DB
      }
    }

    const lessonData = await prisma.lesson.findMany({
      where: {
        classId
      },
      orderBy: {
        lessonNumber: "asc"
      }
    });


    try {
      await updateCacheData(lessonData, getLessonDataCacheKey);
    }
    catch (err) {
      logger.error(`Error updating Redis cache: ${err}`);
      // fall through to prevent crashes and rely on DB
    }

    const stringified = JSON.stringify(lessonData, BigIntreplacer);
    return JSON.parse(stringified);
  }
};

export default lessonService;
