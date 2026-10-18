-- A game's event date(s) and rules link, set from its game file or by its
-- managers, and the details its preloaded file had at the last API start.
ALTER TABLE "Game"
  ADD COLUMN "date" DATE,
  ADD COLUMN "endDate" DATE,
  ADD COLUMN "rulesUrl" TEXT,
  ADD COLUMN "preloadDetails" JSONB;

ALTER TABLE "Game" ADD CONSTRAINT "Game_endDate_check"
  CHECK ("endDate" IS NULL OR ("date" IS NOT NULL AND "endDate" >= "date"));
