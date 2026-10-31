import { Session, SessionData } from "express-session";
import { prisma } from "../config/prisma.js";
import { RequestError } from "../@types/requestError.js";
import { addBlockTypeBody, deleteBlockTypeParams } from "../schemas/block.schema.js";
import { fileReport, resolveReportTarget } from "./report.service.js";

// author ids may live in the shared cache but never leave the server;
// strips them and adds the per-viewer isFromBlockedUser flag for logged-in viewers
export async function flagBlockedAuthors(
  items: Record<string, unknown>[],
  authorKeys: string[],
  session: Session & Partial<SessionData>
): Promise<Record<string, unknown>[]> {
  const viewerId = session.account?.accountId;
  const blocks = viewerId === undefined
    ? null
    : await prisma.block.findMany({ where: { accountId: viewerId }, select: { blockedAccountId: true } });
  const blockedIds = new Set(blocks?.map(block => block.blockedAccountId));

  return items.map(item => {
    const rest = { ...item };
    const isFromBlockedUser = authorKeys.some(key => blockedIds.has(rest[key] as number));
    authorKeys.forEach(key => delete rest[key]);
    return blocks ? { ...rest, isFromBlockedUser } : rest;
  });
}

const blockService = {
  async addBlock(reqBody: addBlockTypeBody, session: Session & Partial<SessionData>) {
    const accountId = session.account!.accountId;
    const targetType = "accountId" in reqBody ? "account" : reqBody.targetType;
    const targetId = "accountId" in reqBody ? reqBody.accountId : reqBody.targetId;

    const target = await resolveReportTarget(targetType, targetId, session);
    const blockedAccountId = target.targetAccountId;
    if (blockedAccountId === null) {
      const err: RequestError = {
        name: "Not Found",
        status: 404,
        message: "The author is unknown or anonymous and cannot be blocked. Please report the content instead",
        expected: true
      };
      throw err;
    }
    if (blockedAccountId === accountId) {
      const err: RequestError = {
        name: "Bad Request",
        status: 400,
        message: "You cannot block yourself",
        expected: true
      };
      throw err;
    }

    await prisma.block.upsert({
      where: { accountId_blockedAccountId: { accountId, blockedAccountId } },
      create: { accountId, blockedAccountId, createdAt: BigInt(Date.now()) },
      update: {}
    });
    // blocking notifies the operator through a "block" report
    await fileReport({ targetType, targetId, category: "block" }, target, session);
  },

  async getBlocks(session: Session & Partial<SessionData>) {
    const blocks = await prisma.block.findMany({
      where: { accountId: session.account!.accountId },
      select: { blockedAccountId: true, createdAt: true, BlockedAccount: { select: { username: true } } },
      orderBy: { createdAt: "desc" }
    });
    return blocks.map(block => ({
      accountId: block.blockedAccountId,
      username: block.BlockedAccount.username,
      createdAt: block.createdAt
    }));
  },

  async deleteBlock(reqParams: deleteBlockTypeParams, session: Session & Partial<SessionData>) {
    const deleted = await prisma.block.deleteMany({
      where: { accountId: session.account!.accountId, blockedAccountId: reqParams.accountId }
    });
    if (deleted.count === 0) {
      const err: RequestError = {
        name: "Not Found",
        status: 404,
        message: "Block not found",
        expected: true
      };
      throw err;
    }
  }
};

export default blockService;
