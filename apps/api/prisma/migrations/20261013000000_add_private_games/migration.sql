-- Private games: an unlisted game is left out of the game picker, and sessions
-- of it start from reusable game links. Existing games stay listed.

-- CreateEnum
CREATE TYPE "GameListing" AS ENUM ('listed', 'unlisted');

-- AlterTable
ALTER TABLE "Game" ADD COLUMN "listing" "GameListing" NOT NULL DEFAULT 'listed',
ADD COLUMN "ownerId" TEXT;

-- CreateTable
CREATE TABLE "GameLink" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "gameId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "label" TEXT,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GameLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GameLink_token_key" ON "GameLink"("token");
CREATE INDEX "GameLink_gameId_idx" ON "GameLink"("gameId");
CREATE INDEX "Game_ownerId_idx" ON "Game"("ownerId");

-- AddForeignKey
ALTER TABLE "Game" ADD CONSTRAINT "Game_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("discordId") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "GameLink" ADD CONSTRAINT "GameLink_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "Game"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GameLink" ADD CONSTRAINT "GameLink_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("discordId") ON DELETE RESTRICT ON UPDATE CASCADE;
