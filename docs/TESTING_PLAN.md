# Automated Testing Plan — headless verification of map/question logic

Goal: verify game features (tentacles, matching, measuring, …) **without a human
opening a browser**. Two layers, both asserting on *geometry*, not pixels:

1. **Logic layer** (Vitest, no browser) — evaluate a question directly in Node
   and assert on the returned GeoJSON: the compiled operators
   (`apps/web/src/maps/questions/operators/`) for a game's questions, the
   `adjustPer*` handlers for free play and player-drawn custom questions. Fast,
   deterministic, offline.
2. **Integration layer** (Playwright, later) — drive the real Astro/React app,
   read the *computed* GeoJSON back out of the app's nanostores via a `window`
   test hook, and run the same assertions. Catches wiring bugs the logic layer
   can't.

The unifying trick: each scenario is checked against an **independent oracle** —
the expected result computed a second, simpler way — so a passing test is real
evidence of correctness, not just "the code agrees with itself".

---

## Status

| Phase | Scope | State |
|-------|-------|-------|
| 1 | Tentacle logic harness + oracle | **Done** (`apps/web/tests/questions/`) |
| 2 | Extend oracle to matching / measuring / radius / thermometer + debug-image-on-failure | **Done** (`apps/web/tests/questions/`) |
| 3 | Playwright prerequisites: test-only login, `window` hook, seed, isolated stack | **Done** (`apps/web/e2e/`, `docker-compose.test.yml`) |
| 4 | Playwright: per-question rendering on the real map | Planned |
| 5 | Playwright: multi-client SSE sync | Planned |

Decisions locked with Jules: run **locally on demand** (Mac mini); gate on
**numeric/geometric assertions** (debug images are a failure aid only); e2e auth
via a **test-only login endpoint**; logic layer fully **fixtured/offline**, e2e
against an isolated **`writemap-test`** stack with Overpass stubbed.

### JSON game regression coverage

`pnpm --filter @searchlight/web exec vitest run` covers compiled planning/evaluation
parity, point/line/polygon datasets, clipped tentacle partitions, degenerate
Voronoi inputs, empty areas, bounded geometry caching and failed-cache retries,
latest-refresh scheduling, and concurrent pinned game loads.

Browser smoke verification must also exercise the module worker: Node tests
cannot demonstrate main-thread responsiveness or production worker asset loading.
Use a large measuring dataset (for example Paris Library, or North London's
Body of Water lines), alternate answers,
toggle planning without editing questions, and change the answer while a
calculation is pending. Confirm the latest answer is rendered, only one
elimination layer remains, and browser input/timers continue during calculation.
The Astro/Vite worker output uses ES modules because ArcGIS loads additional
geometry modules dynamically.

For session synchronization, the API provides an access-checked
`GET /sessions/:id/events/cursor` before content snapshots. The cursor is a
per-session commit-ordered sequence, not a client timestamp. Replay pages use
`GET /sessions/:id/events?after=<sequence>&limit=<1..250>` and buffer live
events until each page is applied in order. Content and its event commit in one
transaction; participant revocation closes existing streams. Run
`pnpm --filter @searchlight/api exec vitest run src/routes/events.test.ts src/routes/session-content.test.ts`
against an isolated migrated PostgreSQL database when changing this contract.
The web suite covers old-session gap fills, failed offline edits, save ordering,
reconnect gaps, and cross-account cache isolation.

For slow devices, profile the shipped Belgium definition with multiple answered
measuring questions and all 424 hiding zones. Region filtering should leave
browser timers responsive at a throttled CPU rate; warm timings alone do not
establish acceptable cold-load latency or memory use on a physical phone.

When running `ENABLE_TEST_AUTH=1` outside the isolated Docker stack, set
`HOST=127.0.0.1`; the API's normal container default binds to all interfaces.

For line layers with matching enabled, the nearest-line partition is built once
per layer in the geometry worker (`apps/web/src/maps/geo-utils/lineVoronoi.ts`)
from points sampled along each line: 25–250 m apart, following the closest
approach of lines that don't meet, and at most 20,000 samples per layer. The
seeker's answer is simply its nearest line. Boundaries between lines can
therefore be off by up to a sample step rather than being an exact segment
Voronoi (`tests/questions/lineMatching.test.ts`). Test competing lines at the
game's map scale and do not interpret metre-scale boundary differences as
precise GPS evidence.

Measuring buffers only the features that can reach the current map from the
seeker's distance (`geo-utils/bufferReach.ts`); the distance itself is always
taken over the whole layer. Stale buffer requests for the same question are
skipped in the worker queue (`geo-utils/workerQueue.ts`).

For containing-region boundary questions, verify the ArcGIS worker in a real
browser as well as running Turf-mocked unit tests. The automatic hider verdict
and per-region buffer must use the same ellipsoidal distance model; at the
equator a one-degree threshold differed from Turf's spherical result by about
124 metres in a browser reproduction.

---

## Phase 1 (done) — what exists, for reference

`apps/web/tests/questions/`:

- **`tentacleOracle.ts`** — independent re-derivation of a tentacle's result.
  A point survives iff `in base ∧ within radius ∧ nearest in-radius POI is the
  answer` — no Voronoi code. Provides `oracleVerdict`, `sampleGrid`,
  `sitesWithinRadius`. An `edgeMargin` skips points near radius/Voronoi edges
  (see "Oracle conditioning" below).
- **`tentacles.test.ts`** — 8 tests: grid-oracle agreement (well-separated POIs),
  planar-fallback structural checks (clustered POIs, the Entry 35 case),
  area/radius invariants, and hider resolution. These exercise the free-play
  handler; a game's tentacles are covered by `tentacleOperator.test.ts`.

Two seams, both documented in-code:
- `arcBuffer` is **stubbed with `turf.buffer`** via `vi.mock("@/maps/geo-utils")`
  — the real one loads `@arcgis/core` WASM that can't run under Node
  (`require is not defined`). A geodesic buffer *is* "points within radius", so
  the stub is faithful; the real Voronoi/union/intersect stay under test.
- Base map data is passed as a **`FeatureCollection`** (matches how the app calls
  `adjustPerTentacle`; `safeUnion` folds it before intersecting).

### Oracle conditioning — the lesson that shaped Phase 1

`geoSpatialVoronoi` reprojects a spherical Voronoi through Mercator with a
scaling fudge (the source comments "I thought this would yield the same … but
it's slightly larger"). Result: **cell boundaries drift from the true geodesic
bisector, and the error grows with distance from the POI centroid** — ~100 m
near the POIs, ~300 m a kilometre out. Consequences for testing:

- Use **small, tight scenarios** (POIs a few hundred metres apart, radius < 1 km)
  so the projection is accurate where the grid tests cell membership; let the
  radius circle eliminate everything further out (where both algorithms trivially
  agree).
- Treat points **near any edge as ambiguous** (`edgeMargin`, ~0.2 × radius) and
  skip them; assert only on the interior, which must agree exactly.
- For **tightly-clustered POIs**, far-field cell assignment is genuinely
  ill-conditioned (runner-up POI only ~150 m further) — don't grid-oracle it;
  assert structurally (fallback fires, mask valid, correct cell wins *near* the
  cluster).

> Side finding worth a real look someday: the Mercator reprojection error is a
> genuine (minor) inaccuracy in the app for spread-out POIs over a large game
> area. Not in scope here, just logged.

---

## Phase 2 — extend the harness to the other question types (DONE)

Shipped in `apps/web/tests/questions/`: `oracleCommon.ts` (shared `boundary`,
`sampleGrid`, `gridAgreement`, `OracleVerdict` — lifted out of
`tentacleOracle.ts`, which now re-uses them), `debugRender.ts` (SVG-on-failure),
and `radius.test.ts` / `thermometer.test.ts` / `matching.test.ts` /
`measuring.test.ts` (at the time: questions suite 26 green, web suite 136
green, harness tsc-clean). Findings worth carrying forward:

- **Thermometer two-point Voronoi is degenerate for an EAST–WEST pair.** With A
  and B on the same latitude, `geoSpatialVoronoi`'s reprojected hemispheres
  collapse onto the *same* side — `warmer` and `cooler` then return the identical
  mask. A NORTH–SOUTH (or diagonal) pair splits cleanly. The thermometer test
  uses a vertical pair on purpose; this is a real (minor) app limitation, logged
  not fixed — thermometer uses the raw `geoSpatialVoronoi`, not the repaired
  `geoSpatialVoronoiSafe` that tentacles/matching use.
- **A thermometer hider on the *gapped* side does not survive its own answer.**
  Because the two cells overlap near one site and gap near the other, a hider in
  the gap is assigned `warmer` from the cell it's outside of and then eliminated.
  So the test asserts only *directional* consistency (opposite sides ⇒ opposite
  `warmer`), not the survive-your-own-answer invariant.
- **Region containment is the clean, exact oracle** (no Voronoi,
  winding-agnostic) — `matching.test.ts` takes the real South Limburg
  municipalities from `games/preloaded/south-limburg-2026.game.json` and uses
  one as a player-drawn custom zone, and also asserts the layer is a
  `FeatureCollection` (the Entry 34 bug guard).
- **Faithful stubs for the WASM helpers:** `arcBuffer` → `turf.buffer`;
  `arcBufferToPoint` → min-geodesic-distance-then-buffer-and-union (in miles, the
  helper's `DEFAULT_BUFFER_UNIT`). `modifyMapData`/`holedMask`/`safeUnion` and the
  real Voronoi stay under test.

---

## Phase 3 — Playwright prerequisites (DONE)

All four prereqs shipped and verified end to end (smoke spec green against the
live stack):

- **Test-only login** — `POST /auth/test-login`, registered only when
  `ENABLE_TEST_AUTH=1` (so it doesn't exist in prod). Upserts the user and mints
  a session cookie, skipping Discord. Env flags in `apps/api/src/lib/env.ts`
  (`ENABLE_TEST_AUTH`, `TEST_AUTH_USER_ID`); unit-tested in `auth.test.ts`.
- **`window.__searchlight` hook** — `apps/web/src/lib/testHook.ts`, installed from
  `Map.tsx`, gated by `PUBLIC_ENABLE_TEST_HOOK=1` (a web **build arg**, baked at
  build time). Exposes live getters for `mapGeoJSON` (the play area),
  `eliminationGeoJSON` (the elimination mask the answered questions produce),
  `polyGeoJSON`, `questions` and `hiderMode`.
- **Isolated stack** — `docker-compose.test.yml` (project `writemap-test`): own
  Postgres volume, API with `ENABLE_TEST_AUTH=1`, web built with the hook, and a
  stub Overpass. Brought up + seeded by `infra/deploy-test.sh`. Ports: web 8280,
  api 3200, pg 5435. Config in `.env.test` (see `.env.test.example`).
- **Deterministic seed** — `apps/api/prisma/seed-test.ts` (`pnpm --filter api
  seed:test`): stable `e2e-test-user` + `e2e-session` on South Limburg 2026. The
  API imports the game from `games/preloaded` on boot (run the seed after it
  is up), and a game's questions use only its own data, so they work offline.
- **Overpass stub** — `infra/overpass-stub.conf` (nginx): returns a valid-but-
  empty Overpass payload for any query, so free-play (no game) questions and
  boundary lookups resolve deterministically offline. Games never query
  Overpass.
- **Playwright** — `apps/web/playwright.config.ts` + `e2e/` (`fixtures.ts`,
  `smoke.e2e.ts`). Run with `pnpm --filter web test:e2e` after the stack is up.

### Gotchas worth knowing (Phase 3)

- **Use `127.0.0.1`, not `localhost`, everywhere** (Playwright baseURL, baked
  `PUBLIC_API_BASE`, `FRONTEND_ORIGIN`). The stack binds IPv4 only; Chromium
  resolves `localhost` → IPv6 `::1` → `ERR_CONNECTION_REFUSED`.
- Specs are `*.e2e.ts` (not `.test.ts`/`.spec.ts`) so Vitest never runs them.
- **Block the service worker** in the Playwright context (`serviceWorkers:
  "block"`) — the PWA/workbox SW interferes with navigation on the plain-http
  stack.
- Two **source fixes** were needed for the port-mapped http stack, both made
  proxy-safe for all envs: `nginx.conf` now uses `absolute_redirect off` (so the
  `/map`→`/map/` redirect keeps the published port), and `Layout.astro`'s
  http→https guard now exempts `127.0.0.1` / `::1` (not just `localhost`).
- The session cookie is `SameSite=Lax` in non-prod; web (:8280) and api (:3200)
  are the same site (both `127.0.0.1`), so the cookie rides cross-port requests —
  a browser-context test-login authenticates subsequent app calls.

## Phases 4–5 — Playwright e2e (summary; detail when we get there)
- **4. Rendering:** per question type — log in, open the seeded session, set the
  question, read `window.__searchlight.eliminationGeoJSON`, run the **Phase 1/2 assertions**
  on it, and confirm a tagged `eliminationGeoJSON` Leaflet layer exists in the
  DOM (Leaflet renders SVG by default — no `preferCanvas`).
- **5. SSE sync:** two browser contexts, same session; an action in A (stroke /
  hider toggle / question change) appears in B within a timeout. Targets the
  Entry 32–33 echo/bounce-back bug class.

---

## How to run

```
cd apps/web
pnpm exec vitest run                               # all web tests, incl. tests/questions/ (`pnpm test` watches)
pnpm exec vitest run tests/questions/              # just the question harness
```

(Playwright scripts — `pnpm test:e2e`, `pnpm test:e2e:headed` — added in Phase 3.)
