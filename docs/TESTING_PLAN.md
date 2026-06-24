# Automated Testing Plan — headless verification of map/question logic

Goal: verify game features (tentacles, matching, measuring, …) **without a human
opening a browser**. Two layers, both asserting on *geometry*, not pixels:

1. **Logic layer** (Vitest, no browser) — run a question's `adjustPer*` directly
   in Node and assert on the returned GeoJSON. Fast, deterministic, offline.
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
| 2 | Extend oracle to matching / measuring / radius / thermometer + debug-image-on-failure | **Next** (this doc) |
| 3 | Playwright prerequisites: test-only login, `window` hook, seed | Planned |
| 4 | Playwright: per-question rendering on the real map | Planned |
| 5 | Playwright: multi-client SSE sync | Planned |

Decisions locked with Jules: run **locally on demand** (Mac mini); gate on
**numeric/geometric assertions** (debug images are a failure aid only); e2e auth
via a **test-only login endpoint**; logic layer fully **fixtured/offline**, e2e
against an isolated **`writemap-test`** stack with Overpass stubbed.

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
  area/radius invariants, and hider resolution.

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

## Phase 2 — extend the harness to the other question types (NEXT)

Same recipe as tentacles: build a per-question oracle, grid-sample, assert
agreement on clear points + invariants, and stub `arcBuffer` where used. Reuse
`sampleGrid` / the ambiguity pattern from `tentacleOracle.ts` (consider lifting
the shared bits into `questions/oracleCommon.ts`).

### 2a. Radius — `adjustPerRadius` (`questions/radius.ts`)
Simplest. Result = base ∩ circle (when `within`) or base − circle (when
`!within`). Uses `arcBuffer` → **stub it**.
- **Oracle:** point survives iff `in base ∧ (within === (dist ≤ radius))`.
- Invariants: `within` result ⊆ circle; `!within` result disjoint from the
  open circle; area ≤ base.
- `hiderifyRadius`: hider inside radius ⇒ `within = true`, else `false` (pure
  distance, easy direct assertions).

### 2b. Thermometer — `adjustPerThermometer` (`questions/thermometer.ts`)
Two points A,B; `geoSpatialVoronoi` of `[A,B]`; keep cell `[1]` if `warmer`,
else `[0]`. No `arcBuffer`. **Note:** indexes Voronoi features by position, so
confirm which of `features[0]/[1]` corresponds to A vs B before writing the
oracle (don't assume).
- **Oracle:** "warmer" region = points closer to B than A (the half-plane
  bisector of A,B); assert survive iff `in base ∧ on the correct side`.
- Apply the same Mercator edge-margin near the bisector.
- `hiderifyThermometer`: sets `warmer` from which point the hider is nearer.

### 2c. Matching — `adjustPerMatching` (`questions/matching.ts`)
Most involved: matching has POI/zone/admin-boundary variants and routes through
`determineMatchingBoundary` + `geoSpatialVoronoiSafe`. For **POI-category
matching**, the oracle mirrors tentacles (nearest-POI cell, `same` keeps the
seeker's cell, `!same` removes it). For **bundled-GeoJSON matching**
(municipality/postcode/sector), the oracle is exact and winding-agnostic:
survive iff the point's containing feature equals (or, for `!same`, differs
from) the seeker's containing feature — no Voronoi, no edge-margin needed.
- Start with one bundled-GeoJSON game fixture (e.g. South Limburg municipalities
  or Rotterdam) since it's the cleanest oracle and covers the real Entry 34
  "municipality doesn't work" class of bug.
- Guard the **FeatureCollection requirement** for `*-border.geojson` here too
  (a bare Feature silently no-ops — Entry 34).

### 2d. Measuring — `adjustPerMeasuring` (`questions/measuring.ts`)
Distance-to-feature bands. Key gotcha from Entry 35: `arcBufferToPoint` distance
is **0 inside a polygon**, so border-measuring must use the boundary *line*, not
the filled polygon. Oracle: survive iff `in base ∧ geodesic distance to the
target feature is on the correct side of the threshold`. Uses arc buffers →
**stub** the arcgis-backed helpers (`arcBuffer`, `arcBufferToPoint`).

### 2e. Debug-image-on-failure helper (`questions/debugRender.ts`)
~30–50 lines, **no browser**: given base, POIs, the computed mask, optional
Voronoi cells + hider, emit a standalone **SVG** (simple lng/lat→viewBox scale)
to `apps/web/test-results/<scenario>.svg`. Call it from the oracle checker only
when `failures.length > 0`. This is the human aid for "why did this point
disagree" — the image is **never the gate**; the numeric assertion is.

### Phase 2 acceptance
- Each question type has ≥1 grid-oracle test (or exact-containment test where
  Voronoi isn't involved) with non-vacuous survive/eliminate counts, plus
  invariants and hider tests.
- Full `pnpm --filter web test` stays green; no new heavy deps.

---

## Phases 3–5 — Playwright e2e (summary; detail when we get there)

- **3. Prereqs:** `POST /auth/test-login` gated by `ENABLE_TEST_AUTH=1` (mints a
  session cookie for a seeded user, skips Discord); a `window.__taibled` hook
  exposing `mapGeoJSON / polyGeoJSON / questions / hiderMode` (test-flag only);
  an isolated `writemap-test` Docker stack + seed; Overpass stubbed via fixtures.
- **4. Rendering:** per question type — log in, open the seeded session, set the
  question, read `window.__taibled.mapGeoJSON`, run the **Phase 1/2 assertions**
  on it, and confirm a tagged `eliminationGeoJSON` Leaflet layer exists in the
  DOM (Leaflet renders SVG by default — no `preferCanvas`).
- **5. SSE sync:** two browser contexts, same session; an action in A (stroke /
  hider toggle / question change) appears in B within a timeout. Targets the
  Entry 32–33 echo/bounce-back bug class.

---

## How to run

```
cd apps/web
pnpm test                      # all web vitest, incl. tests/questions/
npx vitest run tests/questions/tentacles.test.ts   # just the question harness
```

(Playwright scripts — `pnpm test:e2e`, `pnpm test:e2e:headed` — added in Phase 3.)
