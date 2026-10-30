-- AlterTable
ALTER TABLE "Game" ADD COLUMN "createdById" TEXT;

-- Existing games were created by whoever imported their first revision.
UPDATE "Game" g
SET "createdById" = first."createdBy"
FROM (
  SELECT DISTINCT ON ("gameId") "gameId", "createdBy"
  FROM "GameRevision"
  ORDER BY "gameId", "createdAt" ASC, revision ASC
) first
WHERE first."gameId" = g.id AND first."createdBy" IS NOT NULL;

-- Home Games becomes Casual Games: its creator roles come from JetLag EU's
-- Discord guild, and its games are only reachable through game links.
UPDATE "Server"
SET name = 'Casual Games', "managementGuildId" = '1190673594649415730', "updatedAt" = CURRENT_TIMESTAMP
WHERE id = 'home-games';

UPDATE "Game" SET unlisted = true WHERE "serverId" = 'home-games';
