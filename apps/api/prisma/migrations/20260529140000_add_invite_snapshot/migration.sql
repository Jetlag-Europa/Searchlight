-- CreateTable
CREATE TABLE "InviteSnapshot" (
    "id" TEXT NOT NULL,
    "inviteId" TEXT NOT NULL,
    "questions" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InviteSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InviteSnapshot_inviteId_key" ON "InviteSnapshot"("inviteId");

-- AddForeignKey
ALTER TABLE "InviteSnapshot" ADD CONSTRAINT "InviteSnapshot_inviteId_fkey"
    FOREIGN KEY ("inviteId") REFERENCES "Invite"("id") ON DELETE CASCADE ON UPDATE CASCADE;
