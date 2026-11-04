-- Google map loads the web app reports, for usage counts on the admin page.

-- CreateTable
CREATE TABLE "GoogleMapLoad" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionId" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GoogleMapLoad_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GoogleMapLoad_createdAt_idx" ON "GoogleMapLoad"("createdAt");

-- AddForeignKey
ALTER TABLE "GoogleMapLoad" ADD CONSTRAINT "GoogleMapLoad_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("discordId") ON DELETE CASCADE ON UPDATE CASCADE;

