-- CreateTable
CREATE TABLE "SessionLink" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "linkType" TEXT NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SessionLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SessionLink_token_key" ON "SessionLink"("token");

-- CreateIndex
CREATE INDEX "SessionLink_sessionId_idx" ON "SessionLink"("sessionId");

-- AddForeignKey
ALTER TABLE "SessionLink" ADD CONSTRAINT "SessionLink_sessionId_fkey"
    FOREIGN KEY ("sessionId") REFERENCES "GameSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SessionLink" ADD CONSTRAINT "SessionLink_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User"("discordId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "LinkSnapshot" (
    "id" TEXT NOT NULL,
    "linkId" TEXT NOT NULL,
    "questions" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LinkSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LinkSnapshot_linkId_key" ON "LinkSnapshot"("linkId");

-- AddForeignKey
ALTER TABLE "LinkSnapshot" ADD CONSTRAINT "LinkSnapshot_linkId_fkey"
    FOREIGN KEY ("linkId") REFERENCES "SessionLink"("id") ON DELETE CASCADE ON UPDATE CASCADE;
