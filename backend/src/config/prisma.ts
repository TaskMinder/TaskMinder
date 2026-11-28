import { PrismaClient } from "../prisma/generated/prisma/client.js";
import { PrismaPg } from "@prisma/adapter-pg";
import { envConfig } from "./env.js";

const adapter = new PrismaPg({
  connectionString: envConfig.databaseUrl
});

// private authorship for moderation, only returned when selected
const AUTHOR_IDS = { authorAccountId: true, lastEditorAccountId: true } as const;

export const prisma = new PrismaClient({
  adapter,
  omit: { homework: AUTHOR_IDS, event: AUTHOR_IDS, upload: { lastEditorAccountId: true } }
});

// prisma or an interactive transaction of it
export type Db = Omit<typeof prisma, "$connect" | "$disconnect" | "$on" | "$use" | "$extends" | "$transaction">;