import { redisClient, CACHE_KEY_PREFIXES, generateCacheKey } from "../config/redis.js";
import { emitSocketToClass, SOCKET_EVENTS } from "../config/socket.js";
import { prisma } from "../config/prisma.js";
import { isValidTeamId, BigIntreplacer, isValidSubjectId, dateChecker } from "../utils/validate.functions.js";
import { updateCacheData, invalidateCache } from "../config/redis.js";
import { assertPermissionLevel, ROLES } from "../middleware/access.middleware.js";
import { Session, SessionData } from "express-session";
import { RequestError } from "../@types/requestError.js";
import logger from "../config/logger.js";
import {
  editHomeworkTypeParams,
  deleteHomeworkTypeParams,
  checkHomeworkTypeParams,
  pinHomeworkTypeParams,
  addHomeworkTypeBody,
  editHomeworkTypeBody,
  checkHomeworkTypeBody,
  pinHomeworkTypeBody
} from "../schemas/homework.schema.js";
import { Prisma } from "../prisma/generated/prisma/client.js";
import { flagBlockedAuthors } from "./block.service.js";

// personal (account-scoped) homework is not team-scoped; store this sentinel as teamId
const PERSONAL_TEAM_ID = -1;

const HOMEWORK_AUTHOR_KEYS = ["createdByAccountId", "lastEditedByAccountId"];

// canonical ordering used for both DB queries and the in-memory merge of the
// shared and personal cache partitions; compareHomework() must mirror this
const HOMEWORK_ORDER_BY: Prisma.HomeworkOrderByWithRelationInput[] = [
  { isPinned: "desc" },
  { submissionDate: "asc" },
  { assignmentDate: "asc" },
  { subjectId: "asc" },
  { content: "asc" }
];

// shape needed to re-sort cached rows after JSON round-trips bigints into strings
type SortableHomework = {
  isPinned: boolean;
  submissionDate: bigint | string | number;
  assignmentDate: bigint | string | number;
  subjectId: number;
  content: string;
  [key: string]: unknown;
};

// in-memory comparator mirroring HOMEWORK_ORDER_BY, used when merging the shared
// and personal partitions read from the cache into a single ordered list
function compareHomework(a: SortableHomework, b: SortableHomework): number {
  if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
  const subA = Number(a.submissionDate), subB = Number(b.submissionDate);
  if (subA !== subB) return subA - subB;
  const asgA = Number(a.assignmentDate), asgB = Number(b.assignmentDate);
  if (asgA !== asgB) return asgA - asgB;
  if (a.subjectId !== b.subjectId) return a.subjectId - b.subjectId;
  return String(a.content).localeCompare(String(b.content));
}

// read one cache partition (shared or a single account's personal homework);
// on a miss, query the matching subset, refresh the cache and return it
async function fetchHomeworkPartition(
  cacheKey: string,
  where: Prisma.HomeworkWhereInput
): Promise<SortableHomework[]> {
  const cached = await redisClient.get(cacheKey);
  if (cached) {
    try {
      return JSON.parse(cached);
    }
    catch (error) {
      logger.error(`Error parsing Redis data: ${error}`);
      // fall through to prevent crashes and rely on DB
    }
  }

  const data = await prisma.homework.findMany({ where, orderBy: HOMEWORK_ORDER_BY });
  await updateCacheData(data, cacheKey);
  return JSON.parse(JSON.stringify(data, BigIntreplacer));
}

// resolve owner + team scope for a create/edit and authorize accordingly:
// personal => requires a logged-in account (any member of the class);
// shared   => requires EDITOR permission and a valid team
async function resolveHomeworkScope(
  isPersonal: boolean,
  teamId: number,
  session: Session & Partial<SessionData>
): Promise<{ accountId: number | null; storedTeamId: number }> {
  if (isPersonal) {
    if (!session.account) {
      const err: RequestError = {
        name: "Unauthorized",
        status: 401,
        message: "An account is required to create or modify personal homework",
        expected: true
      };
      throw err;
    }
    // ensure the account actually belongs to this class (also repairs stale session state)
    await assertPermissionLevel(session, ROLES.MEMBER);
    return { accountId: session.account.accountId, storedTeamId: PERSONAL_TEAM_ID };
  }

  await assertPermissionLevel(session, ROLES.EDITOR);
  await isValidTeamId(teamId, session);
  return { accountId: null, storedTeamId: teamId };
}

// authorize a mutation (edit/delete/pin) on an existing row by its current ownership:
// personal items may only be touched by their owner; shared items require EDITOR
async function authorizeHomeworkMutation(
  ownerAccountId: number | null,
  session: Session & Partial<SessionData>
): Promise<void> {
  if (ownerAccountId !== null) {
    // 404 (not 403) so the existence of another user's personal item is not revealed
    if (!session.account || session.account.accountId !== ownerAccountId) {
      const err: RequestError = {
        name: "Not Found",
        status: 404,
        message: "Homework not found",
        expected: true
      };
      throw err;
    }
    return;
  }
  await assertPermissionLevel(session, ROLES.EDITOR);
}

// session-free removal, shared by deleteHomework and moderation
export async function removeHomework(homeworkId: number, classId: number, ownerAccountId: number | null): Promise<void> {
  await prisma.homework.deleteMany({
    where: {
      homeworkId: homeworkId,
      classId
    }
  });

  // invalidate cache
  await invalidateCache(CACHE_KEY_PREFIXES.HOMEWORK, classId.toString(), ownerAccountId?.toString());
  // send socket update
  emitSocketToClass(classId, SOCKET_EVENTS.HOMEWORK);
}

const homeworkService = {
  async addHomework(
    reqBody: addHomeworkTypeBody,
    session: Session & Partial<SessionData>
  ) {
    const { subjectId, content, assignmentDate, submissionDate, teamId, isPersonal } = reqBody;
    // always use classId instead of session.classId
    // since session.classId can change during concurrent requests
    const classId = parseInt(session.classId!, 10);
    dateChecker(assignmentDate, submissionDate);
    await isValidSubjectId(subjectId, session);
    // authorize + resolve owner/team for shared vs personal
    const { accountId, storedTeamId } = await resolveHomeworkScope(isPersonal, teamId, session);
    try {
      await prisma.homework.create({
        data: {
          classId,
          isPinned: false,
          content: content,
          subjectId: subjectId,
          assignmentDate: assignmentDate,
          submissionDate: submissionDate,
          teamId: storedTeamId,
          accountId: accountId,
          createdByAccountId: session.account?.accountId ?? null,
          createdAt: BigInt(Date.now())
        }
      });
    }
    catch (err) {
      if (err instanceof Prisma.PrismaClientValidationError) {
        const reqErr: RequestError = {
          name: "Bad Request",
          status: 400,
          message: "Invalid data format",
          expected: true
        };
        throw reqErr;
      }

      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2003") {
        const reqErr: RequestError = {
          name: "Bad Request",
          status: 400,
          message: "Invalid relation reference",
          expected: true
        };
        throw reqErr;
      }

      logger.error(`addHomework failed with unexpected database error: ${err}`);
      throw err;
    }

    // invalidate cache
    await invalidateCache(CACHE_KEY_PREFIXES.HOMEWORK, classId.toString(), accountId?.toString());
    // send socket update
    emitSocketToClass(classId, SOCKET_EVENTS.HOMEWORK);
  },

  async checkHomework(reqParams: checkHomeworkTypeParams, reqBody: checkHomeworkTypeBody, session: Session & Partial<SessionData>) {
    const { checkStatus } = reqBody;
    const { id: homeworkId } = reqParams;

    const accountId = session.account!.accountId;
    const classId = parseInt(session.classId!, 10);

    const homework = await prisma.homework.findFirst({
      where: { homeworkId, classId },
      select: { homeworkId: true, teamId: true, accountId: true }
    });

    if (!homework) {
      const err: RequestError = {
        name: "Not Found",
        status: 404,
        message: "Homework not found",
        expected: true
      };
      throw err;
    }

    // a personal homework can only be checked off by its owner (404 to avoid leaking it)
    if (homework.accountId !== null && homework.accountId !== accountId) {
      const err: RequestError = {
        name: "Not Found",
        status: 404,
        message: "Homework not found",
        expected: true
      };
      throw err;
    }

    // shared items keep the team-membership check (personal items use the -1 sentinel)
    if (homework.accountId === null) {
      await isValidTeamId(homework.teamId, session);
    }

    await prisma.$transaction(async tx => {
      if (checkStatus) {
        await tx.homeworkCheck.upsert({
          where: {
            accountId_homeworkId: { accountId, homeworkId }
          },
          create: {
            accountId,
            homeworkId,
            createdAt: BigInt(Date.now())
          },
          update: {} // no-op update
        });
      }
      else {
        await tx.homeworkCheck.deleteMany({
          where: { accountId, homeworkId }
        });
      }
    });

    emitSocketToClass(classId, SOCKET_EVENTS.HOMEWORK_CHECK);
  },

  async deleteHomework(reqParams: deleteHomeworkTypeParams, session: Session & Partial<SessionData>) {
    const { id: homeworkId } = reqParams;
    // always use classId instead of session.classId
    // since session.classId can change during concurrent requests
    const classId = parseInt(session.classId!, 10);

    const existing = await prisma.homework.findFirst({
      where: { homeworkId, classId },
      select: { accountId: true }
    });

    if (!existing) {
      const err: RequestError = {
        name: "Not Found",
        status: 404,
        message: "Homework not found",
        expected: true
      };
      throw err;
    }

    // owner may delete personal; editor may delete shared
    await authorizeHomeworkMutation(existing.accountId, session);

    await removeHomework(homeworkId, classId, existing.accountId);
  },

  // eslint-disable-next-line complexity
  async editHomework(
    reqParams: editHomeworkTypeParams,
    reqBody: editHomeworkTypeBody,
    session: Session & Partial<SessionData>
  ) {
    const { subjectId, content, assignmentDate, submissionDate, teamId, isPersonal } = reqBody;
    const { id: homeworkId } = reqParams;
    // always use classId instead of session.classId
    // since session.classId can change during concurrent requests
    const classId = parseInt(session.classId!, 10);
    dateChecker(assignmentDate, submissionDate);
    await isValidSubjectId(subjectId, session);

    // load current ownership to authorize the edit and know which caches to clean
    const existing = await prisma.homework.findFirst({
      where: { homeworkId, classId },
      select: { accountId: true }
    });

    if (!existing) {
      const err: RequestError = {
        name: "Not Found",
        status: 404,
        message: "Homework not found",
        expected: true
      };
      throw err;
    }

    // authorize against the CURRENT state (who may touch this row)
    await authorizeHomeworkMutation(existing.accountId, session);
    // authorize against the TARGET state and resolve the new owner/team (allows toggling)
    const { accountId: newAccountId, storedTeamId } = await resolveHomeworkScope(isPersonal, teamId, session);

    try {
      const updated = await prisma.homework.updateMany({
        where: {
          homeworkId: homeworkId,
          classId
        },
        data: {
          content: content,
          subjectId: subjectId,
          assignmentDate: assignmentDate,
          submissionDate: submissionDate,
          teamId: storedTeamId,
          accountId: newAccountId,
          lastEditedByAccountId: session.account?.accountId ?? null
        }
      });

      // if affected rows is 0 -> throw error
      if (updated.count === 0) {
        const err: RequestError = {
          name: "Not Found",
          status: 404,
          message: "Homework not found for update",
          expected: true
        };
        throw err;
      }
    }
    catch (err) {
      if ((err as RequestError)?.expected) throw err;

      if (err instanceof Prisma.PrismaClientValidationError) {
        const reqErr: RequestError = {
          name: "Bad Request",
          status: 400,
          message: "Invalid data format",
          expected: true
        };
        throw reqErr;
      }

      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2003") {
        const reqErr: RequestError = {
          name: "Bad Request",
          status: 400,
          message: "Invalid relation reference",
          expected: true
        };
        throw reqErr;
      }

      logger.error(`editHomework failed with unexpected database error: ${err}`);
      throw err;
    }

    // clean every partition this edit could have touched (old owner + new owner/shared)
    await invalidateCache(CACHE_KEY_PREFIXES.HOMEWORK, classId.toString(), existing.accountId?.toString());
    await invalidateCache(CACHE_KEY_PREFIXES.HOMEWORK, classId.toString(), newAccountId?.toString());
    // send socket update
    emitSocketToClass(classId, SOCKET_EVENTS.HOMEWORK);
  },

  async getHomeworkData(session: Session & Partial<SessionData>) {
    // always use classId instead of session.classId
    // since session.classId can change during concurrent requests
    const classId = parseInt(session.classId!, 10);
    const accountId = session.account?.accountId;

    // shared (team-scoped) homework, cached per class
    const sharedKey = generateCacheKey(CACHE_KEY_PREFIXES.HOMEWORK, session.classId!);
    const shared = await fetchHomeworkPartition(sharedKey, { classId, accountId: null });

    // anonymous / no-account viewers only ever see shared homework
    if (accountId === undefined) {
      return await flagBlockedAuthors(shared, HOMEWORK_AUTHOR_KEYS, session);
    }

    // this account's personal homework, cached per account
    const personalKey = generateCacheKey(CACHE_KEY_PREFIXES.HOMEWORK, session.classId!, accountId.toString());
    const personal = await fetchHomeworkPartition(personalKey, { classId, accountId });

    // merge the two partitions and re-sort to preserve the canonical order
    return await flagBlockedAuthors([...shared, ...personal].sort(compareHomework), HOMEWORK_AUTHOR_KEYS, session);
  },

  async pinHomework(reqParams: pinHomeworkTypeParams, reqBody: pinHomeworkTypeBody, session: Session & Partial<SessionData>) {
    // always use classId instead of session.classId
    // since session.classId can change during concurrent requests
    const classId = parseInt(session.classId!, 10);
    const { pinStatus } = reqBody;
    const { id: homeworkId } = reqParams;

    const existingHomework = await prisma.homework.findFirst({
      where: {
        homeworkId: homeworkId,
        classId
      },
      select: {
        teamId: true,
        accountId: true
      }
    });

    if (!existingHomework) {
      const err: RequestError = {
        name: "Not Found",
        status: 404,
        message: "Homework not found",
        expected: true
      };
      throw err;
    }

    // owner may pin personal items; editor may pin shared items
    await authorizeHomeworkMutation(existingHomework.accountId, session);
    if (existingHomework.accountId === null) {
      await isValidTeamId(existingHomework.teamId, session);
    }

    try {
      await prisma.homework.update({
        where: {
          homeworkId: homeworkId
        },
        data: {
          isPinned: pinStatus
        }
      });
    }
    catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
        const err: RequestError = {
          name: "Not Found",
          status: 404,
          message: "Homework not found",
          expected: true
        };
        throw err;
      }
      throw err;
    }

    await invalidateCache(CACHE_KEY_PREFIXES.HOMEWORK, classId.toString(), existingHomework.accountId?.toString());
    emitSocketToClass(classId, SOCKET_EVENTS.HOMEWORK);
  },

  async getHomeworkCheckedData(session: Session & Partial<SessionData>) {
    const accountId = session.account!.accountId;

    const homework = await prisma.homeworkCheck.findMany({
      where: { accountId: accountId },
      select: {
        homeworkId: true
      }
    });

    const homeworkIds = homework.map(homework => {
      return homework.homeworkId;
    });

    return homeworkIds;
  }
};

export default homeworkService;
