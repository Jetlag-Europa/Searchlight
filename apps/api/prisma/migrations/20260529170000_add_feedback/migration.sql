CREATE TABLE "Feedback" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "severity" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Feedback_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FeedbackVote" (
    "id" TEXT NOT NULL,
    "feedbackId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FeedbackVote_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FeedbackImage" (
    "id" TEXT NOT NULL,
    "feedbackId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FeedbackImage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Feedback_type_idx" ON "Feedback"("type");
CREATE INDEX "Feedback_status_idx" ON "Feedback"("status");
CREATE INDEX "Feedback_createdAt_idx" ON "Feedback"("createdAt");

CREATE UNIQUE INDEX "FeedbackVote_feedbackId_userId_key" ON "FeedbackVote"("feedbackId", "userId");
CREATE INDEX "FeedbackVote_feedbackId_idx" ON "FeedbackVote"("feedbackId");

CREATE INDEX "FeedbackImage_feedbackId_idx" ON "FeedbackImage"("feedbackId");

ALTER TABLE "Feedback" ADD CONSTRAINT "Feedback_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("discordId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FeedbackVote" ADD CONSTRAINT "FeedbackVote_feedbackId_fkey" FOREIGN KEY ("feedbackId") REFERENCES "Feedback"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FeedbackVote" ADD CONSTRAINT "FeedbackVote_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("discordId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FeedbackImage" ADD CONSTRAINT "FeedbackImage_feedbackId_fkey" FOREIGN KEY ("feedbackId") REFERENCES "Feedback"("id") ON DELETE CASCADE ON UPDATE CASCADE;
