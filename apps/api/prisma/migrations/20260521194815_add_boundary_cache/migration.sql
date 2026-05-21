-- CreateTable
CREATE TABLE "BoundaryCache" (
    "osmId" TEXT NOT NULL,
    "osmType" TEXT NOT NULL,
    "geojson" JSONB NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BoundaryCache_pkey" PRIMARY KEY ("osmId","osmType")
);
