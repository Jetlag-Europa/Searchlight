-- Inviting a specific user is gone; join and share links (SessionLink) stay.
-- This permanently deletes all invites, pending ones included, and the
-- question snapshots of invites to a copy.

-- DropForeignKey
ALTER TABLE "Invite" DROP CONSTRAINT "Invite_invitedByUserId_fkey";

-- DropForeignKey
ALTER TABLE "Invite" DROP CONSTRAINT "Invite_invitedUserId_fkey";

-- DropForeignKey
ALTER TABLE "Invite" DROP CONSTRAINT "Invite_sessionId_fkey";

-- DropForeignKey
ALTER TABLE "InviteSnapshot" DROP CONSTRAINT "InviteSnapshot_gameRevisionId_fkey";

-- DropForeignKey
ALTER TABLE "InviteSnapshot" DROP CONSTRAINT "InviteSnapshot_inviteId_fkey";

-- DropTable
DROP TABLE "Invite";

-- DropTable
DROP TABLE "InviteSnapshot";
