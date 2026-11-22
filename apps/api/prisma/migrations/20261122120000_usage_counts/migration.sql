-- AlterTable
ALTER TABLE "Game" ADD COLUMN     "localOpens" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "UsageCount" (
    "day" DATE NOT NULL,
    "event" TEXT NOT NULL,
    "count" INTEGER NOT NULL,

    CONSTRAINT "UsageCount_pkey" PRIMARY KEY ("day","event")
);
