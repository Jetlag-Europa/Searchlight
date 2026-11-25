-- Game histories start at the audit log (20261122130000): add an entry for each
-- stored revision uploaded without one, at its upload time. An upload's own
-- entry comes milliseconds after the revision (same transaction, but Prisma
-- stamps each row); a later entry with the same revision number is a
-- re-activation, not the upload, so it doesn't count. Audit logging went live
-- with an API restart, which takes longer than the 5 seconds allowed. Re-running
-- adds nothing.
INSERT INTO "AuditLog" (id, "createdAt", "serverId", "actorId", action, "targetId", "targetName", details)
SELECT 'backfill_' || r.id, r."createdAt", g."serverId", r."createdBy",
  CASE WHEN r.revision = (SELECT min(revision) FROM "GameRevision" WHERE "gameId" = g.id)
    THEN 'game.create' ELSE 'game.revision' END,
  g.id, COALESCE(r.definition->>'name', g.name),
  jsonb_build_object('revision', r.revision, 'source', r.source)
FROM "GameRevision" r JOIN "Game" g ON g.id = r."gameId"
WHERE NOT EXISTS (
  SELECT 1 FROM "AuditLog" a
  WHERE a."targetId" = g.id AND a.action IN ('game.create', 'game.revision')
    AND a.details->>'revision' = r.revision::text
    AND a."createdAt" <= r."createdAt" + interval '5 seconds')
ON CONFLICT (id) DO NOTHING;
