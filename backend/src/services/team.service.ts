import { Session, SessionData } from "express-session";
import { RequestError } from "../@types/requestError.js";
import { prisma } from "../config/prisma.js";
import logger from "../config/logger.js";
import { CACHE_KEY_PREFIXES, generateCacheKey, redisClient } from "../config/redis.js";
import { BigIntreplacer, isValidTeamId } from "../utils/validate.functions.js";
import { invalidateCache, updateCacheData } from "../config/redis.js";
import { setJoinedTeamsTypeBody, setTeamsTypeBody } from "../schemas/team.schema.js";
import fs from "fs/promises";
import path from "path";
import { FINAL_UPLOADS_DIR } from "../config/upload.js";
import { emitSocketToClass, SOCKET_EVENTS } from "../config/socket.js";

const teamService = {
  async getTeamsData(session: Session & Partial<SessionData>) {
    const classId = parseInt(session.classId!, 10);
    const getTeamsDataCacheKey = generateCacheKey(CACHE_KEY_PREFIXES.TEAMS, session.classId!);
    const cachedTeamsData = await redisClient.get(getTeamsDataCacheKey);

    if (cachedTeamsData) {
      try {
        return JSON.parse(cachedTeamsData);
      }
      catch (error) {
        logger.error(`Error parsing Redis data: ${error}`);
        // fall through to prevent crashes and rely on DB
      }
    }

    const data = await prisma.team.findMany({
      where: {
        classId
      },
      orderBy: {
        name: "asc"
      }
    });

    try {
      await updateCacheData(data, getTeamsDataCacheKey);
    }
    catch (err) {
      logger.error(`Error updating Redis data: ${err}`);
      // fall through to prevent crashes and rely on DB
    }

    const stringified = JSON.stringify(data, BigIntreplacer);
    return JSON.parse(stringified);
  },

  async setTeamsData(reqData: setTeamsTypeBody, session: Session & Partial<SessionData>) {
    const { teams } = reqData;
    const classId = parseInt(session.classId!, 10);
    const classDir = path.join(FINAL_UPLOADS_DIR, classId.toString());
    // variable to check if cache should be reloaded (e.g. on team deletion)
    let dataChanged = false;
    // track if teams were deleted (affects homework, events, lessons, upload (requests))
    let teamsDeleted = false;
    const filesToDelete: string[] = [];

    // Check for duplicate team names
    const teamNames = teams.map(t => t.name.trim().toLowerCase());
    const uniqueNames = new Set(teamNames);
    if (teamNames.length !== uniqueNames.size) {
      const err: RequestError = {
        name: "Bad Request",
        status: 400,
        message: "Duplicate team names are not allowed",
        expected: true
      };
      throw err;
    }

    const existingTeams = await prisma.team.findMany({
      where: {
        classId
      }
    });

    // eslint-disable-next-line complexity
    await prisma.$transaction(async tx => {
      for (const team of existingTeams) {
        if (!teams.some(t => t.teamId === team.teamId)) {
          dataChanged = true;
          teamsDeleted = true;
          // Read uploads for size accounting and deferred filesystem cleanup
          const uploads = await tx.upload.findMany({
            where: { teamId: team.teamId, classId: classId },
            include: { Files: true }
          });

          for (const upload of uploads) {
            for (const file of upload.Files) {
              filesToDelete.push(file.storedFileName);
            }

            const sizeToRelease = upload.status === "completed"
              ? BigInt(upload.Files.reduce((sum, file) => sum + file.size, 0))
              : upload.reservedBytes;

            if (sizeToRelease > 0n) {
              await tx.class.update({
                where: { classId },
                data: { storageUsedBytes: { decrement: sizeToRelease } }
              });
            }
          }

          // Delete upload records (FileMetadata rows cascade via FK)
          await tx.upload.deleteMany({
            where: { teamId: team.teamId, classId: classId }
          });

          // Delete upload requests which were linked to team
          await tx.uploadRequest.deleteMany({
            where: { teamId: team.teamId, classId: classId }
          });

          // delete homework which were linked to team
          await tx.homework.deleteMany({
            where: { teamId: team.teamId, classId: classId }
          });
          // delete events which were linked to team
          await tx.event.deleteMany({
            where: { teamId: team.teamId, classId: classId }
          });
          // delete lessons which were linked to team
          await tx.lesson.deleteMany({
            where: { teamId: team.teamId, classId: classId }
          });
          // delete joined teams (team memberships) - already done with cascade, but here explicitly again
          await tx.joinedTeams.deleteMany({
            where: { teamId: team.teamId }
          });
          // delete team
          await tx.team.delete({
            where: { teamId: team.teamId, classId: classId }
          });
        }
      }

      for (const team of teams) {
        if (team.teamId === "") {
          dataChanged = true;
          await tx.team.create({
            data: {
              classId,
              name: team.name,
              createdAt: BigInt(Date.now())
            }
          });
        }
        else {
          // Check if name actually changed
          const existingTeam = existingTeams.find(t => t.teamId === team.teamId);
          if (!existingTeam || existingTeam.name !== team.name) {
            dataChanged = true;
          }
          const updated = await tx.team.updateMany({
            where: { teamId: team.teamId, classId: classId },
            data: {
              name: team.name
            }
          });

          if (updated.count === 0) {
            const err: RequestError = {
              name: "Not Found",
              status: 404,
              message: "Team not found for update",
              expected: true
            };
            throw err;
          }
        }
      }
    });

    if (filesToDelete.length > 0) {
      await Promise.all(
        filesToDelete.map(async storedFileName => {
          const filePath = path.join(classDir, storedFileName);
          await fs.unlink(filePath).catch(error => {
            logger.error(`File could not be deleted during team deletion, path: ${filePath}, error: ${error}`);
          });
        })
      );
    }

    if (dataChanged) {
      // invalidate team cache and resend sockets
      await invalidateCache(CACHE_KEY_PREFIXES.TEAMS, classId.toString());
      emitSocketToClass(classId, SOCKET_EVENTS.TEAMS);
      emitSocketToClass(classId, SOCKET_EVENTS.JOINED_TEAMS);

      // If teams were deleted, also update homework, events, lesson and upload (request) caches and resend sockets
      if (teamsDeleted) {
        await invalidateCache(CACHE_KEY_PREFIXES.HOMEWORK, classId.toString());
        await invalidateCache(CACHE_KEY_PREFIXES.EVENT, classId.toString());
        await invalidateCache(CACHE_KEY_PREFIXES.LESSON, classId.toString());
        await invalidateCache(CACHE_KEY_PREFIXES.UPLOADMETADATA, classId.toString());
        await invalidateCache(CACHE_KEY_PREFIXES.UPLOADREQUESTS, classId.toString());

        emitSocketToClass(classId, SOCKET_EVENTS.HOMEWORK);
        emitSocketToClass(classId, SOCKET_EVENTS.EVENTS);
        emitSocketToClass(classId, SOCKET_EVENTS.TIMETABLES);
        emitSocketToClass(classId, SOCKET_EVENTS.UPLOADS);
        emitSocketToClass(classId, SOCKET_EVENTS.UPLOAD_REQUESTS);
      }
      logger.info(`teams data changed for class: ${classId}`);
    }
  },

  async getJoinedTeamsData(session: Session & Partial<SessionData>) {
    const accountId = session.account!.accountId;

    const data = await prisma.joinedTeams.findMany({
      where: { accountId: accountId }
    });

    const teams = [];

    for (const entry of data) {
      teams.push(entry.teamId);
    }

    return teams;
  },

  async setJoinedTeamsData(reqData: setJoinedTeamsTypeBody, session: Session & Partial<SessionData>) {
    const { teams } = reqData;
    const accountId = session.account!.accountId;
    const classId = parseInt(session.classId!, 10);

    await prisma.$transaction(async tx => {
      await tx.joinedTeams.deleteMany({
        where: { accountId: accountId }
      });

      for (const teamId of teams) {
        await isValidTeamId(teamId, session);
        await tx.joinedTeams.create({
          data: {
            teamId: teamId,
            accountId: accountId,
            createdAt: BigInt(Date.now())
          }
        });
      }
    });
    // send socket update to clients
    emitSocketToClass(classId, SOCKET_EVENTS.JOINED_TEAMS);
  }
};

export default teamService;
