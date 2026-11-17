-- AlterTable
ALTER TABLE "account" ADD COLUMN     "banGround" TEXT,
ADD COLUMN     "banReason" TEXT,
ADD COLUMN     "bannedAt" BIGINT;

-- AlterTable
ALTER TABLE "event" ADD COLUMN     "authorAccountId" INTEGER,
ADD COLUMN     "lastEditorAccountId" INTEGER;

-- AlterTable
ALTER TABLE "homework" ADD COLUMN     "authorAccountId" INTEGER,
ADD COLUMN     "lastEditorAccountId" INTEGER;

-- CreateTable
CREATE TABLE "report" (
    "reportId" SERIAL NOT NULL,
    "classId" INTEGER,
    "targetType" TEXT NOT NULL,
    "targetId" INTEGER NOT NULL,
    "targetAccountId" INTEGER,
    "editorAccountId" INTEGER,
    "reporterKey" TEXT NOT NULL,
    "reporterContact" TEXT,
    "category" TEXT NOT NULL,
    "description" TEXT,
    "snapshot" JSONB NOT NULL,
    "action" TEXT,
    "decisionGround" TEXT,
    "decisionReason" TEXT,
    "resolvedAt" BIGINT,
    "createdAt" BIGINT NOT NULL,

    CONSTRAINT "report_pkey" PRIMARY KEY ("reportId")
);

-- CreateTable
CREATE TABLE "moderationNotice" (
    "noticeId" SERIAL NOT NULL,
    "accountId" INTEGER NOT NULL,
    "reportId" INTEGER NOT NULL,
    "targetType" TEXT NOT NULL,
    "ground" TEXT NOT NULL,
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
CREATE INDEX "report_editorAccountId_idx" ON "report"("editorAccountId");

-- CreateIndex
CREATE INDEX "report_classId_idx" ON "report"("classId");

-- CreateIndex
CREATE INDEX "report_resolvedAt_idx" ON "report"("resolvedAt");

-- CreateIndex
CREATE INDEX "moderationNotice_accountId_idx" ON "moderationNotice"("accountId");

-- CreateIndex
CREATE INDEX "moderationNotice_createdAt_idx" ON "moderationNotice"("createdAt");

-- CreateIndex
CREATE INDEX "event_authorAccountId_idx" ON "event"("authorAccountId");

-- CreateIndex
CREATE INDEX "event_lastEditorAccountId_idx" ON "event"("lastEditorAccountId");

-- CreateIndex
CREATE INDEX "homework_authorAccountId_idx" ON "homework"("authorAccountId");

-- CreateIndex
CREATE INDEX "homework_lastEditorAccountId_idx" ON "homework"("lastEditorAccountId");

-- AddForeignKey
ALTER TABLE "event" ADD CONSTRAINT "event_authorAccountId_fkey" FOREIGN KEY ("authorAccountId") REFERENCES "account"("accountId") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "event" ADD CONSTRAINT "event_lastEditorAccountId_fkey" FOREIGN KEY ("lastEditorAccountId") REFERENCES "account"("accountId") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "homework" ADD CONSTRAINT "homework_authorAccountId_fkey" FOREIGN KEY ("authorAccountId") REFERENCES "account"("accountId") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "homework" ADD CONSTRAINT "homework_lastEditorAccountId_fkey" FOREIGN KEY ("lastEditorAccountId") REFERENCES "account"("accountId") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "report" ADD CONSTRAINT "report_classId_fkey" FOREIGN KEY ("classId") REFERENCES "class"("classId") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "report" ADD CONSTRAINT "report_targetAccountId_fkey" FOREIGN KEY ("targetAccountId") REFERENCES "account"("accountId") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "report" ADD CONSTRAINT "report_editorAccountId_fkey" FOREIGN KEY ("editorAccountId") REFERENCES "account"("accountId") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "moderationNotice" ADD CONSTRAINT "moderationNotice_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "account"("accountId") ON DELETE CASCADE ON UPDATE NO ACTION;

