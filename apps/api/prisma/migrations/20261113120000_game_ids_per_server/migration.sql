-- A game's id (gameKey) is unique per server, and on Casual Games per
-- creator, instead of across all servers.
ALTER TABLE "Game" ADD COLUMN "ownerScope" TEXT NOT NULL DEFAULT '';

-- Exter Rotterdam 26 is no longer preloaded. Where it was preloaded after
-- 20261103120000_exter_rotterdam_owner ran, it has no owner yet.
UPDATE "Game" SET "createdById" = '538811632759865374'
WHERE "gameKey" = 'exter-rotterdam-2026' AND "serverId" = 'home-games' AND "createdById" IS NULL;

-- Casual games are their creator's. Those without a recorded creator keep ''.
UPDATE "Game" SET "ownerScope" = "createdById"
WHERE "serverId" = 'home-games' AND "createdById" IS NOT NULL;

-- The new index is built before the old one is dropped: gameKey is unique
-- today, so every (serverId, ownerScope, gameKey) is too, and if building it
-- ever failed the old index would still be in place.
-- CreateIndex
CREATE UNIQUE INDEX "Game_serverId_ownerScope_gameKey_key" ON "Game"("serverId", "ownerScope", "gameKey");

-- DropIndex
DROP INDEX "Game_gameKey_key";
