-- v2.4.0: moderation panel
-- CreateEnum
CREATE TYPE "ReportTargetType" AS ENUM ('homework', 'event', 'upload', 'account');

-- CreateEnum
CREATE TYPE "ReportCategory" AS ENUM ('illegal', 'harassment', 'hate', 'sexual', 'spam', 'privacy', 'other');

-- CreateEnum
CREATE TYPE "ModerationAction" AS ENUM ('dismiss', 'remove', 'ban', 'remove_and_ban', 'rotate_class_code');

-- CreateEnum
CREATE TYPE "DecisionGround" AS ENUM ('terms', 'illegal');

-- AlterTable
ALTER TABLE "account" ADD COLUMN     "banGround" "DecisionGround",
ADD COLUMN     "banReason" TEXT,
ADD COLUMN     "bannedAt" BIGINT;

-- AlterTable
ALTER TABLE "event" ADD COLUMN     "authorAccountId" INTEGER,
ADD COLUMN     "lastEditorAccountId" INTEGER;

-- AlterTable
ALTER TABLE "homework" ADD COLUMN     "authorAccountId" INTEGER,
ADD COLUMN     "lastEditorAccountId" INTEGER;

-- AlterTable
ALTER TABLE "upload" ADD COLUMN     "lastEditorAccountId" INTEGER;

-- CreateTable
CREATE TABLE "report" (
    "reportId" SERIAL NOT NULL,
    "classId" INTEGER,
    "targetType" "ReportTargetType" NOT NULL,
    "targetId" INTEGER NOT NULL,
    "targetAccountId" INTEGER,
    "editorAccountId" INTEGER,
    "reporterKey" TEXT,
    "reporterContact" TEXT,
    "category" "ReportCategory" NOT NULL,
    "description" TEXT,
    "snapshot" JSONB NOT NULL,
    "action" "ModerationAction",
    "decisionGround" "DecisionGround",
    "decisionReason" TEXT,
    "resolvedAt" BIGINT,
    "createdAt" BIGINT NOT NULL,

    CONSTRAINT "report_pkey" PRIMARY KEY ("reportId")
);

-- CreateTable
CREATE TABLE "mailQueue" (
    "mailId" SERIAL NOT NULL,
    "recipient" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "nextAttemptAt" BIGINT NOT NULL,
    "createdAt" BIGINT NOT NULL,

    CONSTRAINT "mailQueue_pkey" PRIMARY KEY ("mailId")
);

-- CreateIndex
CREATE INDEX "report_targetType_targetId_idx" ON "report"("targetType", "targetId");

-- CreateIndex
CREATE INDEX "report_targetAccountId_idx" ON "report"("targetAccountId");

-- CreateIndex
CREATE INDEX "report_editorAccountId_idx" ON "report"("editorAccountId");

-- CreateIndex
CREATE INDEX "report_classId_idx" ON "report"("classId");

-- CreateIndex
CREATE INDEX "report_resolvedAt_idx" ON "report"("resolvedAt");

-- CreateIndex (manual: partial unique index, not expressible in schema.prisma yet)
-- one open report per reporter and target, so a report filed twice in parallel is created once
CREATE UNIQUE INDEX "report_open_reporter_target_key" ON "report"("reporterKey", "targetType", "targetId") WHERE "resolvedAt" IS NULL;

-- CreateIndex
CREATE INDEX "mailQueue_nextAttemptAt_idx" ON "mailQueue"("nextAttemptAt");

-- CreateIndex
CREATE INDEX "event_authorAccountId_idx" ON "event"("authorAccountId");

-- CreateIndex
CREATE INDEX "event_lastEditorAccountId_idx" ON "event"("lastEditorAccountId");

-- CreateIndex
CREATE INDEX "homework_authorAccountId_idx" ON "homework"("authorAccountId");

-- CreateIndex
CREATE INDEX "homework_lastEditorAccountId_idx" ON "homework"("lastEditorAccountId");

-- CreateIndex
CREATE INDEX "upload_lastEditorAccountId_idx" ON "upload"("lastEditorAccountId");

-- AddForeignKey
ALTER TABLE "event" ADD CONSTRAINT "event_authorAccountId_fkey" FOREIGN KEY ("authorAccountId") REFERENCES "account"("accountId") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "event" ADD CONSTRAINT "event_lastEditorAccountId_fkey" FOREIGN KEY ("lastEditorAccountId") REFERENCES "account"("accountId") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "homework" ADD CONSTRAINT "homework_authorAccountId_fkey" FOREIGN KEY ("authorAccountId") REFERENCES "account"("accountId") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "homework" ADD CONSTRAINT "homework_lastEditorAccountId_fkey" FOREIGN KEY ("lastEditorAccountId") REFERENCES "account"("accountId") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "upload" ADD CONSTRAINT "upload_lastEditorAccountId_fkey" FOREIGN KEY ("lastEditorAccountId") REFERENCES "account"("accountId") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "report" ADD CONSTRAINT "report_classId_fkey" FOREIGN KEY ("classId") REFERENCES "class"("classId") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "report" ADD CONSTRAINT "report_targetAccountId_fkey" FOREIGN KEY ("targetAccountId") REFERENCES "account"("accountId") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "report" ADD CONSTRAINT "report_editorAccountId_fkey" FOREIGN KEY ("editorAccountId") REFERENCES "account"("accountId") ON DELETE SET NULL ON UPDATE NO ACTION;

