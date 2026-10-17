-- Turning hider mode off saved the hider position as 0, 0 instead of null,
-- which reopened hider mode there. No game plays at 0, 0, so clear it.
UPDATE "GameSession" SET "hiderLat" = NULL, "hiderLng" = NULL
WHERE "hiderLat" = 0 AND "hiderLng" = 0;
