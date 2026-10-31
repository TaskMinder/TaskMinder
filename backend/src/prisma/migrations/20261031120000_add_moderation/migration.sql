-- AlterTable
ALTER TABLE "account" ADD COLUMN     "banReason" TEXT,
ADD COLUMN     "bannedAt" BIGINT;

-- AlterTable
ALTER TABLE "event" ADD COLUMN     "createdByAccountId" INTEGER,
ADD COLUMN     "lastEditedByAccountId" INTEGER;

-- AlterTable
ALTER TABLE "homework" ADD COLUMN     "createdByAccountId" INTEGER,
ADD COLUMN     "lastEditedByAccountId" INTEGER;

-- CreateTable
CREATE TABLE "report" (
    "reportId" SERIAL NOT NULL,
    "classId" INTEGER,
    "targetType" TEXT NOT NULL,
    "targetId" INTEGER NOT NULL,
    "targetAccountId" INTEGER,
    "reporterAccountId" INTEGER,
    "reporterKey" TEXT NOT NULL,
    "reporterContact" TEXT,
    "category" TEXT NOT NULL,
    "description" TEXT,
    "snapshot" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "action" TEXT,
    "decisionReason" TEXT,
    "resolvedAt" BIGINT,
    "createdAt" BIGINT NOT NULL,

    CONSTRAINT "report_pkey" PRIMARY KEY ("reportId")
);

-- CreateTable
CREATE TABLE "block" (
    "blockId" SERIAL NOT NULL,
    "accountId" INTEGER NOT NULL,
    "blockedAccountId" INTEGER NOT NULL,
    "createdAt" BIGINT NOT NULL,

    CONSTRAINT "block_pkey" PRIMARY KEY ("blockId")
);

-- CreateTable
CREATE TABLE "moderationNotice" (
    "noticeId" SERIAL NOT NULL,
    "accountId" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" BIGINT NOT NULL,
    "seenAt" BIGINT,

    CONSTRAINT "moderationNotice_pkey" PRIMARY KEY ("noticeId")
);

-- CreateIndex
CREATE INDEX "report_targetType_targetId_idx" ON "report"("targetType", "targetId");

-- CreateIndex
CREATE INDEX "report_targetAccountId_idx" ON "report"("targetAccountId");

-- CreateIndex
CREATE INDEX "report_status_resolvedAt_idx" ON "report"("status", "resolvedAt");

-- CreateIndex
CREATE UNIQUE INDEX "block_accountId_blockedAccountId_key" ON "block"("accountId", "blockedAccountId");

-- CreateIndex
CREATE INDEX "moderationNotice_accountId_idx" ON "moderationNotice"("accountId");

-- AddForeignKey
ALTER TABLE "event" ADD CONSTRAINT "event_createdByAccountId_fkey" FOREIGN KEY ("createdByAccountId") REFERENCES "account"("accountId") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "event" ADD CONSTRAINT "event_lastEditedByAccountId_fkey" FOREIGN KEY ("lastEditedByAccountId") REFERENCES "account"("accountId") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "homework" ADD CONSTRAINT "homework_createdByAccountId_fkey" FOREIGN KEY ("createdByAccountId") REFERENCES "account"("accountId") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "homework" ADD CONSTRAINT "homework_lastEditedByAccountId_fkey" FOREIGN KEY ("lastEditedByAccountId") REFERENCES "account"("accountId") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "report" ADD CONSTRAINT "report_classId_fkey" FOREIGN KEY ("classId") REFERENCES "class"("classId") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "report" ADD CONSTRAINT "report_targetAccountId_fkey" FOREIGN KEY ("targetAccountId") REFERENCES "account"("accountId") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "report" ADD CONSTRAINT "report_reporterAccountId_fkey" FOREIGN KEY ("reporterAccountId") REFERENCES "account"("accountId") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "block" ADD CONSTRAINT "block_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "account"("accountId") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "block" ADD CONSTRAINT "block_blockedAccountId_fkey" FOREIGN KEY ("blockedAccountId") REFERENCES "account"("accountId") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "moderationNotice" ADD CONSTRAINT "moderationNotice_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "account"("accountId") ON DELETE CASCADE ON UPDATE NO ACTION;

