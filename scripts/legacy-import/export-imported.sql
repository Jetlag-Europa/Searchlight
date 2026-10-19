-- Exports the sessions an import created, with their link snapshots and the
-- game revisions they are pinned to, for apps/web/tests/legacyImportCheck.test.ts.
-- Reads the session IDs, one per line, from standard input. See README.md.
--
-- jq -r '.importedSessionIds[]' apply-report.json |
--   psql -X -At -q -v ON_ERROR_STOP=1 -U searchlight -d searchlight -f export-imported.sql > imported.json
create temp table ids (id text primary key);
\copy ids from pstdin
select json_build_object(
  'revisions', (select json_object_agg(r.id, json_build_object(
      'gameKey', g."gameKey", 'revision', r.revision, 'definition', r.definition))
    from "GameRevision" r join "Game" g on g.id = r."gameId"
    where r.id in (select "gameRevisionId" from "GameSession" where id in (select id from ids))),
  'sessions', (select json_agg(json_build_object(
      'id', s.id, 'revisionId', s."gameRevisionId",
      'hider', case when s."hiderLat" is null then null else json_build_array(s."hiderLng", s."hiderLat") end,
      'questions', (select coalesce(json_agg(q."payloadJson" order by q.ordinal), '[]')
        from "SessionQuestion" q where q."sessionId" = s.id)))
    from "GameSession" s where s.id in (select id from ids)),
  'snapshots', (select coalesce(json_agg(json_build_object(
      'id', n.id, 'revisionId', n."gameRevisionId",
      'questions', (select coalesce(json_agg(e->'payloadJson'), '[]') from json_array_elements(n.questions::json) e))), '[]')
    from "LinkSnapshot" n join "SessionLink" l on l.id = n."linkId"
    where l."sessionId" in (select id from ids))
);
