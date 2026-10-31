-- Tracker stack only (branch feat/location-tracker): which Google account's
-- location sharing a server's sessions show, and each session's pins.
ALTER TABLE "Server" ADD COLUMN "locationAccount" TEXT;
ALTER TABLE "GameSession" ADD COLUMN "livePins" JSONB NOT NULL DEFAULT '{"shown":[],"labels":{}}';
