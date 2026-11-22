-- Daily usage counts the web app reports, for the admin page.

-- CreateTable
CREATE TABLE "UsageCount" (
    "day" DATE NOT NULL,
    "event" TEXT NOT NULL,
    "count" INTEGER NOT NULL,

    CONSTRAINT "UsageCount_pkey" PRIMARY KEY ("day","event")
);
