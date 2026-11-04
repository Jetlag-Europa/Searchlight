# Deployment

Searchlight ships as two Docker images plus Postgres:

- **api** runs `prisma migrate deploy`, creates any Discord servers missing
  from the database, imports every `games/preloaded/*.game.json`, then starts
  Fastify on port 3000. A changed game becomes a new revision; running
  sessions stay on the revision they started with. `GET /health` returns
  `{"ok":true}`. It compresses its own responses (brotli or gzip), so a proxy
  in front of it doesn't need to, but it must pass `/sessions/:id/stream`
  (live updates) through unbuffered.
- **web** is nginx serving the static build on port 80. The API URL
  (`PUBLIC_API_BASE`) is baked in when the image is built.

On every push to `main`, the "Docker images" workflow builds both for
`linux/amd64` and `linux/arm64` and pushes them to
`ghcr.io/jetlag-europa/searchlight-{api,web}`, tagged `sha-<7-char commit>` and
`latest`. Publishing a release also tags its images with the version, such as
`2.0.0` and `2.0` (see `docs/releases/README.md`). Its web image is built for `https://api.searchlight.jetlageuropa.org`;
for any other API URL, build the images on the server.

## Compose files

`docker-compose.yml` is the whole stack with no published ports. An overlay
adds the way in:

| Overlay | Use |
| --- | --- |
| `docker-compose.cloudflared.yml` | Web and API behind a Cloudflare Tunnel, nothing published on the host. |
| `docker-compose.backend.yml` | API and Postgres only, API on a host port (`API_BIND`, `API_PORT`). The web app is hosted elsewhere, e.g. [on Cloudflare](#web-app-on-cloudflare). |
| `docker-compose.test.yml` | The e2e test stack ([`docs/TESTING.md`](docs/TESTING.md)). |

`docker-compose.dev.yml` is unrelated: the Postgres for local development.

A server chooses with `COMPOSE_FILE` in its `.env`, and `COMPOSE_PROJECT_NAME`
names the stack, so plain `docker compose` commands work there without flags.
`docker-compose.yml` refuses to run without a project name: with the default
(the directory name) a server would start a second, empty database.

## Set up a server

1. **Docker:** install Docker Engine with the Compose plugin
   (`curl -fsSL https://get.docker.com | sudo sh`) and add your user to the
   `docker` group.
2. **Code:**
   ```bash
   git clone https://github.com/Jetlag-Europa/Searchlight.git
   cd Searchlight
   ```
   To clone over SSH instead, add a read-only deploy key (repo Settings
   → Deploy keys) and clone with it:
   ```bash
   ssh-keygen -t ed25519 -f ~/.ssh/searchlight_deploy -N ''   # add the .pub as the deploy key
   GIT_SSH_COMMAND='ssh -i ~/.ssh/searchlight_deploy -o IdentitiesOnly=yes' \
     git clone git@github.com:Jetlag-Europa/Searchlight.git
   cd Searchlight
   git config core.sshCommand 'ssh -i ~/.ssh/searchlight_deploy -o IdentitiesOnly=yes'
   ```
3. **Images:** if the GHCR packages are private, log in once with a classic
   GitHub token that has only `read:packages`. Public packages need no login,
   and neither does `--build`:
   ```bash
   docker login ghcr.io -u <github-user>
   ```
4. **Config:** `cp .env.prod.example .env`, fill in the empty values
   (`ADMIN_DISCORD_IDS` and `PUBLIC_GOOGLE_MAPS_API_KEY` may stay empty), pick
   the `COMPOSE_FILE` line, and `chmod 600 .env`.
5. **Ingress:** set up the [Cloudflare Tunnel](#cloudflare-tunnel), or point
   your own proxy at the API port with the backend overlay.
6. **Start:** as in the update below.

## Deploy an update

```bash
git pull
docker compose pull && docker compose up -d   # the latest images CI built from main
docker compose up -d --build                  # or: build them here from the checkout
docker image prune -f                         # drop the images the update replaced
```

Wait for the commit's "Docker images" run to finish before pulling; until it
has, `latest` is still the previous commit.

Players' browsers keep the web app they have (its service worker,
`apps/web/src/sw.ts`) until they choose **Reload** on the "new version"
message, so the previous web build talks to the new API for a while after
every update. Keep API changes working with it.

- **Stay on a release:** set `SEARCHLIGHT_IMAGE_TAG` in `.env` to a release's
  version, such as `2.0` (its latest fixes) or `2.0.0` (exactly that release),
  then pull and `up -d`. Published releases are listed on
  [GitHub Releases](https://github.com/Jetlag-Europa/Searchlight/releases).
- **Pin a commit:** set `SEARCHLIGHT_IMAGE_TAG=sha-<7-char commit>` in `.env`,
  then pull and `up -d`. Remove it to follow `latest` again.
- Either one, to an older version than the server ran, is a rollback: read
  [Roll back](#roll-back) first.
- **Another API hostname:** change `PUBLIC_API_BASE` and `DISCORD_REDIRECT_URI`
  in `.env` and deploy with `--build` (or change the build arg in
  `.github/workflows/docker-images.yml`).

## Roll back

Going back to an older version works like any update, except across two
changes that older versions can't handle.

**The installable app** (`e29c68aa6`, #81; releases up to 2.0.0 are older). Once a browser has opened a version with it, it keeps that version's
service worker (`/sw.js`) whatever the server sends later. An older web build
has a `/sw.js` too, which its own pages never register; served to those
browsers, it takes over at once, answers every page (`/play?token=…`,
`/join?token=…`, `/map/`, `/games/`, `/admin/`) with the home page, even
online, and leaves open pages on files that are gone. Removing `/sw.js`
doesn't help either: a browser keeps a worker it can't update.

- Never deploy an older web build as it is, or pin its image, on a site that
  has served the installable app.
- Deploy the older source with `selfDestroying: true` added as the first
  option inside `AstroPWA({ ... })` in `apps/web/astro.config.mjs` instead.
  Its `/sw.js` removes the worker and its caches and reloads open pages into
  the older version, which then loads from the network. A tab opened with a
  forced reload (Ctrl+Shift+R on a computer) isn't under the worker, so it
  keeps running the newer version until it is reloaded.
- Keep serving that `/sw.js` for as long as the older version runs: a phone
  that was offline or asleep picks it up at its next update check. Going
  forward again is an ordinary update.
- Edits still waiting to be sent when a page switches to the older version
  (from a phone that was offline, say) don't show there, and are sent when
  you go forward again. That can put back an old hider position or
  planning-mode value: check them after going forward.

**Spectator links** (`8d65fff46`, #85). Migrations stay applied when you go
back: don't restore a backup to undo them, as that loses everything played
since. Older APIs ignore the newer tables and columns, but not the `viewer`
participant role. An older API fails with a 500 on every session that has a
spectator, for all its players, and redeems a spectator link as an invite, so
the spectator becomes a member who can edit and see the hider. So before
starting an API from before #85:

1. Stop the newer API. Nothing may write while you do this: a spectator
   joining in between would bring a viewer back.
2. Run, in one transaction:

   ```sql
   BEGIN;
   UPDATE "SessionLink" SET "revokedAt" = now()
   WHERE "linkType" = 'view' AND "revokedAt" IS NULL;
   DELETE FROM "SessionParticipant" WHERE role = 'viewer';
   COMMIT;
   ```

   Spectators lose access and their links stop working. Players and their
   sessions keep everything. Leave the `viewer` enum value alone.
3. Start the older API.

### Going back to before the installable app, with these compose files

Prepare the images before releasing, so a rollback doesn't wait for a build.
Use the commit you would go back to, and the API URL of this server:

```bash
git worktree add --detach ../searchlight-rollback <commit>
sed -i 's/^\( *\)AstroPWA({$/&\n\1    selfDestroying: true,/' \
  ../searchlight-rollback/apps/web/astro.config.mjs
grep -A1 'AstroPWA({' ../searchlight-rollback/apps/web/astro.config.mjs  # shows the new line
docker build -f ../searchlight-rollback/apps/api/Dockerfile \
  -t ghcr.io/jetlag-europa/searchlight-api:rollback ../searchlight-rollback
docker build -f ../searchlight-rollback/apps/web/Dockerfile \
  --build-arg PUBLIC_API_BASE=https://<API host> \
  -t ghcr.io/jetlag-europa/searchlight-web:rollback ../searchlight-rollback
```

To roll back:

```bash
docker compose stop api
infra/backup.sh
docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1' <<'SQL'
BEGIN;
UPDATE "SessionLink" SET "revokedAt" = now()
WHERE "linkType" = 'view' AND "revokedAt" IS NULL;
DELETE FROM "SessionParticipant" WHERE role = 'viewer';
COMMIT;
SQL
# Set SEARCHLIGHT_IMAGE_TAG=rollback in .env (and don't `docker compose pull` while it's set)
docker compose up -d
curl -fsS https://<web host>/sw.js | grep -c registration.unregister   # 1: the self-destroying worker
```

Then, in a browser that used the newer version, open the app online: an open
page reloads into the older version, and game, invite and session links open
their own pages again.

## Google Maps basemap

Players can pick Google Maps as the basemap when the web image is built with
`PUBLIC_GOOGLE_MAPS_API_KEY`: in `.env` when building on the server, as
the repository variable of that name for the CI image, or in the environment
of a [Cloudflare](#web-app-on-cloudflare) build. Without it the option isn't
offered. The key ships to every browser, so in
[Google Cloud](https://console.cloud.google.com/apis/credentials):

- enable the **Maps JavaScript API** for the project (billing must be on),
- restrict the key to websites (`https://<web host>/*`) and to the Maps
  JavaScript API only,
- cap **Map loads per day** under Google Maps Platform → Quotas, and set a
  budget alert.

Google bills a map load each time the page creates its map, not per tile: a
player costs about one per app start, whatever they zoom or pan, and only once
they choose Google's map (even if it never draws on a bad connection). 10,000 loads a month are free; Google Cloud shows the
loads per day under the API's metrics. Google's terms don't allow caching its
map, so the app stores none of it: offline, a Google map that has already
drawn keeps what's on screen and one that hasn't shows CARTO Voyager, and a
page printed from the browser leaves Google's map out. The terms also require telling users that
the app includes Google Maps and linking Google's terms and privacy policy;
Options does that under the basemap picker. Which terms apply depends on the
billing account's country: outside the EEA they restrict using Google's map
"with or near" non-Google maps. The app never shows both, but it does show
CARTO Voyager by itself: while Google's map loads (Google's layer is on the
map then, hidden), offline before it has drawn, and when Google can't load.

## Cloudflare Tunnel

The tunnel is locally managed: no token, nothing in the Cloudflare dashboard.
Create it once with the `cloudflared` CLI (`cloudflared tunnel login`, then
`cloudflared tunnel create searchlight`), and put the credentials file it
writes (`~/.cloudflared/<tunnel-id>.json`) next to a `config.yml` in
`../cloudflared` beside the clone (or `CLOUDFLARED_DIR`):

```yaml
tunnel: <tunnel-id>
credentials-file: /etc/cloudflared/<tunnel-id>.json
ingress:
  - hostname: searchlight.jetlageuropa.org
    service: http://web:80
  - hostname: api-searchlight.jetlageuropa.org
    service: http://api:3000
  - service: http_status:404
```

`sudo chown -R 65532:65532 ../cloudflared` lets the container user read it.
`cloudflared tunnel route dns searchlight <hostname>` creates each DNS record.
cloudflared doesn't reload its config: `docker compose restart cloudflared`
after editing it.

Keep public hostnames one level under the zone (`api-searchlight.…`, not
`api.searchlight.…`): Cloudflare's free certificate only covers `*.<zone>`.

## Web app on Cloudflare

With the backend overlay, the web app can be served by Cloudflare Workers as
static assets: `wrangler.json` (repo root) and `apps/web/wrangler.json` (for a
project rooted in `apps/web`) point at the build output. Build with
`pnpm install && pnpm --filter @searchlight/web build` and `PUBLIC_API_BASE`
set to the API's URL, then `npx wrangler deploy`. Set the API's
`FRONTEND_ORIGIN` to the site's exact origin: the API rejects writes from
browsers on any other origin with a 403.

Game links hosted this way preview with the site-wide description only. In the
Docker image, nginx sends link-preview bots' requests for `/play`, and requests
for `/og/`, to the API (`apps/api/src/routes/og.ts`) for the game's name and
map; Workers static-asset hosting has no such step.

## Operations

```bash
docker compose ps
docker compose logs -f api
apps/api/scripts/auth-walls.sh <COMPOSE_PROJECT_NAME>-api-1   # summarise 401s by client
```

### Backups

`infra/backup.sh` writes a gzipped `pg_dump` to `../backups` beside the clone
(or `BACKUP_DIR`) and deletes dumps older than 30 days. Dumps are not
encrypted. Nightly, via `crontab -e`:

```cron
0 3 * * * /path/to/Searchlight/infra/backup.sh >> /var/log/searchlight-backup.log 2>&1
```

**Restore** into an empty database, before the API starts:

```bash
docker compose down -v            # deletes the database
docker compose up -d --wait postgres
gunzip -c <dump>.sql.gz | docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
docker compose up -d
```

**Start over** with an empty database: back up, then `docker compose down -v`
and `docker compose up -d`. The API recreates the schema, servers and games; users
log in again and role mappings changed in the admin UI are lost.

## Production

| | |
| --- | --- |
| Web | <https://searchlight.jetlageuropa.org> |
| API | <https://api.searchlight.jetlageuropa.org> (`/health`) |

Production runs the head of the `prod` branch: a release moves `prod` to a
commit on `main`. Its server builds the images from that commit itself and
isn't run with these compose files, so `SEARCHLIGHT_IMAGE_TAG` doesn't apply
to it. [Roll back](#roll-back) applies to it all the same.

The compose files' `taibled` database and user predate the Searchlight name.
They stay as they are.

Each environment's `DISCORD_REDIRECT_URI` must be registered in the Discord
application (OAuth2 → Redirects):
`https://api.searchlight.jetlageuropa.org/auth/discord/callback` for
production, `http://localhost:3000/auth/discord/callback` for development.
