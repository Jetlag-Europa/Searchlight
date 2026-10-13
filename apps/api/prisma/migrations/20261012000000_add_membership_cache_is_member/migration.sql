-- Role lookups cache non-members too (with no roles), so membership must be
-- recorded explicitly. Existing rows default to false and are re-fetched.
ALTER TABLE "ServerMembershipCache" ADD COLUMN "isMember" BOOLEAN NOT NULL DEFAULT false;
