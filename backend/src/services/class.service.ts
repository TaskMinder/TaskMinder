import { RequestError } from "../@types/requestError.js";
import { Prisma } from "../prisma/generated/prisma/client.js";
import { Session, SessionData } from "express-session";
import { prisma } from "../config/prisma.js";
import { BigIntreplacer, generateRandomBase62String } from "../utils/validate.functions.js";
import { CACHE_KEY_PREFIXES, invalidateCache } from "../config/redis.js";
import logger from "../config/logger.js";
import { redisClient } from "../config/redis.js";
import { redisStore } from "../config/redis.js";
import fs from "fs/promises";
import path from "path";
import { FINAL_UPLOADS_DIR } from "../config/upload.js";
import { encryptionManager } from "../utils/encryption.manager.js";
import {
  changeClassCodeTypeParams,
  changeClassNameTypeBody,
  changeClassNameTypeParams,
  changeDefaultPermissionTypeBody,
  changeDefaultPermissionTypeParams,
  createClassTypeBody,
  deleteClassTypeParams,
  getClassInfoTypeParams,
  getClassMembersTypeParams,
  joinClassTypeBody,
  kickClassMembersTypeBody,
  kickClassMembersTypeParams,
  kickLoggedOutUsersTypeParams,
  leaveClassTypeParams,
  setClassMembersPermissionsTypeBody,
  setClassMembersPermissionsTypeParams,
  upgradeTestClassTypeParams
} from "../schemas/class.schema.js";
import socketIO, { emitSocketToClass, SOCKET_EVENTS } from "../config/socket.js";

// session-free internals, shared by the class settings endpoints and moderation
export async function removeLoggedOutSessions(classId: number): Promise<void> {
  // Scan all sess: keys and delete those matching classId with no account (unregistered users)
  let deletedCount = 0;
  const keys = await redisStore.getClassSessionKeys(classId);
  for (const key of keys) {
    // Redis client typing uses deeply nested generics that cause assignment failures.
    // Runtime calls are safe — casting to any is intentional.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = await (redisClient as any).get(key);
    if (!raw) {
      await redisStore.removeClassSessionKey(classId, key);
      continue;
    }
    const sess = JSON.parse(raw) as SessionData;
    if (!sess.account) {
      await redisStore.destroyBySessionKey(key);
      deletedCount++;
    }
  }
  logger.info(`Successfully deleted ${deletedCount} unregistered user sessions for class ${classId}.`);
}

export async function rotateClassCode(classId: number): Promise<string> {
  //generate new class code, look if already used -> if not, return value
  // Try until a unique code is found
  let code: string;
  const MAX_ATTEMPTS = 10;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    code = generateRandomBase62String();
    const encryptedCode = encryptionManager.encrypt(code);
    const classCodeHash = encryptionManager.hash(code);
    const exists = await prisma.class.findUnique({
      where: {
        classCodeHash: classCodeHash
      }
    });
    if (!exists) {
      await prisma.class.update({
        where: {
          classId
        },
        data: {
          classCode: encryptedCode,
          classCodeHash: classCodeHash
        }
      });
      emitSocketToClass(classId, SOCKET_EVENTS.CLASS_INFO);
      logger.info(`class code was changed for class: ${classId}`);
      return code;
    }
  }
  // If unique code wasn't found after 10 tries, fail gracefully
  const err: RequestError = {
    name: "Server Error",
    status: 500,
    message: "Could not generate unique class code",
    expected: false
  };
  throw err;
}

const classService = {
  /*
  getClassInfo(
    reqParams: getClassInfoTypeParams
    session: Session & Partial<SessionData>
  )
  get all relevant class info for user
  */
  async getClassInfo(
    reqParams: getClassInfoTypeParams,
    session: Session & Partial<SessionData>
  ) {
    // always use classId (id) instead of session.classId
    // since session.classId can change during concurrent requests
    const { id: classId } = reqParams;
    // check id from request against session value
    if (classId !== parseInt(session.classId!)) {
      const err: RequestError = {
        name: "Forbidden",
        status: 403,
        message: "Request params /:id differs from session classId",
        expected: true
      };
      throw err;
    }
    // find class and fetch all relevant fields
    const classInfo = await prisma.class.findUnique({
      where: {
        classId
      },
      select: {
        // omit dsbMobileUser and password since it is not needed currently 
        // and a better solution will be created when dsbMobile for all classes in introduced
        classId: true,
        classCode: true,
        className: true,
        createdAt: true,
        isTestClass: true,
        defaultPermissionLevel: true,
        storageUsedBytes: true,
        storageQuotaBytes: true,
        dsbMobileActivated: true,
        dsbMobileClass: true
      }
    });
    if (!classInfo) {
      const err: RequestError = {
        name: "Not Found",
        status: 404,
        message: "Can not find class",
        expected: true
      };
      throw err;
    }
    let decryptedClassCode: string;
    try {
      decryptedClassCode = encryptionManager.decrypt(classInfo.classCode);
    }
    catch {
      const err: RequestError = {
        name: "Bad Request",
        status: 400,
        message:
          "Failed to decrypt class code. The stored value may be corrupted or encrypted with a different key.",
        expected: true
      };
      throw err;
    }

    const decryptedClassInfo = {
      ...classInfo,
      classCode: decryptedClassCode
    };
    // parse stringified data to avoid BigInt serialize errors
    return JSON.parse(JSON.stringify(decryptedClassInfo, BigIntreplacer));
  },
  /*
  createClass(
    reqData: createClassTypeBody,
    session: Session & Partial<SessionData>
  )
  create a (test) class, requires account and no class membership
  and return the class code
  */
  async createClass(
    reqData: createClassTypeBody,
    session: Session & Partial<SessionData>
  ) {
    const { classDisplayName, isTestClass } = reqData;

    // reject if user is already in a class
    if (session.classId) {
      const err: RequestError = {
        name: "Forbidden",
        status: 403,
        message: "User logged in into class",
        expected: true
      };
      throw err;
    }
    // create class with retry attempt fallback
    const maxAttempts = 10;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const classCode = generateRandomBase62String();
      const encryptedClassCode = encryptionManager.encrypt(classCode);
      const classCodeHash = encryptionManager.hash(classCode);
      // find already existing class with this hash and reject if present
      const exists = await prisma.class.findUnique({
        where: { classCodeHash }
      });
      if (exists) {
        continue;
      }

      const baseData = {
        className: classDisplayName,
        classCode: encryptedClassCode,
        classCodeHash: classCodeHash,
        createdAt: BigInt(Date.now()),
        isTestClass: isTestClass,
        dsbMobileActivated: false,
        storageQuotaBytes: isTestClass ? 20 * 1024 * 1024 : 1 * 1024 * 1024 * 1024, // 20MB (test class) or 1 GB (normal class)
        storageUsedBytes: 0,
        defaultPermissionLevel: 0 // default setting when creating class is 0 - member status
      };
      // create class and joinedClass entry
      try {
        return await prisma.$transaction(async tx => {
          const createdClass = await tx.class.create({
            data: baseData
          });
          session.classId = createdClass.classId.toString();
          // add user to classJoined table
          // change permission of user which created the account to admin
          await tx.joinedClass.create({
            data: {
              accountId: session.account!.accountId,
              classId: createdClass.classId,
              permissionLevel: 3, // class creator is admin
              createdAt: BigInt(Date.now())
            }
          });
          return classCode;
        });
      }
      catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
          // unique constraint collision, retry
          continue;
        }
        const reqErr: RequestError = {
          name: "Internal Server Error",
          status: 500,
          message: "Could not create class in database, please try again",
          expected: true
        };
        throw reqErr;
      }
    }

    const err: RequestError = {
      name: "Internal Server Error",
      status: 500,
      message: "Could not generate a unique class code. Please try again.",
      expected: true
    };
    throw err;
  },
  /*
  joinClass(
    reqData: joinClassTypeBody,
    session: Session & Partial<SessionData>
  )
  join class based on class code and sync session
  */
  async joinClass(reqData: joinClassTypeBody, session: Session & Partial<SessionData>) {
    const { classCode } = reqData;
    const accountId = session.account?.accountId;
    if (encryptionManager.isEncrypted(classCode)) {
      const err: RequestError = {
        name: "Bad Request",
        status: 400,
        message: "Invalid class code (starting with encryption prefix)",
        expected: true
      };
      throw err;
    }
    if (session.classId) {
      const err: RequestError = {
        name: "Bad Request",
        status: 400,
        message: "Already in a class",
        expected: true
      };
      throw err;
    }
    // try to find class by hash
    const classCodeHash = encryptionManager.hash(classCode);
    const targetClass = await prisma.class.findUnique({
      where: {
        classCodeHash: classCodeHash
      }
    });
    if (!targetClass) {
      const err: RequestError = {
        name: "Not Found",
        status: 404,
        message: "Invalid class code",
        expected: true
      };
      throw err;
    }
    // sync session
    if (accountId !== undefined) {
      await prisma.$transaction(async tx => {
        const existingJoin = await tx.joinedClass.findUnique({
          where: { accountId }
        });

        if (existingJoin) {
          // DB says user is in a class, but it's not the one they're trying to join
          if (existingJoin.classId !== targetClass.classId) {
            const err: RequestError = {
              name: "Conflict",
              status: 409,
              message:
                "Account is already linked to a different class in the database.",
              expected: true
            };
            throw err;
          }
        }
        else {
          await tx.joinedClass.create({
            data: {
              accountId: accountId,
              classId: targetClass.classId,
              permissionLevel: targetClass.defaultPermissionLevel,
              createdAt: BigInt(Date.now())
            }
          });
        }
      });
      logger.info(`User (logged in): ${accountId} joined class ${targetClass.classId}`);
    }
    session.classId = targetClass.classId.toString();
    emitSocketToClass(targetClass.classId, SOCKET_EVENTS.MEMBERS);
    return targetClass.className;
  },
  /*
  leaveClass(
    reqParams: leaveClassTypeParams,
    session: Session & Partial<SessionData>
  )
  leave class, reject if only admin left or operation would leave class admin-less
  */
  async leaveClass(reqParams: leaveClassTypeParams, session: Session & Partial<SessionData>) {
    const { id: classId } = reqParams;
    // check id from request against session value
    if (classId !== parseInt(session.classId!)) {
      const err: RequestError = {
        name: "Forbidden",
        status: 403,
        message: "Request params /:id differs from session classId",
        expected: true
      };
      throw err;
    }
    // if account exists (user is logged in), remove from DB
    // check for cases (e.g. only admin left)
    if (session.account) {
      await prisma.$transaction(async tx => {
        // find all members of the class
        const allMembers = await tx.joinedClass.findMany({
          where: {
            classId
          }
        });

        // if requested account is not in this class, deny operation and delete session
        const currentUserMemberInfo = allMembers.find(
          member => member.accountId === session.account!.accountId
        );
        if (!currentUserMemberInfo) {
          delete session.classId;
          delete session.account;
          const err: RequestError = {
            name: "Unauthorized",
            status: 401,
            message:
              "Session account not found in the class. Logging out of class",
            expected: true
          };
          throw err;
        }

        // admin cases
        const leavingUserIsAdmin = currentUserMemberInfo.permissionLevel === 3;
        if (leavingUserIsAdmin) {
          // only one member left
          if (allMembers.length === 1) {
            const err: RequestError = {
              name: "Conflict",
              status: 409,
              message:
                "You are the only admin and user in this class. Please delete the class instaed.",
              expected: true
            };
            throw err;
          }

          // if only one admin left
          const adminsInClass = allMembers.filter(
            member => member.permissionLevel === 3
          );
          if (adminsInClass.length === 1) {
            const err: RequestError = {
              name: "Conflict",
              status: 409,
              message:
                "You are the only admin. Please promote another member before leaving or delete the class.",
              expected: true
            };
            throw err;
          }
        }
        const removedMembership = await tx.joinedClass.deleteMany({
          where: {
            accountId: session.account!.accountId,
            classId
          }
        });
        if (removedMembership.count === 0) {
          delete session.classId;
          delete session.account;
          const err: RequestError = {
            name: "Unauthorized",
            status: 401,
            message:
              "Session account not found in the class. Logging out of class",
            expected: true
          };
          throw err;
        }
        // delete cache of upload metadata as author may not be in class anymore
        await invalidateCache(CACHE_KEY_PREFIXES.UPLOADMETADATA, classId.toString());
        // delete joinedTeams, homeworkCheck and set relevant upload author to null
        await tx.joinedTeams.deleteMany({
          where: {
            accountId: session.account!.accountId,
            Team: {
              is: {
                classId
              }
            }
          }
        });
        await tx.homeworkCheck.deleteMany({
          where: {
            accountId: session.account!.accountId,
            Homework: {
              is: {
                classId
              }
            }
          }
        });
        await tx.upload.updateMany({
          where: {
            accountId: session.account!.accountId,
            classId
          },
          data: {
            accountId: null
          }
        });
        logger.info(`User ${session.account} left class: ${classId}`);
        emitSocketToClass(classId, SOCKET_EVENTS.UPLOADS);
      });
    };
    delete session.classId;
    emitSocketToClass(classId, SOCKET_EVENTS.MEMBERS);
  },
  /*
  deleteClass(
    reqParams: deleteClassTypeParams,
    session: Session & Partial<SessionData>
  )
  delete class (and all data with it)
  */
  async deleteClass(reqParams: deleteClassTypeParams, session: Session & Partial<SessionData>) {
    const { id: classId } = reqParams;
    // check id from request against session value
    if (classId !== parseInt(session.classId!)) {
      const err: RequestError = {
        name: "Forbidden",
        status: 403,
        message: "Request params /:id differs from session classId",
        expected: true
      };
      throw err;
    }
    const room = `class:${session.classId}`;
    // delete everything from this class in transaction to enable rollback
    await prisma.$transaction(async tx => {
      // Delete upload records first (FileMetadata rows cascade via FK)
      await tx.upload.deleteMany({
        where: { classId }
      });
      // Delete upload request records
      await tx.uploadRequest.deleteMany({
        where: { classId }
      });
      // Delete all joinedClass records
      await tx.joinedClass.deleteMany({
        where: { classId }
      });
      // Delete class, rest is deleted with CASCADE in database
      await tx.class.delete({
        where: { classId }
      });
    });

    // invalidate redis caches
    await invalidateCache(CACHE_KEY_PREFIXES.UPLOADMETADATA, classId.toString());
    await invalidateCache(CACHE_KEY_PREFIXES.UPLOADREQUESTS, classId.toString());
    await invalidateCache(CACHE_KEY_PREFIXES.HOMEWORK, classId.toString());
    await invalidateCache(CACHE_KEY_PREFIXES.EVENT, classId.toString());
    await invalidateCache(CACHE_KEY_PREFIXES.LESSON, classId.toString());
    await invalidateCache(CACHE_KEY_PREFIXES.EVENTTYPESTYLE, classId.toString());
    await invalidateCache(CACHE_KEY_PREFIXES.SUBJECT, classId.toString());
    await invalidateCache(CACHE_KEY_PREFIXES.EVENTTYPE, classId.toString());
    await invalidateCache(CACHE_KEY_PREFIXES.TEAMS, classId.toString());
    await redisClient.del(`auth_class:${classId}`);

    // delete session classId
    delete session.classId;

    // Make all sockets in the room leave it
    const io = socketIO.getIO();
    const sockets = await io.in(room).fetchSockets();
    sockets.forEach(socket => socket.leave(room));

    // Delete physical files from disk after DB commit to avoid DB lock coupling
    const classDir = path.join(FINAL_UPLOADS_DIR, classId.toString());
    try {
      await fs.rm(classDir, { recursive: true, force: true });
      logger.info(`Deleted class directory: ${classDir}`);
    }
    catch (error) {
      logger.error(`Error deleting class directory ${classDir}: ${error}`);
    }

    logger.info(`Class ${classId} was deleted`);
  },
  /*
  setClassMembersPermissions(
    reqParams: setClassMembersPermissionsTypeParams,
    reqBody: setClassMembersPermissionsTypeBody,
    session: Session & Partial<SessionData>
  )
  BULK EDIT: set the permissions of the class members, needs one admin after edit
  */
  async setClassMembersPermissions(
    reqParams: setClassMembersPermissionsTypeParams,
    reqBody: setClassMembersPermissionsTypeBody,
    session: Session & Partial<SessionData>
  ) {
    const { classMembers } = reqBody;
    const { id: classId } = reqParams;
    // check id from request against session value
    if (classId !== parseInt(session.classId!)) {
      const err: RequestError = {
        name: "Forbidden",
        status: 403,
        message: "Request params /:id differs from session classId",
        expected: true
      };
      throw err;
    }
    await prisma.$transaction(async tx => {
      for (const member of classMembers) {
        await tx.joinedClass.updateMany({
          where: {
            accountId: member.accountId,
            classId
          },
          data: {
            permissionLevel: member.permissionLevel
          }
        });
      }

      // Check if there is at least one admin left
      const adminExists = await tx.joinedClass.findFirst({
        where: {
          classId,
          permissionLevel: 3
        }
      });

      if (!adminExists) {
        const err: RequestError = {
          name: "Bad Request",
          status: 400,
          message: "At least one logged in admin must be remaining after this action.",
          expected: true
        };
        throw err;
      }
    });
    emitSocketToClass(classId, SOCKET_EVENTS.MEMBERS);
    logger.info(`class member permissions were updated for class ${classId}`);
  },
  /*
  getClassMembers(
    reqParams: getClassMembersTypeParams,
    session: Session & Partial<SessionData>
  )
  get class members details for class settings
  */
  async getClassMembers(
    reqParams: getClassMembersTypeParams,
    session: Session & Partial<SessionData>
  ) {
    const { id: classId } = reqParams;
    // check id from request against session value
    if (classId !== parseInt(session.classId!)) {
      const err: RequestError = {
        name: "Forbidden",
        status: 403,
        message: "Request params /:id differs from session classId",
        expected: true
      };
      throw err;
    }
    // find all members in class, only extract username, accountId and permissionLevel
    const classMembers = await prisma.joinedClass.findMany({
      where: {
        classId
      },
      select: {
        permissionLevel: true,
        Account: {
          select: {
            username: true,
            accountId: true
          }
        }
      }
    });
    // return the mapped array with username, accountId and permissionLevel
    return classMembers.map(({ Account, permissionLevel }) => ({
      ...Account,
      permissionLevel
    }));
  },
  /*
  kickClassMember(
    reqParams: kickClassMembersTypeParams,
    reqBody: kickClassMembersTypeBody,
    session: Session & Partial<SessionData>
  )
  BULK EDIT: remove listed class members in class
  */
  async kickClassMember(
    reqParams: kickClassMembersTypeParams,
    reqBody: kickClassMembersTypeBody,
    session: Session & Partial<SessionData>
  ) {
    const { classMembers } = reqBody;
    const { id: classId } = reqParams;
    // check id from request against session value
    if (classId !== parseInt(session.classId!)) {
      const err: RequestError = {
        name: "Forbidden",
        status: 403,
        message: "Request params /:id differs from session classId",
        expected: true
      };
      throw err;
    }
    const kickedAccountIds = new Set(classMembers.map(m => m.accountId));

    await prisma.$transaction(async tx => {
      for (const classMember of classMembers) {
        const removedMembership = await tx.joinedClass.deleteMany({
          where: {
            accountId: classMember.accountId,
            classId
          }
        });
        if (removedMembership.count === 0) {
          const err: RequestError = {
            name: "Bad Request",
            status: 400,
            message: "User does not exist in this class",
            expected: true
          };
          throw err;
        }
        // delete cache of upload metadata to avoid null authors
        await invalidateCache(CACHE_KEY_PREFIXES.UPLOADMETADATA, classId.toString());
        await tx.joinedTeams.deleteMany({
          where: {
            accountId: classMember.accountId,
            Team: {
              is: {
                classId
              }
            }
          }
        });
        await tx.homeworkCheck.deleteMany({
          where: {
            accountId: classMember.accountId,
            Homework: {
              is: {
                classId
              }
            }
          }
        });
        await tx.upload.updateMany({
          where: {
            accountId: classMember.accountId,
            classId
          },
          data: {
            accountId: null
          }
        });
      }
      // Check if there is at least one admin left
      const adminExists = await tx.joinedClass.findFirst({
        where: {
          classId: classId,
          permissionLevel: 3
        }
      });

      if (!adminExists) {
        const err: RequestError = {
          name: "Bad Request",
          status: 400,
          message: "At least one logged in admin must be remaining after this action.",
          expected: true
        };
        throw err;
      }
    });

    // Destroy sessions of kicked members
    try {
      const sessionKeys = await redisStore.getClassSessionKeys(classId);
      for (const sessionKey of sessionKeys) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const raw = await (redisClient as any).get(sessionKey);
        if (!raw) {
          await redisStore.removeClassSessionKey(classId, sessionKey);
          continue;
        }
        const sess = JSON.parse(raw) as SessionData;
        if (sess.account && kickedAccountIds.has(sess.account.accountId)) {
          await redisStore.destroyBySessionKey(sessionKey);
        }
      }

      // Clear class auth cache
      await redisClient.del(`auth_class:${classId}`);

      // Clear auth_user caches for kicked accounts
      for (const accountId of kickedAccountIds) {
        await redisClient.del(`auth_user:${accountId}`);
      }
    }
    catch (err) {
      logger.error(`Error destroying kicked member sessions for class ${classId}: ${err}`);
      // Log error but continue — DB transaction already succeeded
    }

    emitSocketToClass(classId, SOCKET_EVENTS.MEMBERS);
    logger.info(`class members were kicked in class: ${classId}`);
  },
  /*
  changeDefaultPermission(
    reqParams: changeDefaultPermissionTypeParams,
    reqBody: changeDefaultPermissionTypeBody,
    session: Session & Partial<SessionData>
  )
  change the default permission for joined users and role for logged out users
  */
  async changeDefaultPermission(
    reqParams: changeDefaultPermissionTypeParams,
    reqBody: changeDefaultPermissionTypeBody,
    session: Session & Partial<SessionData>
  ) {
    const { role } = reqBody;
    const { id: classId } = reqParams;
    // check id from request against session value
    if (classId !== parseInt(session.classId!)) {
      const err: RequestError = {
        name: "Forbidden",
        status: 403,
        message: "Request params /:id differs from session classId",
        expected: true
      };
      throw err;
    }
    await prisma.class.update({
      where: {
        classId: classId
      },
      data: {
        defaultPermissionLevel: role
      }
    });
    emitSocketToClass(classId, SOCKET_EVENTS.CLASS_INFO);
    logger.info(`class ${classId} default permission was changed to: ${role}`);
  },
  /*
  kickLoggedOutUsers(
    reqParams: kickLoggedOutUsersTypeParams,
    session: Session & Partial<SessionData>
  )
  BULK EDIT: remove all not logged in users from class
  */
  async kickLoggedOutUsers(
    reqParams: kickLoggedOutUsersTypeParams,
    session: Session & Partial<SessionData>
  ) {
    const { id: classId } = reqParams;
    // check id from request against session value
    if (classId !== parseInt(session.classId!)) {
      const err: RequestError = {
        name: "Forbidden",
        status: 403,
        message: "Request params /:id differs from session classId",
        expected: true
      };
      throw err;
    }
    try {
      await removeLoggedOutSessions(classId);
    }
    catch {
      const err: RequestError = {
        name: "Internal Server Error",
        status: 500,
        message: "Error while cleaning unregistered users of class",
        expected: true
      };
      throw err;
    }
  },
  /*
  changeClassName(
    reqParams: changeClassNameTypeParams,
    reqBody: changeClassNameTypeBody,
    session: Session & Partial<SessionData>
  )
  change class name
  */
  async changeClassName(
    reqParams: changeClassNameTypeParams,
    reqBody: changeClassNameTypeBody,
    session: Session & Partial<SessionData>
  ) {
    const { classDisplayName } = reqBody;
    const { id: classId } = reqParams;
    // check id from request against session value
    if (classId !== parseInt(session.classId!)) {
      const err: RequestError = {
        name: "Forbidden",
        status: 403,
        message: "Request params /:id differs from session classId",
        expected: true
      };
      throw err;
    }
    await prisma.class.update({
      where: {
        classId
      },
      data: {
        className: classDisplayName
      }
    });
    emitSocketToClass(classId, SOCKET_EVENTS.CLASS_INFO);
    logger.info(`class name was changed in class: ${classId}`);
  },
  /*
  changeClassCode(
    reqParams: changeClassCodeTypeParams,
    session: Session & Partial<SessionData>
  )
  change class code with retry logic
  */
  async changeClassCode(
    reqParams: changeClassCodeTypeParams,
    session: Session & Partial<SessionData>
  ) {
    const { id: classId } = reqParams;
    // check id from request against session value
    if (classId !== parseInt(session.classId!)) {
      const err: RequestError = {
        name: "Forbidden",
        status: 403,
        message: "Request params /:id differs from session classId",
        expected: true
      };
      throw err;
    }
    return await rotateClassCode(classId);
  },
  /*
  upgradeTestClass(
    reqParams: upgradeTestClassTypeParams,
    session: Session & Partial<SessionData>
  )
  upgrade test class to normal class
  */
  async upgradeTestClass(
    reqParams: upgradeTestClassTypeParams,
    session: Session & Partial<SessionData>
  ) {
    const { id: classId } = reqParams;
    // check id from request against session value
    if (classId !== parseInt(session.classId!)) {
      const err: RequestError = {
        name: "Forbidden",
        status: 403,
        message: "Request params /:id differs from session classId",
        expected: true
      };
      throw err;
    }
    await prisma.class.update({
      where: {
        classId
      },
      data: {
        isTestClass: false
      }
    });
    emitSocketToClass(classId, SOCKET_EVENTS.CLASS_INFO);
    logger.info(`class: ${classId} was upgraded to normal class`);
  }
};

export default classService;
