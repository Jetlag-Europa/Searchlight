-- AlterTable
ALTER TABLE "Game" ADD COLUMN "preloadChecksum" TEXT;

-- Assume each preloaded file is unchanged since its newest preloaded revision,
-- so the first start after this migration keeps revisions uploaded since.
-- A file whose current content has no preload revision (a reverted file, or an
-- upload copied into the file) is applied once on that start.
UPDATE "Game" g
SET "preloadChecksum" = (
    SELECT r."checksum"
    FROM "GameRevision" r
    WHERE r."gameId" = g."id" AND r."source" = 'preload'
    ORDER BY r."createdAt" DESC, r."revision" DESC
    LIMIT 1
);
