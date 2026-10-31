import { prisma } from "../config/prisma.js";
import { CACHE_KEY_PREFIXES, redisClient } from "../config/redis.js";
import logger from "../config/logger.js";
import fs from "fs/promises";
import path from "path";
import { FINAL_UPLOADS_DIR } from "../config/upload.js";
import { invalidateCache } from "../config/redis.js";
import socketIO from "../config/socket.js";
import { encryptionManager } from "./encryption.manager.js";

// value pending legal review
const RESOLVED_REPORT_RETENTION_DAYS = 180;

/**
 * Deletes class records that are older than 1 day and are TEST CLASSES
 */
export async function cleanupTestClasses(): Promise<void> {
  try {
    // Calculate the timestamp for 1 day ago (in milliseconds)
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;

    const classesToDelete = await prisma.class.findMany({
      where: {
        createdAt: {
          lt: oneDayAgo
        },
        isTestClass: true
      },
      select: {
        classId: true
      }
    });

    if (classesToDelete.length === 0) {
      logger.info("Test Class cleanup: No old test classes found to delete.");
      return;
    }

    const classIdsToDelete = classesToDelete.map(c => c.classId);

    // Delete physical files for each class
    for (const classId of classIdsToDelete) {
      const classDir = path.join(FINAL_UPLOADS_DIR, classId.toString());
      try {
        await fs.rm(classDir, { recursive: true, force: true });
        logger.info(`Deleted class directory: ${classDir}`);
      }
      catch (error) {
        logger.error(`Error deleting class directory ${classDir}: ${error}`);
        // Continue with database cleanup even if file deletion fails
      }
    }
    // delete classes, rest is deleted through CASCADE
    await prisma.class.deleteMany({
      where: {
        classId: {
          in: classIdsToDelete
        }
      }
    });
    // delete auth key for test classes
    await Promise.all(
      classIdsToDelete.map(classId =>
        redisClient.del(`auth_class:${classId}`)
      )
    );
    // delete redis data of test classes and sockets (invalidate cache)
    await Promise.all(
      classIdsToDelete.map(async classId => {
        await invalidateCache(CACHE_KEY_PREFIXES.UPLOADMETADATA, classId.toString());
        await invalidateCache(CACHE_KEY_PREFIXES.UPLOADREQUESTS, classId.toString());
        await invalidateCache(CACHE_KEY_PREFIXES.HOMEWORK, classId.toString());
        await invalidateCache(CACHE_KEY_PREFIXES.EVENT, classId.toString());
        await invalidateCache(CACHE_KEY_PREFIXES.LESSON, classId.toString());
        await invalidateCache(CACHE_KEY_PREFIXES.EVENTTYPESTYLE, classId.toString());
        await invalidateCache(CACHE_KEY_PREFIXES.SUBJECT, classId.toString());
        await invalidateCache(CACHE_KEY_PREFIXES.EVENTTYPE, classId.toString());
        await invalidateCache(CACHE_KEY_PREFIXES.TEAMS, classId.toString());
        // Make all sockets in the room leave it
        const room = `class:${classId}`;
        const io = socketIO.getIO();
        const sockets = await io.in(room).fetchSockets();
        sockets.forEach(socket => socket.leave(room));
      })
    );

    logger.info(`Test Class cleanup completed: ${classesToDelete.length} classes deleted (1d)`);
  }
  catch (error) {
    logger.error(`Error during test class cleanup: ${error}`);
  }
}

/**
 * Deletes deleted accounts records that are older than 30 days based on deletedAt date
 */
export async function cleanupDeletedAccounts(): Promise<void> {
  try {
    // Calculate the timestamp for 30 days ago (in milliseconds)
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;

    // Count records to be deleted
    const count = await prisma.account.count({
      where: {
        deletedAt: {
          lt: thirtyDaysAgo
        }
      }
    });

    // Delete the records
    const deleted = await prisma.account.deleteMany({
      where: {
        deletedAt: {
          lt: thirtyDaysAgo
        }
      }
    });

    logger.info(`Deleted accounts cleanup completed: ${deleted.count} records deleted out of ${count} found (30d)`);
  }
  catch (error) {
    logger.error(`Error during deleted account cleanup: ${error}`);
  }
}

// deletes resolved reports after RESOLVED_REPORT_RETENTION_DAYS and seen moderation notices after 30 days
export async function cleanupModerationRecords(): Promise<void> {
  try {
    const reportCutoff = Date.now() - RESOLVED_REPORT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;

    const deletedReports = await prisma.report.deleteMany({
      where: {
        status: "resolved",
        resolvedAt: {
          lt: reportCutoff
        }
      }
    });
    const deletedNotices = await prisma.moderationNotice.deleteMany({
      where: {
        seenAt: {
          lt: thirtyDaysAgo
        }
      }
    });

    logger.info(`Moderation cleanup completed: ${deletedReports.count} reports and ${deletedNotices.count} notices deleted`);
  }
  catch (error) {
    logger.error(`Error during moderation cleanup: ${error}`);
  }
}

/**
 * Deletes homework records that are older than 90 days based on submission date
 */
export async function cleanupOldHomework(): Promise<void> {
  try {
    // Calculate the timestamp for 90 days ago (in milliseconds)
    const ninetyDaysAgo = Date.now() - 90 * 24 * 60 * 60 * 1000;

    // Find classes that will be affected to invalidate their cache later
    const affectedClasses = await prisma.homework.findMany({
      where: {
        submissionDate: {
          lt: ninetyDaysAgo
        },
        isPinned: false
      },
      select: {
        classId: true
      },
      distinct: ["classId"]
    });

    // Count records to be deleted
    const count = await prisma.homework.count({
      where: {
        submissionDate: {
          lt: ninetyDaysAgo
        },
        isPinned: false
      }
    });

    // Delete the records
    const deleted = await prisma.homework.deleteMany({
      where: {
        submissionDate: {
          lt: ninetyDaysAgo
        },
        isPinned: false
      }
    });
    // invalidate homework cache of classes
    await Promise.all(affectedClasses.map(c => invalidateCache(CACHE_KEY_PREFIXES.HOMEWORK, c.classId.toString())));
    logger.info(`Homework cleanup completed: ${deleted.count} records deleted out of ${count} found (90d)`);
  }
  catch (error) {
    logger.error(`Error during homework cleanup: ${error}`);
  }
}


/**
 * Deletes event records that are older than 1 year based on start date
 */
export async function cleanupOldEvents(): Promise<void> {
  try {
    // Calculate the timestamp for 365 days ago (in milliseconds)
    const aYearAgo = Date.now() - 365 * 24 * 60 * 60 * 1000;

    // Find classes that will be affected to invalidate their cache later
    const affectedClasses = await prisma.event.findMany({
      where: {
        startDate: {
          lt: aYearAgo
        },
        isPinned: false
      },
      select: {
        classId: true
      },
      distinct: ["classId"]
    });


    // Count records to be deleted
    const count = await prisma.event.count({
      where: {
        startDate: {
          lt: aYearAgo
        },
        isPinned: false
      }
    });

    // Delete the records
    const deleted = await prisma.event.deleteMany({
      where: {
        startDate: {
          lt: aYearAgo
        },
        isPinned: false
      }
    });
    // invalidate event cache of classes
    await Promise.all(affectedClasses.map(c => invalidateCache(CACHE_KEY_PREFIXES.EVENT, c.classId.toString())));
    logger.info(`Event cleanup completed: ${deleted.count} records deleted out of ${count} found (365d)`);
  }
  catch (error) {
    logger.error(`Error during event cleanup: ${error}`);
  }
}


/**
 * Cleans up uploads stuck in "processing" status for more than 10 minutes
 * and releases their reserved storage
 */
export async function cleanupStuckUploads(): Promise<void> {
  try {
    // 10 minutes ago
    const tenMinutesAgo = Date.now() - 10 * 60 * 1000;

    const cleanedCount = await prisma.$transaction(async tx => {
      const stuckUploads = await tx.upload.findMany({
        where: {
          status: "processing",
          createdAt: {
            lt: tenMinutesAgo
          }
        },
        select: {
          uploadId: true,
          classId: true,
          reservedBytes: true
        }
      });

      if (stuckUploads.length === 0) {
        return 0;
      }

      const reservedByClass = new Map<number, bigint>();
      for (const upload of stuckUploads) {
        if (upload.reservedBytes <= 0n) {
          continue;
        }
        const current = reservedByClass.get(upload.classId) ?? 0n;
        reservedByClass.set(upload.classId, current + upload.reservedBytes);
      }

      const uploadIds = stuckUploads.map(upload => upload.uploadId);

      await tx.upload.updateMany({
        where: {
          uploadId: { in: uploadIds },
          status: "processing"
        },
        data: {
          status: "failed",
          errorReason: "processing_timeout",
          reservedBytes: 0n
        }
      });

      for (const [classId, reservedBytes] of reservedByClass.entries()) {
        await tx.class.update({
          where: { classId },
          data: { storageUsedBytes: { decrement: reservedBytes } }
        });
      }

      return uploadIds.length;
    });

    if (cleanedCount === 0) {
      logger.info("No stuck uploads found (10min)");
      return;
    }

    logger.info(`Cleaned up ${cleanedCount} stuck uploads (10min)`);
  }
  catch (error) {
    logger.error(`Error during stuck upload cleanup: ${error}`);
  }
}


/*
// DEMO CLASS MIGRATIONS
// The following functions are only invoked if a demo class is available (className = "Demo", classCode = "demo").
*/

/*
  * Moves upload metadata 1 week further along for demo class
*/
export async function migrateUploadMetadataDates(): Promise<void> {
  try {
    const oneWeekInMs = 7 * 24 * 60 * 60 * 1000;

    const demoCodeCandidates = ["demo", "Demo"].map(code =>
      encryptionManager.hash(code)
    );
    const demoClass = await prisma.class.findFirst({
      where: {
        OR: [
          { className: { equals: "Demo", mode: "insensitive" } },
          { classCodeHash: { in: demoCodeCandidates } },
          { classCode: { equals: "demo", mode: "insensitive" } }
        ]
      }
    });

    if (!demoClass) {
      logger.info("Demo class not found. Migration of dates for upload metadata not needed.");
      return;
    }

    const migratedUploadMetadata = await prisma.upload.updateMany({
      where: {
        classId: demoClass.classId
      },
      data: {
        createdAt: {
          increment: oneWeekInMs
        }
      }
    });

    // invalidate upload metadata cache of demo class
    await invalidateCache(CACHE_KEY_PREFIXES.UPLOADMETADATA, demoClass.classId.toString());
    logger.info(
      `Migrated dates of ${migratedUploadMetadata.count} upload metadata entries for demo class. (1 week)`
    );
  }
  catch (error) {
    logger.error(`Error during upload metadata migration: ${error}`);
  }
}

/*
  * Moves events and homework 1 week further along for demo class
*/
export async function migrateEventAndHomeworkDates(): Promise<void> {
  try {
    const oneWeekInMs = 7 * 24 * 60 * 60 * 1000;

    const demoCodeCandidates = ["demo", "Demo"].map(code =>
      encryptionManager.hash(code)
    );
    const demoClass = await prisma.class.findFirst({
      where: {
        OR: [
          { className: { equals: "Demo", mode: "insensitive" } },
          { classCodeHash: { in: demoCodeCandidates } },
          { classCode: { equals: "demo", mode: "insensitive" } }
        ]
      }
    });

    if (!demoClass) {
      logger.info("Demo class not found. Migration of dates for homework and events not needed.");
      return;
    }

    const [, migratedEvents, migratedHomework] = await prisma.$transaction([
      // Events:
      // case 1: startDate given, endDate null -> this event is all day
      // only move startDate one week along
      // case 2: startDate and endDAte are given -> event spans across multiple days
      // move startDate AND endDate along
      prisma.$executeRaw`
        UPDATE "event"
        SET
          "startDate" = "startDate" + ${oneWeekInMs},
          "endDate" = CASE
                        WHEN "endDate" IS NOT NULL THEN "endDate" + ${oneWeekInMs}
                        ELSE NULL
                      END
        WHERE "classId" = ${demoClass.classId}
      `,

      prisma.event.findMany({
        where: { classId: demoClass.classId }
      }),

      prisma.homework.updateMany({
        where: {
          classId: demoClass.classId
        },
        data: {
          assignmentDate: {
            increment: oneWeekInMs
          },
          submissionDate: {
            increment: oneWeekInMs
          }
        }
      })
    ]);
    // invalidate homework and event cache of demo class
    await invalidateCache(CACHE_KEY_PREFIXES.EVENT, demoClass.classId.toString());
    await invalidateCache(CACHE_KEY_PREFIXES.HOMEWORK, demoClass.classId.toString());
    logger.info(
      `Migrated dates of ${migratedEvents.length} events and ${migratedHomework.count} homework entries for demo class. (1 week)`
    );
  }
  catch (error) {
    logger.error(`Error during event and homework migration: ${error}`);
  }
}
