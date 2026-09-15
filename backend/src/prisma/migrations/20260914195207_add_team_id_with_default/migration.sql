-- AlterTable
ALTER TABLE "subjects" ADD COLUMN     "teamId" INTEGER NOT NULL DEFAULT -1;

-- CreateIndex
CREATE INDEX "subjects_teamId_idx" ON "subjects"("teamId");
