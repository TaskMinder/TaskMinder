import logger from "../config/logger.js";
import { redisClient, cacheExpiration, CACHE_KEY_PREFIXES, generateCacheKey } from "../config/redis.js";
import { emitSocketToClass, SOCKET_EVENTS } from "../config/socket.js";
import * as sass from "sass";
import { prisma } from "../config/prisma.js";
import {
  isValidColor,
  isValidTeamId,
  lessonDateEventAtLeastOneNull,
  BigIntreplacer,
  isValidEventTypeId,
  dateChecker
} from "../utils/validate.functions.js";
import { invalidateCache, updateCacheData } from "../config/redis.js";
import { assertPermissionLevel, ROLES } from "../middleware/access.middleware.js";
import { Session, SessionData } from "express-session";
import { RequestError } from "../@types/requestError.js";
import {
  editEventTypeParams,
  deleteEventTypeParams,
  pinEventTypeParams,
  addEventTypeBody,
  editEventTypeBody,
  setEventTypesTypeBody,
  pinEventTypeBody
} from "../schemas/event.schema.js";
import { Prisma } from "../prisma/generated/prisma/client.js";
import { flagBlockedAuthors } from "./block.service.js";

const inFlightStyleBuild = new Map<number, Promise<string>>();

// personal (account-scoped) events are not team-scoped; store this sentinel as teamId
const PERSONAL_TEAM_ID = -1;

const EVENT_AUTHOR_KEYS = ["createdByAccountId", "lastEditedByAccountId"];

// canonical ordering used for both DB queries and the in-memory merge of the
// shared and personal cache partitions; compareEvent() must mirror this
const EVENT_ORDER_BY: Prisma.EventOrderByWithRelationInput[] = [
  { isPinned: "desc" },
  { startDate: "asc" },
  { endDate: "asc" },
  { name: "asc" },
  { description: "asc" }
];

// shape needed to re-sort cached rows after JSON round-trips bigints into strings
type SortableEvent = {
  isPinned: boolean;
  startDate: bigint | string | number;
  endDate: bigint | string | number | null;
  name: string;
  description: string | null;
  [key: string]: unknown;
};

// in-memory comparator mirroring EVENT_ORDER_BY, used when merging the shared
// and personal partitions read from the cache into a single ordered list
// (nullable endDate/description sort last, matching Postgres NULLS LAST on ASC)
function compareEvent(a: SortableEvent, b: SortableEvent): number {
  if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
  const startA = Number(a.startDate), startB = Number(b.startDate);
  if (startA !== startB) return startA - startB;
  const endA = a.endDate === null ? Infinity : Number(a.endDate);
  const endB = b.endDate === null ? Infinity : Number(b.endDate);
  if (endA !== endB) return endA - endB;
  if (a.name !== b.name) return String(a.name).localeCompare(String(b.name));
  const descA = a.description === null ? null : String(a.description);
  const descB = b.description === null ? null : String(b.description);
  if (descA === descB) return 0;
  if (descA === null) return 1;
  if (descB === null) return -1;
  return descA.localeCompare(descB);
}

// read one cache partition (shared or a single account's personal events);
// on a miss, query the matching subset, refresh the cache and return it
async function fetchEventPartition(
  cacheKey: string,
  where: Prisma.EventWhereInput
): Promise<SortableEvent[]> {
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

  const data = await prisma.event.findMany({ where, orderBy: EVENT_ORDER_BY });
  try {
    await updateCacheData(data, cacheKey);
  }
  catch (err) {
    logger.error(`Error updating Redis cache: ${err}`);
    // fall through to prevent crashes and rely on DB
  }
  return JSON.parse(JSON.stringify(data, BigIntreplacer));
}

// resolve owner + team scope for a create/edit and authorize accordingly:
// personal => requires a logged-in account (any member of the class);
// shared   => requires EDITOR permission and a valid team
async function resolveEventScope(
  isPersonal: boolean,
  teamId: number,
  session: Session & Partial<SessionData>
): Promise<{ accountId: number | null; storedTeamId: number }> {
  if (isPersonal) {
    if (!session.account) {
      const err: RequestError = {
        name: "Unauthorized",
        status: 401,
        message: "An account is required to create or modify personal events",
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
async function authorizeEventMutation(
  ownerAccountId: number | null,
  session: Session & Partial<SessionData>
): Promise<void> {
  if (ownerAccountId !== null) {
    // 404 (not 403) so the existence of another user's personal item is not revealed
    if (!session.account || session.account.accountId !== ownerAccountId) {
      const err: RequestError = {
        name: "Not Found",
        status: 404,
        message: "Event not found",
        expected: true
      };
      throw err;
    }
    return;
  }
  await assertPermissionLevel(session, ROLES.EDITOR);
}

// session-free removal, shared by deleteEvent and moderation
export async function removeEvent(eventId: number, classId: number, ownerAccountId: number | null): Promise<void> {
  await prisma.event.deleteMany({
    where: {
      eventId: eventId,
      classId
    }
  });

  // invalidate cache
  await invalidateCache(CACHE_KEY_PREFIXES.EVENT, classId.toString(), ownerAccountId?.toString());
  // send socket event
  emitSocketToClass(classId, SOCKET_EVENTS.EVENTS);
}

export const eventService = {
  async getEventData(session: Session & Partial<SessionData>) {
    // always use classId instead of session.classId (session.classId can change during concurrent requests)
    const classId = parseInt(session.classId!, 10);
    const accountId = session.account?.accountId;

    // shared (team-scoped) events, cached per class
    const sharedKey = generateCacheKey(CACHE_KEY_PREFIXES.EVENT, session.classId!);
    const shared = await fetchEventPartition(sharedKey, { classId, accountId: null });

    // anonymous / no-account viewers only ever see shared events
    if (accountId === undefined) {
      return await flagBlockedAuthors(shared, EVENT_AUTHOR_KEYS, session);
    }

    // this account's personal events, cached per account
    const personalKey = generateCacheKey(CACHE_KEY_PREFIXES.EVENT, session.classId!, accountId.toString());
    const personal = await fetchEventPartition(personalKey, { classId, accountId });

    // merge the two partitions and re-sort to preserve canonical order
    return await flagBlockedAuthors([...shared, ...personal].sort(compareEvent), EVENT_AUTHOR_KEYS, session);
  },

  async pinEvent(reqParams: pinEventTypeParams, reqBody: pinEventTypeBody, session: Session & Partial<SessionData>) {
    const { pinStatus } = reqBody;
    const { id: eventId } = reqParams;
    // always use classId instead of session.classId
    // since session.classId can change during concurrent requests
    const classId = parseInt(session.classId!, 10);
    const existingEvent = await prisma.event.findFirst({
      where: {
        eventId,
        classId
      },
      select: {
        teamId: true,
        accountId: true
      }
    });

    if (!existingEvent) {
      const err: RequestError = {
        name: "Not Found",
        status: 404,
        message: "Event not found",
        expected: true
      };
      throw err;
    }

    // owner may pin personal items; editor may pin shared items
    await authorizeEventMutation(existingEvent.accountId, session);
    if (existingEvent.accountId === null) {
      await isValidTeamId(existingEvent.teamId, session);
    }

    try {
      await prisma.event.update({
        where: {
          eventId: eventId
        },
        data: {
          isPinned: pinStatus
        }
      });
    }
    catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
        const reqErr: RequestError = {
          name: "Not Found",
          status: 404,
          message: "Event not found",
          expected: true
        };
        throw reqErr;
      }
      throw err;
    }

    await invalidateCache(CACHE_KEY_PREFIXES.EVENT, classId.toString(), existingEvent.accountId?.toString());
    emitSocketToClass(classId, SOCKET_EVENTS.EVENTS);
  },

  async addEvent(
    reqBody: addEventTypeBody,
    session: Session & Partial<SessionData>
  ) {
    const { eventTypeId, name, description, startDate, lesson, endDate, teamId, isPersonal } = reqBody;
    // always use classId instead of session.classId
    // since session.classId can change during concurrent requests
    const classId = parseInt(session.classId!, 10);
    if (endDate) {
      dateChecker(startDate, endDate);
    }
    lessonDateEventAtLeastOneNull(endDate, lesson);
    await isValidEventTypeId(eventTypeId, session);
    // authorize + resolve owner/team for shared vs personal
    const { accountId, storedTeamId } = await resolveEventScope(isPersonal, teamId, session);
    try {
      await prisma.event.create({
        data: {
          eventTypeId: eventTypeId,
          classId,
          isPinned: false,
          name: name,
          description: description,
          startDate: startDate,
          lesson: lesson,
          endDate: endDate,
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

      logger.error(`addEvent failed with unexpected database error: ${err}`);
      throw err;
    }

    // invalidate cache
    await invalidateCache(CACHE_KEY_PREFIXES.EVENT, classId.toString(), accountId?.toString());
    // send socket event
    emitSocketToClass(classId, SOCKET_EVENTS.EVENTS);
  },

  // eslint-disable-next-line complexity
  async editEvent(
    reqParams: editEventTypeParams,
    reqBody: editEventTypeBody,
    session: Session & Partial<SessionData>
  ) {
    const { eventTypeId, name, description, startDate, lesson, endDate, teamId, isPersonal } = reqBody;
    const { id: eventId } = reqParams;
    // always use classId instead of session.classId
    // since session.classId can change during concurrent requests
    const classId = parseInt(session.classId!, 10);
    if (endDate) {
      dateChecker(startDate, endDate);
    }
    lessonDateEventAtLeastOneNull(endDate, lesson);
    await isValidEventTypeId(eventTypeId, session);

    // load current ownership to authorize the edit and know which caches to bust
    const existing = await prisma.event.findFirst({
      where: { eventId, classId },
      select: { accountId: true }
    });

    if (!existing) {
      const err: RequestError = {
        name: "Not Found",
        status: 404,
        message: "Event not found",
        expected: true
      };
      throw err;
    }

    // authorize against the CURRENT state (who may touch this row)
    await authorizeEventMutation(existing.accountId, session);
    // authorize against the TARGET state and resolve the new owner/team (allows toggling)
    const { accountId: newAccountId, storedTeamId } = await resolveEventScope(isPersonal, teamId, session);

    try {
      const updated = await prisma.event.updateMany({
        where: {
          eventId: eventId,
          classId
        },
        data: {
          eventTypeId: eventTypeId,
          name: name,
          description: description,
          startDate: startDate,
          lesson: lesson,
          endDate: endDate,
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
          message: "Event not found for update",
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

      logger.error(`editEvent failed with unexpected database error: ${err}`);
      throw err;
    }

    // bust every partition this edit could have touched (old owner + new owner/shared)
    await invalidateCache(CACHE_KEY_PREFIXES.EVENT, classId.toString(), existing.accountId?.toString());
    await invalidateCache(CACHE_KEY_PREFIXES.EVENT, classId.toString(), newAccountId?.toString());
    // send socket event
    emitSocketToClass(classId, SOCKET_EVENTS.EVENTS);
  },

  async deleteEvent(reqParams: deleteEventTypeParams, session: Session & Partial<SessionData>) {
    const { id: eventId } = reqParams;
    // always use classId instead of session.classId
    // since session.classId can change during concurrent requests
    const classId = parseInt(session.classId!, 10);

    const existing = await prisma.event.findFirst({
      where: { eventId, classId },
      select: { accountId: true }
    });

    if (!existing) {
      const err: RequestError = {
        name: "Not Found",
        status: 404,
        message: "Event not found",
        expected: true
      };
      throw err;
    }

    // owner may delete personal; editor may delete shared
    await authorizeEventMutation(existing.accountId, session);

    await removeEvent(eventId, classId, existing.accountId);
  },

  async getEventTypeData(session: Session & Partial<SessionData>) {
    // always use classId instead of session.classId
    // since session.classId can change during concurrent requests
    const classId = parseInt(session.classId!, 10);
    const getEventTypeDataCacheKey = generateCacheKey(CACHE_KEY_PREFIXES.EVENTTYPE, session.classId!);
    const cachedEventTypeData = await redisClient.get(getEventTypeDataCacheKey);

    if (cachedEventTypeData) {
      try {
        return JSON.parse(cachedEventTypeData);
      }
      catch (error) {
        logger.error(`Error parsing Redis data: ${error}`);
        // fall through to prevent crashes and rely on DB
      }
    }

    const eventTypeData = await prisma.eventType.findMany({
      where: {
        classId
      },
      orderBy: {
        name: "asc"
      }
    });

    try {
      await updateCacheData(eventTypeData, getEventTypeDataCacheKey);
    }
    catch (err) {
      logger.error(`Error updating Redis cache: ${err}`);
      // fall through to prevent crashes and rely on DB
    }

    return eventTypeData;
  },

  async setEventTypeData(
    reqBody: setEventTypesTypeBody,
    session: Session & Partial<SessionData>) {
    const { eventTypes } = reqBody;
    // always use classId instead of session.classId
    // since session.classId can change during concurrent requests
    const classId = parseInt(session.classId!, 10);

    await prisma.$transaction(async tx => {
      const existingEventTypes = await tx.eventType.findMany({
        where: { classId }
      });

      // Delete removed event types (scoped)
      for (const existing of existingEventTypes) {
        if (!eventTypes.some(e => e.eventTypeId === existing.eventTypeId)) {
          await tx.eventType.deleteMany({
            where: { eventTypeId: existing.eventTypeId, classId }
          });
          await tx.event.deleteMany({
            where: { eventTypeId: existing.eventTypeId, classId }
          });
        }
      }

      // Create or update event types
      for (const eventType of eventTypes) {
        isValidColor(eventType.color);
        if (eventType.name.trim() === "") {
          const err: RequestError = {
            name: "Bad Request",
            status: 400,
            message: "Invalid data format",
            expected: true
          };
          throw err;
        }

        if (eventType.eventTypeId === "") {
          await tx.eventType.create({
            data: {
              classId,
              name: eventType.name,
              color: eventType.color,
              createdAt: BigInt(Date.now())
            }
          });
        }
        else {
          const updated = await tx.eventType.updateMany({
            where: { eventTypeId: eventType.eventTypeId, classId },
            data: {
              name: eventType.name,
              color: eventType.color
            }
          });

          if (updated.count === 0) {
            const err: RequestError = {
              name: "Not Found",
              status: 404,
              message: "Event type not found for update",
              expected: true
            };
            throw err;
          }
        }
      }
    });


    const eventTypeData = await prisma.eventType.findMany({
      where: {
        classId
      }
    });

    const setEventTypeDataCacheKey = generateCacheKey(CACHE_KEY_PREFIXES.EVENTTYPE, classId.toString());

    try {
      await updateCacheData(eventTypeData, setEventTypeDataCacheKey);
      emitSocketToClass(classId, SOCKET_EVENTS.EVENT_TYPES);
    }
    catch (err) {
      logger.error(`Error updating Redis cache: ${err}`);
      // fall through to prevent crashes and rely on DB
    }

    try {
      await this.updateEventTypeStyles(session);
    }
    catch (e) {
      logger.error(String(e));
    }
  },

  async getEventTypeStyles(session: Session & Partial<SessionData>) {
    if (!session.classId) {
      return "";
    }

    const setEventTypeStylesCacheKey = generateCacheKey(CACHE_KEY_PREFIXES.EVENTTYPESTYLE, session.classId);

    const cachedEventTypeStyles = await redisClient.get(setEventTypeStylesCacheKey);

    if (cachedEventTypeStyles) {
      try {
        return cachedEventTypeStyles;
      }
      catch (error) {
        logger.error(`Error parsing Redis data: ${error}`);
        // fall through to prevent crashes and rely on DB
      }
    }

    const eventTypeStyles = await this.updateEventTypeStyles(session);

    return eventTypeStyles;
  },

  async updateEventTypeStyles(session: Session & Partial<SessionData>) {
    // session.classId certainly exists here
    // this function is called by getEventTypeStyles(), 
    // which returns "", if no class is in session
    const classId = parseInt(session.classId!, 10);

    // “singleflight” deduplication: 
    // spamming the endpoint doesn’t spawn many concurrent Sass compiles (prevents CPU spikes)
    const existing = inFlightStyleBuild.get(classId);
    if (existing) return existing;

    const buildPromise = (async () => {
      const eventTypeData = await this.getEventTypeData(session);
      const scss = `
      @use "sass:color";

      ${eventTypeData
        .map((eventType: { eventTypeId: string; name: string; color: string }) => {
          return `$event-${eventType.eventTypeId}: ${eventType.color};`;
        })
        .join("")}

      $event-colors: (
        ${eventTypeData
        .map((eventType: { eventTypeId: string; name: string; color: string }) => {
          return `${eventType.eventTypeId}: $event-${eventType.eventTypeId},`;
        })
        .join("")}
      );

      @each $name, $color in $event-colors {
        [data-variant="event-#{"" + $name}"] {
          --variant-color: #{"" + $color};
        }
      }`;
      const css = (await sass.compileStringAsync(scss, { style: "compressed" })).css;

      const updateEventTypeStylesCacheKey = generateCacheKey(CACHE_KEY_PREFIXES.EVENTTYPESTYLE, classId.toString());

      try {
        await redisClient.set(updateEventTypeStylesCacheKey, css, { expiration: { type: "EX", value: cacheExpiration } });
      }
      catch (err) {
        logger.error(`Error updating Redis cache: ${err}`);
        // fall through to prevent crashes and rely on DB
      }

      return css;
    })().finally(() => {
      inFlightStyleBuild.delete(classId);
    });

    inFlightStyleBuild.set(classId, buildPromise);
    return buildPromise;
  }
};

export default eventService;
