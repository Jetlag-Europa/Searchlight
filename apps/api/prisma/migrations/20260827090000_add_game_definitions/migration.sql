-- AlterTable: Server
ALTER TABLE "Server" ADD COLUMN "managementGuildId" TEXT;

-- AlterTable: Game
ALTER TABLE "Game" ADD COLUMN "gameKey" TEXT;
ALTER TABLE "Game" ADD COLUMN "currentRevisionId" TEXT;
ALTER TABLE "Game" ADD COLUMN "archivedAt" TIMESTAMP(3);
ALTER TABLE "Game" ALTER COLUMN "sentinelValue" DROP NOT NULL;
ALTER TABLE "Game" ALTER COLUMN "kmlPath" DROP NOT NULL;
ALTER TABLE "Game" ALTER COLUMN "mapLocationJson" DROP NOT NULL;
ALTER TABLE "Game" ALTER COLUMN "hidingRadius" DROP NOT NULL;
ALTER TABLE "Game" ALTER COLUMN "hidingRadiusUnits" DROP NOT NULL;

-- CreateTable: GameRevision
CREATE TABLE "GameRevision" (
    "id" TEXT NOT NULL,
    "gameId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "formatVersion" INTEGER NOT NULL DEFAULT 1,
    "definition" JSONB NOT NULL,
    "checksum" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'api',
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GameRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable: GameImportToken
CREATE TABLE "GameImportToken" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "permissions" TEXT[] NOT NULL,
    "createdBy" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GameImportToken_pkey" PRIMARY KEY ("id")
);

-- AlterTable: GameSession
ALTER TABLE "GameSession" ADD COLUMN "gameRevisionId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Game_gameKey_key" ON "Game"("gameKey");
CREATE INDEX "Game_currentRevisionId_idx" ON "Game"("currentRevisionId");
CREATE UNIQUE INDEX "GameRevision_gameId_revision_key" ON "GameRevision"("gameId", "revision");
CREATE UNIQUE INDEX "GameRevision_gameId_checksum_key" ON "GameRevision"("gameId", "checksum");
CREATE INDEX "GameRevision_gameId_idx" ON "GameRevision"("gameId");
CREATE INDEX "GameRevision_checksum_idx" ON "GameRevision"("checksum");
CREATE UNIQUE INDEX "GameImportToken_tokenHash_key" ON "GameImportToken"("tokenHash");
CREATE INDEX "GameImportToken_serverId_idx" ON "GameImportToken"("serverId");
CREATE INDEX "GameImportToken_tokenHash_idx" ON "GameImportToken"("tokenHash");
CREATE INDEX "GameSession_gameRevisionId_idx" ON "GameSession"("gameRevisionId");

-- AddForeignKey
ALTER TABLE "GameRevision" ADD CONSTRAINT "GameRevision_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "Game"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Game" ADD CONSTRAINT "Game_currentRevisionId_fkey" FOREIGN KEY ("currentRevisionId") REFERENCES "GameRevision"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "GameImportToken" ADD CONSTRAINT "GameImportToken_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "GameSession" ADD CONSTRAINT "GameSession_gameRevisionId_fkey" FOREIGN KEY ("gameRevisionId") REFERENCES "GameRevision"("id") ON DELETE SET NULL ON UPDATE CASCADE;
