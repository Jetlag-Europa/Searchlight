-- Backfill gameKey from sentinelValue for all existing games so existing sessions survive
UPDATE "Game" SET "gameKey" = 
  CASE 
    WHEN "sentinelValue" = '__bundled-paris-2026__' THEN 'paris-2026'
    WHEN "sentinelValue" = '__bundled-bucharest-2026__' THEN 'bucharest-2026'
    WHEN "sentinelValue" = '__bundled-exter-rotterdam-2026__' THEN 'exter-rotterdam-2026'
    WHEN "sentinelValue" = '__bundled-south-limburg-2026__' THEN 'south-limburg-2026'
    WHEN "sentinelValue" = '__bundled-stockholm-2026__' THEN 'stockholm-2026'
    WHEN "sentinelValue" = '__bundled-brno-2026-v2__' THEN 'brno-2026'
    WHEN "sentinelValue" = '__bundled-luxembourg-2026__' THEN 'luxembourg-2026'
    WHEN "sentinelValue" = '__bundled-bern-2026__' THEN 'bern-2026'
    WHEN "sentinelValue" = '__bundled-brussels-2026__' THEN 'brussels-2026'
    WHEN "sentinelValue" = '__bundled-zurich-2026__' THEN 'zurich-2026'
    WHEN "sentinelValue" = '__bundled-budapest-2025__' THEN 'budapest-2025'
    WHEN "sentinelValue" = '__bundled-belgium-2026__' THEN 'belgium-2026'
    WHEN "sentinelValue" = '__bundled-london-2026__' THEN 'london-2026'
    WHEN "sentinelValue" = '__bundled-accessible-london-2026__' THEN 'accessible-london-2026'
    WHEN "sentinelValue" = '__bundled-graz-2026__' THEN 'graz-2026'
    ELSE COALESCE("gameKey", "id")
  END
WHERE "gameKey" IS NULL;

-- Drop legacy columns from Game table
ALTER TABLE "Game" ALTER COLUMN "gameKey" SET NOT NULL;
ALTER TABLE "Game" DROP COLUMN IF EXISTS "sentinelValue";
ALTER TABLE "Game" DROP COLUMN IF EXISTS "kmlPath";
ALTER TABLE "Game" DROP COLUMN IF EXISTS "mapLocationJson";
ALTER TABLE "Game" DROP COLUMN IF EXISTS "hidingRadius";
ALTER TABLE "Game" DROP COLUMN IF EXISTS "hidingRadiusUnits";
ALTER TABLE "Game" DROP COLUMN IF EXISTS "tierRadiusOverrides";
ALTER TABLE "Game" DROP COLUMN IF EXISTS "hidingZoneGeoJsonPath";
