import { PrismaClient } from "../prisma/generated/prisma/client.js";
import { PrismaPg } from "@prisma/adapter-pg";
import { envConfig } from "./env.js";

const adapter = new PrismaPg({
  connectionString: envConfig.databaseUrl
});

// private authorship for moderation: left out of every query that does not select it
const AUTHOR_IDS = { authorAccountId: true, lastEditorAccountId: true } as const;

export const prisma = new PrismaClient({
  adapter,
  omit: { homework: AUTHOR_IDS, event: AUTHOR_IDS, upload: { lastEditorAccountId: true } }
});

// prisma itself or interactive transaction of it, for helpers that can run in caller's transaction 
export type Db = Omit<typeof prisma, "$connect" | "$disconnect" | "$on" | "$use" | "$extends" | "$transaction">;