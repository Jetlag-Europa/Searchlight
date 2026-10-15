# Deployment

Production runs on an Azure VPS behind a Cloudflare Tunnel. Docker images are
built by GitHub Actions; the VPS only pulls and restarts them.

| Environment | Where | Compose files | Script |
|---|---|---|---|
| **Production** | Azure VPS, `searchlight.jetlageuropa.org` | `docker-compose.yml` + `docker-compose.vps.yml` | `infra/deploy-vps.sh` |
| **Dev** | Mac mini, `devhideandseek.lucifersserver.com` | `docker-compose.yml` + `docker-compose.dev.yml` | `infra/deploy-dev.sh` |
| **e2e tests** | any machine, `127.0.0.1` | `docker-compose.yml` + `docker-compose.test.yml` | `infra/deploy-test.sh` ([`docs/TESTING_PLAN.md`](docs/TESTING_PLAN.md)) |
| **Local development** | your machine | `docker-compose.yml` + `docker-compose.override.yml` (Postgres only) | none ([`SETUP.md`](SETUP.md)) |

**How a change reaches production:** merge to `main` → the "Docker images"
workflow builds and pushes `ghcr.io/jetlag-europa/searchlight-{api,web}` →
on the VPS, `git pull` and run `infra/deploy-vps.sh`.

### Naming compatibility

Searchlight branding does not migrate the `taibled` database, the `taibled` /
`taibled_dev` roles, persisted state, `TaibledFork` deployment paths, or the
Compose project and volume names (`writemap`, `writemap-dev`, `writemap-test`).
Keep existing configured `.env` values when upgrading; do not recreate volumes
for the rename.

---

## Production (Azure VPS)

### Live URLs

| Role | URL |
|---|---|
| Web | `https://searchlight.jetlageuropa.org` |
| API | `https://api-searchlight.jetlageuropa.org` |
| API health | `https://api-searchlight.jetlageuropa.org/health` → `{"ok":true}` |

Both are served through a Cloudflare Tunnel. **No host ports are published** on
the VPS: `cloudflared` is the only ingress.

### Topology

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

### Where everything lives on the VPS

| Thing | Path |
|---|---|
| Repo clone | `/srv/WriteMap/TaibledFork` |
| Runtime env (secrets) | `/srv/WriteMap/TaibledFork/.env` (mode `600`, gitignored; template `.env.vps.example`) |
| Compose project name | `writemap` |
| Postgres data | docker volume `writemap_postgres_data` |
| Tunnel credentials + ingress | `/srv/WriteMap/cloudflared/` (owned by uid `65532`, the cloudflared container user) |
| Tunnel login cert | `/home/jules/.cloudflared/cert.pem` (used by the `cloudflared` CLI on the host) |
| Backups | `/srv/WriteMap/backups/` |
| Backup log | `/var/log/writemap-backup.log` |

Docker note: the `jules` user is in the `docker` group, but the login session
that installed Docker predates that, so interactive shells may still need
`sudo docker`. Fresh logins and cron jobs get the group automatically. If
`docker` isn't usable without sudo, run the scripts under the group with
`sg docker -c 'bash infra/deploy-vps.sh'`.

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
branch. Images pushed from a fork live under that owner: set
`SEARCHLIGHT_IMAGE_REGISTRY=ghcr.io/<owner>` in `.env`.

### One-time setup: GitHub access from the VPS

The repo and its packages are private, so the VPS needs read access to both.

**Images.** Log in to GHCR once with a GitHub personal access token (classic)
that has only the `read:packages` scope, from an account that can read the
repo:
```bash
sg docker -c 'docker login ghcr.io -u <github-user>'   # paste the token as the password
```

**Code.** The clone must track `Jetlag-Europa/Searchlight`, since the image tags
are its commits. Give the VPS a read-only deploy key (repo Settings → Deploy
keys) and point the clone at the repo:
```bash
ssh-keygen -t ed25519 -f ~/.ssh/searchlight_deploy -N ''   # add the .pub as a deploy key
cd /srv/WriteMap/TaibledFork
git config core.sshCommand 'ssh -i ~/.ssh/searchlight_deploy -o IdentitiesOnly=yes'
git remote set-url origin git@github.com:Jetlag-Europa/Searchlight.git
git fetch origin && git checkout -B main origin/main
```

### Deploy / update

```bash
cd /srv/WriteMap/TaibledFork
git pull
sg docker -c 'bash infra/deploy-vps.sh'
```
`infra/deploy-vps.sh` pulls the images tagged `sha-<checked-out commit>` and
restarts the stack (`docker compose -p writemap -f docker-compose.yml -f
docker-compose.vps.yml up -d --no-build`), so the containers always run the code
of the checkout that holds the compose files. Wait for that commit's "Docker
images" run to go green first: until it has, the pull fails and nothing changes.
Each deploy also removes images no container uses that are more than a week
old, so pulled images don't fill the disk.

- **Roll back:** `git checkout <older commit>` and deploy again, or keep the
  checkout and run `sg docker -c 'SEARCHLIGHT_IMAGE_TAG=sha-<commit> bash
  infra/deploy-vps.sh'`.
- **Build on the VPS instead** (CI down, or testing a local change):
  `sg docker -c 'bash infra/deploy-vps.sh --build'`.

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

### The Cloudflare Tunnel (locally-managed)

- **Tunnel name:** `searchlight-vps`
- **Tunnel UUID:** `ce7b2d35-87fb-4703-8f7d-51920d5a3dc7`
- **Account zone:** `jetlageuropa.org`

The tunnel was created from the VPS CLI (`cloudflared tunnel login` + `tunnel
create`). The connector reads its config from a mounted file, so there is no
`TUNNEL_TOKEN` and nothing to configure in the Cloudflare dashboard.

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

**DNS:** two proxied CNAMEs (created by `cloudflared tunnel route dns`) point
at `ce7b2d35-….cfargotunnel.com`: `searchlight.jetlageuropa.org` and
`api-searchlight.jetlageuropa.org`.

**Changing ingress:** edit `/srv/WriteMap/cloudflared/config.yml` (as root,
it's uid-65532 owned), then restart the connector, since cloudflared does
**not** hot-reload a mounted config:
```bash
sudo nano /srv/WriteMap/cloudflared/config.yml
docker compose -p writemap restart cloudflared
```
Add new hostnames' DNS with `cloudflared tunnel route dns searchlight-vps <host>`.

### Backups

Nightly via cron at 03:00 (`crontab -l`):
```cron
0 3 * * * /srv/WriteMap/TaibledFork/infra/backup.sh >> /var/log/writemap-backup.log 2>&1
```
`infra/backup.sh` `pg_dump`s the running postgres to a gzip in `backups/` next
to the clone (`/srv/WriteMap/backups/`) and prunes dumps older than 30 days.
Dumps are not encrypted. `WRITEMAP_BACKUP_DIR` and `WRITEMAP_COMPOSE_DIR`
override the two paths (the installed cron line still sets both, to the same
values). Run on demand:
```bash
sg docker -c 'bash infra/backup.sh'
```

### Reset the database (fresh start)

Deletes every session, account and game revision; take a backup first. The
October 2026 release (JSON game definitions with pinned revisions) ships with a
reset: sessions from before it cannot be loaded.
```bash
sg docker -c 'bash infra/backup.sh'
docker compose -p writemap -f docker-compose.yml -f docker-compose.vps.yml down
docker volume rm writemap_postgres_data
sg docker -c 'bash infra/deploy-vps.sh'
```
The API rebuilds the schema, the servers and the games on boot. Everyone logs in
again; role mappings changed through the admin UI must be redone.

### Restore a dump (into a fresh volume)

Restore before the API starts, so it doesn't create an empty schema first:
```bash
docker compose -p writemap -f docker-compose.yml -f docker-compose.vps.yml up -d postgres
until docker compose -p writemap exec -T postgres pg_isready -U taibled -d taibled; do sleep 2; done
gunzip -c <dump>.sql.gz | docker compose -p writemap exec -T postgres psql -U taibled -d taibled
sg docker -c 'bash infra/deploy-vps.sh'
```
The Postgres role password comes from `POSTGRES_PASSWORD` at *volume creation*;
keep `DATABASE_URL`'s password identical to it.

### Secrets in `.env`

All filled and verified. Highlights:
- `POSTGRES_PASSWORD` / `DATABASE_URL`: same password.
- `DISCORD_CLIENT_SECRET` / `DISCORD_BOT_TOKEN` / `DISCORD_FEEDBACK_WEBHOOK_URL`.
- `SESSION_COOKIE_SECRET`: rotating it logs everyone out.
- `ADMIN_DISCORD_IDS`: Discord user IDs that get every permission on every server.
- `DISCORD_REDIRECT_URI=https://api-searchlight.jetlageuropa.org/auth/discord/callback`
  (must match the Discord developer portal; already registered).
- `OVERPASS_CF_ACCESS_CLIENT_ID` / `_SECRET`: Cloudflare Access service token for
  the Mac mini Overpass.
- `SESSION_COOKIE_DOMAIN`: left blank (`SameSite=None; Secure` handles the
  web/api subdomain split; Cloudflare serves HTTPS so `Secure` is satisfied).

### Gotchas

- **No host ports.** Only `docker-compose.vps.yml` goes on top of
  `docker-compose.yml` here; the dev and test overlays publish ports.
- **Deploy pulls, it doesn't build.** A commit CI hasn't built yet (or a VPS
  logged out of `ghcr.io`) fails the pull and leaves the running stack as is.
- **`PUBLIC_API_BASE` is baked at build time.** On an API hostname change,
  update it in `docker-images.yml` and `docker-compose.vps.yml` and deploy a new
  web image.
- **Overpass is only used for free play** (no game selected) and OSM boundary
  lookups; games carry their own data and never query it. CF-Access headers only
  go to `OVERPASS_URL` (the private Mac mini Overpass); public Overpass
  fallbacks get a plain `User-Agent`. If the Mac mini Overpass is down, queries
  fall back to public servers (slower, may time out).
- **Cloudflared config is not hot-reloaded.** Restart the container after
  editing `config.yml`.
- **Two-level subdomains need paid ACM.** Keep public hostnames one label deep
  under `jetlageuropa.org` to stay on free Universal SSL.

---

## Dev stack (Mac mini)

The Mac mini runs a dev stack for testing changes on a real server before they
reach production, plus the self-hosted Overpass production uses. Cloudflare +
Nginx Proxy Manager on FleetCommand terminate TLS and proxy to the Mac mini over
the LAN.

| | |
|---|---|
| Clone | `/srv/WriteMap-Dev/TaibledFork` |
| Compose project | `writemap-dev` |
| Web | `https://devhideandseek.lucifersserver.com` → host port `8180` |
| API | `https://apidevhideandseek.lucifersserver.com` → host port `3100` |
| Postgres | `127.0.0.1:5434` (loopback only, for local tools) |

### Set up

```bash
git clone <repo-url> /srv/WriteMap-Dev/TaibledFork
cd /srv/WriteMap-Dev/TaibledFork
cp .env.dev.example .env
nano .env          # fill in dev values
chmod 600 .env
bash infra/deploy-dev.sh
```

In Nginx Proxy Manager, point both dev hosts at the Mac mini's LAN IP on the
ports above, with Let's Encrypt, Force SSL and HTTP/2.

### Update after a code push

```bash
cd /srv/WriteMap-Dev/TaibledFork && git pull && bash infra/deploy-dev.sh
```
The dev stack builds its images on the Mac mini (`up -d --build`).

### Wipe the dev database

```bash
docker compose --project-name writemap-dev down -v
bash infra/deploy-dev.sh
```

---

## Discord developer portal: redirect URIs

In the [Discord developer portal](https://discord.com/developers/applications)
→ your application → OAuth2 → Redirects, register one URI per environment:

```
https://api-searchlight.jetlageuropa.org/auth/discord/callback
https://apidevhideandseek.lucifersserver.com/auth/discord/callback
http://localhost:3000/auth/discord/callback
```

Production, dev and local development use the same Discord app;
`DISCORD_REDIRECT_URI` in each `.env` tells the API which one to send.
