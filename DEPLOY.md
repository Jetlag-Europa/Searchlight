# Deployment

Searchlight ships as two Docker images plus Postgres:

- **api** runs `prisma migrate deploy`, creates any Discord servers missing
  from the database, then starts Fastify on port 3000, which imports every
  `games/preloaded/*.game.json`. A changed game becomes a new revision; running
  sessions stay on the revision they started with. `GET /health` returns
  `{"ok":true}`.
- **web** is nginx serving the static build on port 80. The API URL
  (`PUBLIC_API_BASE`) is baked in when the image is built.

On every push to `main`, the "Docker images" workflow builds both for
`linux/amd64` and `linux/arm64` and pushes them to
`ghcr.io/jetlag-europa/searchlight-{api,web}`, tagged `sha-<7-char commit>` and
`latest`. Publishing a release also tags its images with the version, such as
`2.0.0` and `2.0` (see `docs/releases/README.md`). Its web image is built for `https://api-searchlight.jetlageuropa.org`;
for any other API URL, build the images on the server.

## Compose files

`docker-compose.yml` is the whole stack with no published ports. An overlay
adds the way in:

| Overlay | Use |
| --- | --- |
| `docker-compose.cloudflared.yml` | Web and API behind a Cloudflare Tunnel, nothing published on the host. Production. |
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
4. **Config:** `cp .env.prod.example .env`, fill in every empty value, pick the
   `COMPOSE_FILE` line, and `chmod 600 .env`.
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
- **Roll back** or pin a commit: set `SEARCHLIGHT_IMAGE_TAG=sha-<7-char commit>`
  in `.env`, then pull and `up -d`. Remove it to follow `latest` again.
- **Another API hostname:** change `PUBLIC_API_BASE` in `.env` and deploy with
  `--build` (or change the build arg in `.github/workflows/docker-images.yml`).

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
apps/api/scripts/auth-walls.sh writemap-api-1   # summarise 401s by client
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
gunzip -c <dump>.sql.gz | docker compose exec -T postgres psql -U taibled -d taibled
docker compose up -d
```

**Start over** with an empty database: back up, then `docker compose down -v`
and `docker compose up -d`. The API recreates the schema, servers and games; users
log in again and role mappings changed in the admin UI are lost.

## Production

| | |
| --- | --- |
| Web | <https://searchlight.jetlageuropa.org> |
| API | <https://api-searchlight.jetlageuropa.org> (`/health`) |
| Clone | `/srv/WriteMap/TaibledFork` |
| Overlay | `docker-compose.cloudflared.yml`, tunnel config in `/srv/WriteMap/cloudflared` |
| Compose project | `writemap` (volume `writemap_postgres_data`) |
| Backups | `/srv/WriteMap/backups`, nightly cron logging to `/var/log/writemap-backup.log` |

The `taibled` database and user, the `writemap` project name and the
`TaibledFork` path predate the Searchlight name. They stay as they are.

Each environment's `DISCORD_REDIRECT_URI` must be registered in the Discord
application (OAuth2 → Redirects):
`https://api-searchlight.jetlageuropa.org/auth/discord/callback` for
production, `http://localhost:3000/auth/discord/callback` for development.
