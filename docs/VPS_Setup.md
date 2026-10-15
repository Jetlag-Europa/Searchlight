# VPS Setup — Production on the Azure VPS (as deployed)

This documents the **actually deployed** production stack on the Azure VPS, which
differs in two ways from the original plan in [`VPS_MIGRATION.md`](./VPS_MIGRATION.md)
(see "Deviations from the migration plan" below). For the Mac mini topology see
[`../DEPLOY.md`](../DEPLOY.md).

Status: **live and verified** as of 2026-06-24.

---

## Live URLs

| Role | URL |
|---|---|
| Web | `https://searchlight.jetlageuropa.org` |
| API | `https://api-searchlight.jetlageuropa.org` |
| API health | `https://api-searchlight.jetlageuropa.org/health` → `{"ok":true}` |

Both are served through a Cloudflare Tunnel. **No host ports are published** on the
VPS — `cloudflared` is the only ingress.

---

## Topology

```
                         Cloudflare  (zone: jetlageuropa.org)
                         ┌──────────────────────────────────────────────┐
  users ────────────────► searchlight.jetlageuropa.org          (web)   │
                         │ api-searchlight.jetlageuropa.org      (api)   │
                         └───────────────┬──────────────────────────────┘
                                         │  Cloudflare Tunnel "searchlight-vps"
                                         │  (locally-managed, outbound QUIC only)
                                         ▼
   Azure VPS (Ubuntu 24.04, aarch64)  ── docker compose -p writemap ──
     ├── cloudflared  → http://web:80, http://api:3000  (internal net)
     ├── web    (nginx, static Astro build)
     ├── api    (Fastify; on boot: migrate, create missing servers, import games)
     └── postgres (volume: writemap_postgres_data)   NO host ports

   Mac mini (stays up)
     └── Overpass @ https://overpass.lucifersserver.com/api/interpreter
          protected by Cloudflare Access (service token)
```

Why `api-searchlight` (one label) and not `api.searchlight` (two): Cloudflare's
free Universal SSL covers `jetlageuropa.org` and `*.jetlageuropa.org` (one level
only). `api.searchlight.jetlageuropa.org` is two levels deep and could not get a
free edge cert (TLS handshake failure). A single-label host avoids paying for
Advanced Certificate Manager.

---

## Where everything lives (on the VPS)

| Thing | Path |
|---|---|
| Repo clone | `/srv/WriteMap/TaibledFork` |
| Runtime env (secrets) | `/srv/WriteMap/TaibledFork/.env` (mode `600`, gitignored) |
| Compose project name | `writemap` |
| Postgres data | docker volume `writemap_postgres_data` |
| Tunnel credentials + ingress | `/srv/WriteMap/cloudflared/` (owned by uid `65532`, the cloudflared container user) |
| Tunnel login cert | `/home/jules/.cloudflared/cert.pem` (used by the `cloudflared` CLI on the host) |
| Backups | `/srv/WriteMap/backups/` |
| Backup log | `/var/log/writemap-backup.log` |

Docker note: the `jules` user is in the `docker` group, but the *current login
session* that installed Docker predates that, so interactive shells may still
need `sudo docker`. Fresh logins and cron jobs get the group automatically. The
`infra/deploy-vps.sh` script calls bare `docker`; run it under a fresh group with
`sg docker -c 'bash infra/deploy-vps.sh'` if `docker` isn't usable without sudo.

---

## The Cloudflare Tunnel (locally-managed)

- **Tunnel name:** `searchlight-vps`
- **Tunnel UUID:** `ce7b2d35-87fb-4703-8f7d-51920d5a3dc7`
- **Account zone:** `jetlageuropa.org`

Unlike a dashboard/token tunnel, this one is *locally-managed*: the connector
reads its config from a mounted file instead of a `TUNNEL_TOKEN`. No token exists
or is needed.

`/srv/WriteMap/cloudflared/config.yml`:
```yaml
tunnel: ce7b2d35-87fb-4703-8f7d-51920d5a3dc7
credentials-file: /etc/cloudflared/ce7b2d35-87fb-4703-8f7d-51920d5a3dc7.json
ingress:
  - hostname: searchlight.jetlageuropa.org
    service: http://web:80
  - hostname: api-searchlight.jetlageuropa.org
    service: http://api:3000
  - service: http_status:404
```

The directory is mounted read-only into the container at `/etc/cloudflared`
(see `docker-compose.vps.yml`). It is owned by uid `65532` so the non-root
container user can read it without exposing the credentials world-readable.

**DNS:** two proxied CNAMEs (auto-created by `cloudflared tunnel route dns`) point
at `ce7b2d35-….cfargotunnel.com`:
`searchlight.jetlageuropa.org` and `api-searchlight.jetlageuropa.org`.

### Changing ingress later
Edit `/srv/WriteMap/cloudflared/config.yml` (as root, it's uid-65532 owned), then
restart the connector — cloudflared does **not** hot-reload a mounted config:
```bash
sudo nano /srv/WriteMap/cloudflared/config.yml
docker compose -p writemap restart cloudflared
```
Add new hostnames' DNS with `cloudflared tunnel route dns searchlight-vps <host>`.

---

## Operations

### Images built by CI
The VPS does not build the app. On every push to `main`, the "Docker images"
workflow (`.github/workflows/docker-images.yml`) builds the `api` and `web`
images for arm64 and pushes them to the GitHub Container Registry:

| Image | Tags |
|---|---|
| `ghcr.io/jetlag-europa/searchlight-api` | `sha-<7-char commit>`, `latest` |
| `ghcr.io/jetlag-europa/searchlight-web` | `sha-<7-char commit>`, `latest` |

Pull requests only build them, to catch a broken image before it is merged; a
manual run (Actions → Docker images → Run workflow) pushes a `sha-` tag for any
branch. Images pushed from another fork live under that owner: set
`SEARCHLIGHT_IMAGE_REGISTRY=ghcr.io/<owner>` in `.env`.

The packages are private (like the repo), so the VPS logs in once with a
GitHub personal access token (classic) that has only the `read:packages` scope:
```bash
sg docker -c 'docker login ghcr.io -u <github-user>'   # paste the token as the password
```

### Deploy / update (pull + restart)
```bash
cd /srv/WriteMap/TaibledFork
git pull                       # if pulling new code
sg docker -c 'bash infra/deploy-vps.sh'
```
`infra/deploy-vps.sh` pulls the images tagged `sha-<checked-out commit>` and
restarts the stack (`docker compose -p writemap -f docker-compose.yml -f
docker-compose.vps.yml up -d --no-build`), so the containers always run the code
of the checkout that holds the compose files. Wait for that commit's "Docker
images" run to go green first: until it has, the pull fails and nothing changes.

- **Roll back:** `git checkout <older commit>` and deploy again, or keep the
  checkout and run `sg docker -c 'SEARCHLIGHT_IMAGE_TAG=sha-<commit> bash
  infra/deploy-vps.sh'`.
- **Build on the VPS instead** (CI down, or testing a local change):
  `sg docker -c 'bash infra/deploy-vps.sh --build'` runs the old `up -d --build`.

**`PUBLIC_API_BASE` is baked into the web bundle at build time**, by the workflow
(its `web` build arg) and by `docker-compose.vps.yml` for `--build`. A hostname
change means editing both and deploying a new image, not just a restart.

On every start the `api` container runs `prisma migrate deploy`, creates any
Discord servers missing from the database (`seed.js --missing-only`; existing
servers and role mappings are left alone), then starts Fastify, which imports
every `games/preloaded/*.game.json`. Game additions and edits therefore ship
with a normal deploy: changed content becomes a new revision, running sessions
stay on the revision they started with, and a file that fails to import is
logged (`Failed to preload game definition`) and skipped.

### Status / logs
```bash
docker compose -p writemap ps
docker compose -p writemap logs -f api
docker compose -p writemap logs -f cloudflared   # "Registered tunnel connection"
```

### Backups
Nightly via cron at 03:00 (`crontab -l`):
```cron
0 3 * * * WRITEMAP_BACKUP_DIR=/srv/WriteMap/backups WRITEMAP_COMPOSE_DIR=/srv/WriteMap/TaibledFork /srv/WriteMap/TaibledFork/infra/backup.sh >> /var/log/writemap-backup.log 2>&1
```
`infra/backup.sh` `pg_dump`s the running postgres to a gzip in
`/srv/WriteMap/backups/` and prunes dumps older than 30 days. Run on demand:
```bash
sg docker -c 'WRITEMAP_BACKUP_DIR=/srv/WriteMap/backups WRITEMAP_COMPOSE_DIR=/srv/WriteMap/TaibledFork bash infra/backup.sh'
```

### Reset the database (fresh start)
Deletes every session, account and game revision; take a backup first. The
October 2026 release (JSON game definitions with pinned revisions) ships with a
reset: sessions from before it cannot be loaded.
```bash
sg docker -c 'WRITEMAP_BACKUP_DIR=/srv/WriteMap/backups WRITEMAP_COMPOSE_DIR=/srv/WriteMap/TaibledFork bash infra/backup.sh'
docker compose -p writemap -f docker-compose.yml -f docker-compose.vps.yml down
docker volume rm writemap_postgres_data
sg docker -c 'bash infra/deploy-vps.sh'
```
The API rebuilds the schema, the servers and the games on boot. Everyone logs in
again; role mappings changed through the admin UI must be redone.

### Restore a dump (into a fresh volume)
```bash
docker compose -p writemap -f docker-compose.yml -f docker-compose.vps.yml up -d postgres
until docker compose -p writemap exec -T postgres pg_isready -U taibled -d taibled; do sleep 2; done
gunzip -c <dump>.sql.gz | docker compose -p writemap exec -T postgres psql -U taibled -d taibled
sg docker -c 'bash infra/deploy-vps.sh'
```
The Postgres role password comes from `POSTGRES_PASSWORD` at *volume creation*;
keep `DATABASE_URL`'s password identical to it.

---

## Secrets in `.env`

All filled and verified. Highlights:
- `POSTGRES_PASSWORD` / `DATABASE_URL` — same password (fresh volume).
- `DISCORD_CLIENT_SECRET` / `DISCORD_BOT_TOKEN` / `DISCORD_FEEDBACK_WEBHOOK_URL`.
- `SESSION_COOKIE_SECRET` — reused from Mac mini prod so restored sessions stayed valid.
- `ADMIN_DISCORD_IDS` — Discord user IDs that get every permission on every server.
- `DISCORD_REDIRECT_URI=https://api-searchlight.jetlageuropa.org/auth/discord/callback`
  (must match the Discord developer portal — already registered).
- `OVERPASS_CF_ACCESS_CLIENT_ID` / `_SECRET` — Cloudflare Access service token for
  the Mac mini Overpass. Verified working (HTTP 200).
- `SESSION_COOKIE_DOMAIN` — left blank (`SameSite=None; Secure` handles the
  web/api subdomain split; Cloudflare serves HTTPS so `Secure` is satisfied).
- `TUNNEL_TOKEN` — **unused** (locally-managed tunnel), commented out.

---

## Gotchas

- **No host ports.** Do not add `docker-compose.prod.yml` here — that publishes
  ports you don't want on a public VPS.
- **`PUBLIC_API_BASE` baked at build time** — on any API hostname change, update
  it in `docker-images.yml` and `docker-compose.vps.yml` and deploy a new web image.
- **Overpass is only used for free play** (no game selected) and OSM boundary
  lookups; games carry their own data and never query it.
- **CF-Access headers only go to `OVERPASS_URL`** (the private Mac mini Overpass);
  public Overpass fallbacks get a plain `User-Agent`. If the Mac mini Overpass is
  down, queries fall back to public servers (slower, may time out).
- **Cloudflared config is not hot-reloaded** — restart the container after editing
  `config.yml`.
- **Two-level subdomains need paid ACM** — keep public hostnames one label deep
  under `jetlageuropa.org` to stay on free Universal SSL.
- **Mac mini Overpass should stay up** — free play on the VPS depends on it.
- **Deploy pulls, it doesn't build** — a commit CI hasn't built yet (or a VPS
  logged out of `ghcr.io`) fails the pull and leaves the running stack as is.

---

## Deviations from the migration plan

1. **API hostname:** `api.searchlight.jetlageuropa.org` → **`api-searchlight.jetlageuropa.org`**
   (free TLS; see above).
2. **Tunnel:** dashboard/token-based → **locally-managed** (CLI-created tunnel,
   credentials + ingress in `/srv/WriteMap/cloudflared/`, no `TUNNEL_TOKEN`).

Both are committed: `docker-compose.vps.yml` bakes the `api-searchlight` host
into the web build and runs the `cloudflared` service from the mounted config,
and `.env.vps.example` carries the matching hosts.
