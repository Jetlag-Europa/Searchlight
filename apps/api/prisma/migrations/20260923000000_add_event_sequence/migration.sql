-- AlterTable
ALTER TABLE "GameSession" ADD COLUMN IF NOT EXISTS "eventSequence" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Event" ADD COLUMN IF NOT EXISTS "sequence" INTEGER;

-- Backfill Event.sequence deterministically per session in (serverReceivedAt ASC, id ASC) order
WITH ranked AS (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY "sessionId" ORDER BY "serverReceivedAt" ASC, "id" ASC) as seq
  FROM "Event"
)
UPDATE "Event"
SET "sequence" = ranked.seq
FROM ranked
WHERE "Event"."id" = ranked.id AND "Event"."sequence" IS NULL;

-- Ensure sequence is not null
UPDATE "Event" SET "sequence" = 0 WHERE "sequence" IS NULL;
ALTER TABLE "Event" ALTER COLUMN "sequence" SET NOT NULL;

-- Backfill GameSession.eventSequence with MAX(sequence) per session
UPDATE "GameSession"
SET "eventSequence" = COALESCE(
  (SELECT MAX("sequence") FROM "Event" WHERE "Event"."sessionId" = "GameSession"."id"),
  0
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Event_sessionId_sequence_key" ON "Event"("sessionId", "sequence");
