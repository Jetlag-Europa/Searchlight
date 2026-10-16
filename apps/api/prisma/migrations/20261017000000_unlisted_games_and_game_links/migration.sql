-- AlterTable
ALTER TABLE "Game" ADD COLUMN "unlisted" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "GameSession" ADD COLUMN "gameLinkId" TEXT;

-- CreateTable
CREATE TABLE "GameLink" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "gameId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GameLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GameLink_token_key" ON "GameLink"("token");

-- CreateIndex
CREATE INDEX "GameLink_gameId_idx" ON "GameLink"("gameId");

-- CreateIndex
CREATE INDEX "GameSession_gameLinkId_idx" ON "GameSession"("gameLinkId");

-- AddForeignKey
ALTER TABLE "GameLink" ADD CONSTRAINT "GameLink_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "Game"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GameLink" ADD CONSTRAINT "GameLink_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("discordId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GameSession" ADD CONSTRAINT "GameSession_gameLinkId_fkey" FOREIGN KEY ("gameLinkId") REFERENCES "GameLink"("id") ON DELETE SET NULL ON UPDATE CASCADE;
