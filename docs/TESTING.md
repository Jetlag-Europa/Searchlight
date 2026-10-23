# Testing

```bash
pnpm --filter @searchlight/web exec vitest run   # web: question geometry, sync, game compiler (`test` watches)
pnpm --filter @searchlight/shared test           # game definition schema, validator, checksum
pnpm --filter @searchlight/api test              # API routes against a real Postgres
pnpm verify:preloaded-games                      # every bundled game: validator and strict data checks
pnpm check:game-schema                           # published JSON schema matches the TypeBox schema
pnpm --filter @searchlight/web typecheck         # web: astro sync + tsc (astro build doesn't type-check)
pnpm --filter @searchlight/web lint:check        # web: ESLint without --fix (`lint` fixes and runs Prettier)
```

The API tests need a migrated database. They use the dev one from
`docker-compose.dev.yml` (`pnpm dev` migrates it) unless `DATABASE_URL` is set,
and create and delete their own rows.

CI (`.github/workflows/test.yml`) runs all of the above on every pull request
and push to `main`, after `pnpm build`.

## Question geometry

`apps/web/tests/questions/` checks each question type's elimination mask
against an independent **oracle**: the expected result worked out a second,
simpler way (e.g. "a point survives a tentacle question iff it is within the
radius and its nearest site is the answer") and sampled on a grid. Points
within `edgeMargin` of a boundary are skipped, because the app's Voronoi cells
are reprojected through Mercator and drift from the true geodesic boundaries
(about 100 m near the sites, more further out). Keep scenarios small and
tight for the same reason. A failing case writes an SVG to
`apps/web/test-results/`.

Most question tests replace `arcBuffer` and `arcBufferToPoint` with Turf
equivalents (`vi.mock("@/maps/geo-utils")`); the Voronoi, union and
intersection code stays under test. The buffer tests (`projectedBuffer`,
`bufferHoles`, `borderNetwork`) run the real `@arcgis/core` projection engine
instead: they import `tests/arcgisNode.ts` first, which lets its browser WASM
load under Node.

## End-to-end (Playwright)

The e2e stack is the production images with test switches, on its own
database: the API accepts `POST /auth/test-login` (`ENABLE_TEST_AUTH=1`) and
the web build exposes the map state as `window.__searchlight`
(`PUBLIC_ENABLE_TEST_HOOK=1`).

```bash
infra/deploy-test.sh                                        # build, start and seed (needs the dev .env)
pnpm --filter @searchlight/web exec playwright install chromium  # once
pnpm --filter @searchlight/web test:e2e
infra/deploy-test.sh down                                   # tear down
```

The seed (`apps/api/prisma/seed-test.ts`) creates the `e2e-test-user` and the
`e2e-session` on South Limburg 2026. Specs live in `apps/web/e2e/*.e2e.ts`.

- Use `127.0.0.1`, not `localhost`: the stack listens on IPv4 only, and
  Chromium resolves `localhost` to `::1`.
- The Playwright context blocks the service worker, which serves pages and
  scripts from its precache: a test could run the build it cached instead of
  the deployed one.
- Run the API with `ENABLE_TEST_AUTH=1` anywhere else only with
  `HOST=127.0.0.1`: test login skips Discord entirely.

## On a preview deployment

On PR previews and staging (`https://sl-pr-<N>.dev.jl-e.org`) you can log in
as any Discord user without Discord: the API registers `/auth/dev-login` when
`DEV_LOGIN_TOKEN` is set (at least 32 characters). Prod never sets it. The token is `DEV_LOGIN_TOKEN` in the preview server's
`secrets/preview.env`.

- In a browser, open `https://sl-pr-<N>-api.dev.jl-e.org/auth/dev-login`,
  enter a Discord user ID and the token, and you land on `/map` as that user.
- From a script or Playwright, `POST` it with the token as a bearer token. In
  Playwright, use the page's own request context so the browser gets the cookie:

  ```ts
  await page.request.post(`${API}/auth/dev-login`, {
      headers: { authorization: `Bearer ${process.env.DEV_LOGIN_TOKEN}` },
      data: { discordId: "123456789012345678" },
  });
  await page.goto(`${WEB}/map`);
  ```

  With curl, keep the cookie in a jar: `curl -c jar -H "authorization: Bearer
  $DEV_LOGIN_TOKEN" -H 'content-type: application/json' -d
  '{"discordId":"…"}' $API/auth/dev-login`, then `curl -b jar $API/me`.

A real Discord ID gets that user's name and avatar, and their servers and roles
through the bot as usual. Any other numeric ID (15–21 digits, e.g.
`100000000000000001`) becomes a placeholder user who is in no server. Use
several of those to play as more than one person.

## In a real browser

Unit tests can't show these; check them by hand after changing geometry or
sync code:

- Geometry runs in a module worker. With a large measuring dataset (Paris
  libraries, North London's water lines), change answers while a calculation
  is still running: the latest answer wins, one elimination layer remains, and
  the page stays responsive.
- Containing-region questions use ArcGIS's ellipsoidal distances in the
  worker, where Turf (in the unit tests) is spherical; at the equator they
  differ by about 120 m per degree.
- On slow devices, Belgium 2026 (424 hiding zones) with several measuring
  questions answered should keep the page responsive.
