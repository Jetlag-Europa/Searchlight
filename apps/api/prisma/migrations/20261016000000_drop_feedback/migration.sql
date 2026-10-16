-- In-app feedback is replaced by GitHub Issues. This permanently deletes all
-- feedback items, votes and images.

-- DropForeignKey
ALTER TABLE "Feedback" DROP CONSTRAINT "Feedback_userId_fkey";

-- DropForeignKey
ALTER TABLE "FeedbackImage" DROP CONSTRAINT "FeedbackImage_feedbackId_fkey";

-- DropForeignKey
ALTER TABLE "FeedbackVote" DROP CONSTRAINT "FeedbackVote_feedbackId_fkey";

-- DropForeignKey
ALTER TABLE "FeedbackVote" DROP CONSTRAINT "FeedbackVote_userId_fkey";

-- DropTable
DROP TABLE "Feedback";

-- DropTable
DROP TABLE "FeedbackImage";

-- DropTable
DROP TABLE "FeedbackVote";
