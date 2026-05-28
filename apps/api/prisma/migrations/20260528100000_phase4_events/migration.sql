CREATE TABLE "Event" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payloadJson" JSONB NOT NULL,
    "clientUuid" TEXT NOT NULL,
    "clientCreatedAt" TIMESTAMPTZ NOT NULL,
    "serverReceivedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT "Event_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Event_clientUuid_key" UNIQUE ("clientUuid"),
    CONSTRAINT "Event_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "GameSession"("id") ON DELETE CASCADE,
    CONSTRAINT "Event_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("discordId") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "Event_sessionId_serverReceivedAt_idx" ON "Event"("sessionId", "serverReceivedAt");
