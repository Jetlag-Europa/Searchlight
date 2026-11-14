-- The Google map load counts are gone again: drop the table the previous
-- migration created. Databases that already ran it (staging, previews) lose
-- it; on fresh ones the two migrations cancel out.

-- DropTable
DROP TABLE IF EXISTS "GoogleMapLoad";
