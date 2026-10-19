# One-off import of the old Searchlight's sessions

The old prod (the Azure "writemap" stack, fork commit `c7363de`) kept its own
database. These files move its sessions into the current database once:

| File | What it does |
|---|---|
| `question-map.json` | Old question type per old game and family → current question ID, or `null` with the reason |
| `report-question-map.ts` | Checks the map against TSV exports of the old questions |
| `export-legacy.sql` | Exports what the import needs from the old DB as one JSON file |
| `import-sessions.mjs` | The import. Runs inside the API container; dry run unless `--apply`; `--rollback` undoes an applied run |
| `export-imported.sql` | Exports the imported sessions with their pinned revisions for the checker |
| `apps/web/tests/legacyImportCheck.test.ts` | Runs every imported question through the app's own schema, support check and operators |

## What is imported

- **Sessions**, keeping their IDs, names, visibility, hider position, planning
  mode and timestamps. Each is pinned to its game's **current** revision at
  import time, with an empty event log. The old sentinel picks the game
  (`question-map.json` `gameId`, for example `__bundled-brno-2026-v2__` →
  `brno-2026`). A hider position of (0, 0) becomes none, like migration
  `20261017003000`.
- **Participants, questions, strokes, share links and link snapshots.** Old
  share-link tokens keep working.
- **Users** the imported rows reference who aren't in the database yet. Their
  OAuth tokens are left blank (nothing reads them after login) and their
  preferences are copied. Users who already exist are left as they are.
- **Questions are remapped** with `question-map.json`: old type → current
  question ID; zone questions by the payload's `cat.adminLevel`. Tentacle
  answers are snapped to the matching site of the current layer (within 250 m),
  because the app matches them by exact coordinates.
- **Dropped and listed in the report:** questions with no equivalent in the
  current game (the app would hide them anyway), and questions the app's
  schema rejects. The old app saved a few of those, such as a cleared radius
  field (`null`).
- **Not imported:** auth sessions, events, invites, feedback, the boundary
  cache, membership caches and role permissions.

A second run skips sessions already in the database. Clashing unique keys
(question/stroke `clientUuid`, link tokens) abort the run before anything is
written.

## Run book

Prerequisite: the games' restored layers (PR #63) are deployed. Sessions are
pinned to the revisions that are current when the import runs.

1. **Freeze the old stack** so nothing changes after the dump. On the Azure
   box, stop the `writemap` API and web containers. Leave Postgres running.
2. **Dump the old DB** to this host:
   ```sh
   ssh jules@<azure> 'docker exec writemap-postgres-1 pg_dump -Fc -U taibled taibled' > legacy.dump
   ```
3. **Restore it in a scratch container** and export the JSON:
   ```sh
   docker run -d --name sl-legacy-import --network none \
     -e POSTGRES_USER=taibled -e POSTGRES_PASSWORD=x -e POSTGRES_DB=taibled postgres:16
   docker exec -i sl-legacy-import pg_restore -U taibled -d taibled --no-owner < legacy.dump
   docker exec -i sl-legacy-import psql -X -At -v ON_ERROR_STOP=1 -U taibled -d taibled \
     < scripts/legacy-import/export-legacy.sql > legacy-export.json
   ```
4. **Back up the target DB:**
   `docker exec sl-prod-postgres-1 pg_dump -Fc -U searchlight searchlight > before-import.dump`
5. **Dry run** in the API container, then read the report. Expect the
   dropped questions to be the `null` entries of the map plus the malformed
   ones, and no skipped sessions:
   ```sh
   docker exec sl-prod-api-1 mkdir -p /tmp/legacy-import
   for f in scripts/legacy-import/import-sessions.mjs scripts/legacy-import/question-map.json legacy-export.json; do
     docker cp "$f" sl-prod-api-1:/tmp/legacy-import/
   done
   docker exec -w /tmp/legacy-import sl-prod-api-1 node import-sessions.mjs \
     --export legacy-export.json --map question-map.json --report dry-run-report.json
   ```
6. **Apply:** the same command with `--report apply-report.json --apply`.
   Copy `apply-report.json` out of the container and keep it: rollback needs it.
7. **Check the result** with the app's code:
   ```sh
   docker cp sl-prod-api-1:/tmp/legacy-import/apply-report.json .
   docker cp scripts/legacy-import/export-imported.sql sl-prod-postgres-1:/tmp/
   jq -r '.importedSessionIds[]' apply-report.json | docker exec -i sl-prod-postgres-1 \
     psql -X -At -q -v ON_ERROR_STOP=1 -U searchlight -d searchlight -f /tmp/export-imported.sql > imported.json
   LEGACY_IMPORT_CHECK=$PWD/imported.json LEGACY_IMPORT_CHECK_OUT=$PWD/check.json \
     pnpm --filter @searchlight/web exec vitest run tests/legacyImportCheck.test.ts
   ```
   Measuring questions need ArcGIS's WASM, which doesn't run under Node, so
   the checker only counts them. Open a few imported sessions with measuring
   questions in a browser.
8. **Clean up:** remove the scratch container and the copies in `/tmp` of
   both containers. The exports hold user data.

**Rollback:** `node import-sessions.mjs --rollback apply-report.json`, then add
`--apply`. It deletes the imported sessions (their participants, questions,
strokes, links and snapshots cascade) and the users the import created,
unless they have logged in or created anything since. For anything worse,
restore `before-import.dump`.

## Rehearsal (2026-10-19, PR #63 preview)

Done on a copy of prod in the PR #63 preview, after the preview applied the
pending migration and the PR's game revisions:
- **Imported:** 654 sessions, 173 new users (13 already existed), 752
  participants, 1,621 questions, 1,192 strokes, 135 links and 80 snapshots.
- **Dropped:** 39 session questions and 1 snapshot question. 30 + 1 have no
  equivalent in the current game; 9 were malformed.
- **Checker:** passes on all 1,770 questions. All 15 tentacle answers snapped
  0 m.
- **Rollback and re-run:** a rollback restored prod's counts exactly; a second
  run skipped everything.
