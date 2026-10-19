-- Exports what the one-off session import needs from the old Searchlight DB
-- (the Azure "writemap" prod) as one JSON document. See README.md.
--
-- psql -X -At -v ON_ERROR_STOP=1 -U taibled -d taibled -f export-legacy.sql > legacy-export.json
--
-- Left out on purpose: AuthSession (everyone logs in again), Event (the new app
-- starts each imported session's event log empty), Invite/InviteSnapshot,
-- Feedback*, BoundaryCache, ServerMembershipCache and RolePermission. Users'
-- Discord OAuth tokens are not exported either: nothing reads them after login.
select json_build_object(
  'exportedAt', now(),
  'games', (select coalesce(json_agg(json_build_object(
      'id', g.id, 'serverId', g."serverId", 'name', g.name, 'sentinel', g."sentinelValue"
    ) order by g.id), '[]') from "Game" g),
  'users', (select coalesce(json_agg(json_build_object(
      'discordId', u."discordId", 'username', u.username, 'displayName', u."displayName",
      'avatarUrl', u."avatarUrl", 'preferences', u.preferences,
      'createdAt', u."createdAt", 'updatedAt', u."updatedAt"
    ) order by u."discordId"), '[]') from "User" u),
  'sessions', (select coalesce(json_agg(json_build_object(
      'id', s.id, 'gameId', s."gameId", 'serverId', s."serverId", 'creatorId', s."creatorId",
      'name', s.name, 'visibility', s.visibility, 'hiderLat', s."hiderLat", 'hiderLng', s."hiderLng",
      'planningModeEnabled', s."planningModeEnabled", 'createdAt', s."createdAt", 'updatedAt', s."updatedAt"
    ) order by s."createdAt", s.id), '[]') from "GameSession" s),
  'participants', (select coalesce(json_agg(json_build_object(
      'sessionId', p."sessionId", 'userId', p."userId", 'role', p.role,
      'invitedAt', p."invitedAt", 'acceptedAt', p."acceptedAt", 'revokedAt', p."revokedAt"
    ) order by p."sessionId", p."userId"), '[]') from "SessionParticipant" p),
  'questions', (select coalesce(json_agg(json_build_object(
      'id', q.id, 'sessionId', q."sessionId", 'payloadJson', q."payloadJson", 'ordinal', q.ordinal,
      'clientUuid', q."clientUuid", 'createdAt', q."createdAt", 'updatedAt', q."updatedAt"
    ) order by q."sessionId", q.ordinal, q.id), '[]') from "SessionQuestion" q),
  'strokes', (select coalesce(json_agg(json_build_object(
      'id', k.id, 'sessionId', k."sessionId", 'userId', k."userId", 'payloadJson', k."payloadJson",
      'clientUuid', k."clientUuid", 'createdAt', k."createdAt", 'deletedAt', k."deletedAt"
    ) order by k."sessionId", k."createdAt", k.id), '[]') from "Stroke" k),
  'links', (select coalesce(json_agg(json_build_object(
      'id', l.id, 'token', l.token, 'sessionId', l."sessionId", 'createdById', l."createdById",
      'linkType', l."linkType", 'revokedAt', l."revokedAt", 'createdAt', l."createdAt"
    ) order by l."createdAt", l.id), '[]') from "SessionLink" l),
  'linkSnapshots', (select coalesce(json_agg(json_build_object(
      'id', n.id, 'linkId', n."linkId", 'questions', n.questions, 'createdAt', n."createdAt"
    ) order by n."createdAt", n.id), '[]') from "LinkSnapshot" n)
);
