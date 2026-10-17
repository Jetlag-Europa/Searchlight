-- AlterTable
ALTER TABLE "Game" ADD COLUMN "preloadChecksum" TEXT;

-- Assume each preloaded file is unchanged since its newest preloaded revision,
-- so the first start after this migration keeps revisions uploaded since.
UPDATE "Game" g
SET "preloadChecksum" = (
    SELECT r."checksum"
    FROM "GameRevision" r
    WHERE r."gameId" = g."id" AND r."source" = 'preload'
    ORDER BY r."createdAt" DESC, r."revision" DESC
    LIMIT 1
);
