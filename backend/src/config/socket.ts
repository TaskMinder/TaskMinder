import * as http from "http";
import * as socketIo from "socket.io";

import logger from "../config/logger.js";
import { prisma } from "./prisma.js";

let io: socketIo.Server;

export const SOCKET_EVENTS = {
  EVENTS: "updateEvents",
  HOMEWORK: "updateHomework",
  HOMEWORK_CHECK: "updateCheckedHomework",
  UPLOADS: "updateUploads",
  UPLOAD_REQUESTS: "updateUploadRequests",
  MEMBERS: "updateMembers",
  SUBJECTS: "updateSubjects",
  TEAMS: "updateTeams",
  JOINED_TEAMS: "updateJoinedTeams",
  EVENT_TYPES: "updateEventTypes",
  TIMETABLES: "updateTimetables",
  CLASS_INFO: "updateClassInfo"
} as const;

export type socketEvent =
  (typeof SOCKET_EVENTS)[keyof typeof SOCKET_EVENTS];


// TODO: currently personal changes are emitted to the whole class room
// -> other members get redundant refetch
// Solution: per-account socket room emitting personal updates only
// to owner would be more efficient (atm intentionally deferred)
export const emitSocketToClass = (classId: number, socketEvent: socketEvent): void => {
  const io = getIO();
  io.to(`class:${classId}`).emit(socketEvent);
};

function accountRoom(accountId: number): string {
  return `account:${accountId}`;
}

// on ban; reconnecting is refused while banned
export const disconnectAccountSockets = (accountId: number): void => {
  getIO().in(accountRoom(accountId)).disconnectSockets(true);
};

// Initialize the Socket.IO instance
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const initialize = (server: http.Server, sessionMiddleware: any): socketIo.Server => {
  io = new socketIo.Server(server);

  // Wrap session middleware for Socket.IO
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wrap = (middleware: any) => (socket: any, next: any) =>
    middleware(socket.request, {}, next);

  // Apply session middleware to Socket.IO
  io.use(wrap(sessionMiddleware));

  io.on("connection", async socket => {
    logger.info(`user connected: ${socket.id}`, { isSocket: true });

    // Access session and join class room if classId exists
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const session = (socket.request as any).session;
    if (session.account) {
      // joined before the ban check, so a ban committed during the check still disconnects this socket
      socket.join(accountRoom(session.account.accountId));
      const account = await prisma.account.findUnique({
        where: { accountId: session.account.accountId },
        select: { bannedAt: true }
      });
      if (account && account.bannedAt !== null) {
        socket.disconnect(true);
        return;
      }
    }
    if (session.classId) {
      const classExists = await prisma.class.findUnique({
        where: { classId: parseInt(session.classId, 10) },
        select: { classId: true }
      });

      // socket may be gone after the awaits (ban, client left)
      if (socket.disconnected) {
        return;
      }
      if (classExists) {
        socket.join(`class:${session.classId}`);
        logger.info(`user ${socket.id} joined class room: ${session.classId}`, { isSocket: true });
      } 
      else {
        delete session.classId;
        logger.warn("User had invalid classId in session, cleared");
      }
    }

    socket.on("disconnect", () => {
      logger.info(`user disconnected: ${socket.id}`, { isSocket: true });
    });
  });

  return io;
};

// Get the Socket.IO instance (after initialization)
export const getIO = (): socketIo.Server => {
  if (!io) {
    throw new Error("Socket.IO not initialized");
  }
  return io;
};

export default {
  initialize,
  getIO
};
