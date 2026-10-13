-- Every session is pinned to a game revision. Sessions from before revisions
-- existed cannot be loaded (there is no fallback to the current definition)
-- and are not migrated: this release ships with a reset database.
DELETE FROM "GameSession" WHERE "gameRevisionId" IS NULL;

-- DropForeignKey
ALTER TABLE "GameSession" DROP CONSTRAINT "GameSession_gameRevisionId_fkey";

-- AlterTable
ALTER TABLE "GameSession" ALTER COLUMN "gameRevisionId" SET NOT NULL;

-- AddForeignKey
ALTER TABLE "GameSession" ADD CONSTRAINT "GameSession_gameRevisionId_fkey" FOREIGN KEY ("gameRevisionId") REFERENCES "GameRevision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
