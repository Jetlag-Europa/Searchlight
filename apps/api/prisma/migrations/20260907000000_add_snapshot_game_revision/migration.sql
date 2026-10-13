-- AlterTable
ALTER TABLE "InviteSnapshot" ADD COLUMN "gameRevisionId" TEXT;

-- AlterTable
ALTER TABLE "LinkSnapshot" ADD COLUMN "gameRevisionId" TEXT;

-- CreateIndex
CREATE INDEX "InviteSnapshot_gameRevisionId_idx" ON "InviteSnapshot"("gameRevisionId");

-- CreateIndex
CREATE INDEX "LinkSnapshot_gameRevisionId_idx" ON "LinkSnapshot"("gameRevisionId");

-- AddForeignKey
ALTER TABLE "InviteSnapshot" ADD CONSTRAINT "InviteSnapshot_gameRevisionId_fkey" FOREIGN KEY ("gameRevisionId") REFERENCES "GameRevision"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LinkSnapshot" ADD CONSTRAINT "LinkSnapshot_gameRevisionId_fkey" FOREIGN KEY ("gameRevisionId") REFERENCES "GameRevision"("id") ON DELETE SET NULL ON UPDATE CASCADE;
