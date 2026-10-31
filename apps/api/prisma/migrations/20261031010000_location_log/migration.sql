-- Tracker stack only (branch feat/location-tracker): every position the location
-- tracker reads, for later replays. Rows older than LOCATION_LOG_DAYS are deleted.
CREATE TABLE "LocationLog" (
    "id" BIGSERIAL NOT NULL,
    "account" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "accuracy" DOUBLE PRECISION,
    "battery" INTEGER,
    "charging" BOOLEAN,
    "recordedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LocationLog_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "LocationLog_account_personId_recordedAt_key" ON "LocationLog"("account", "personId", "recordedAt");
CREATE INDEX "LocationLog_account_recordedAt_idx" ON "LocationLog"("account", "recordedAt");
CREATE INDEX "LocationLog_recordedAt_idx" ON "LocationLog"("recordedAt");
