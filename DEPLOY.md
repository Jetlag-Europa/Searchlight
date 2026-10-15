# Deployment

Production runs on a VPS behind a Cloudflare Tunnel. GitHub Actions builds the
Docker images for both `linux/amd64` and `linux/arm64`, so any 64-bit Linux
host with Docker can run them. The server only pulls the images and restarts.

| Environment | Where | Compose files | Script |
|---|---|---|---|
| **Production** | VPS, `searchlight.jetlageuropa.org` | `docker-compose.yml` + `docker-compose.vps.yml` | `infra/deploy-vps.sh` |
| **e2e tests** | any machine, `127.0.0.1` | `docker-compose.yml` + `docker-compose.test.yml` | `infra/deploy-test.sh` ([`docs/TESTING_PLAN.md`](docs/TESTING_PLAN.md)) |
| **Local development** | your machine | `docker-compose.yml` + `docker-compose.override.yml` (Postgres only) | none ([`SETUP.md`](SETUP.md)) |

**How a change reaches production:** merge to `main` → the "Docker images"
workflow builds and pushes `ghcr.io/jetlag-europa/searchlight-{api,web}` →
on the server, `git pull` and run `infra/deploy-vps.sh`.

### Naming compatibility

Searchlight branding does not migrate the `taibled` database and role,
persisted state, `TaibledFork` deployment paths, or the Compose project and
volume names (`writemap`, `writemap-test`). Keep existing configured `.env`
values when upgrading; do not recreate volumes for the rename.

---

## Production

### Live URLs

| Role | URL |
|---|---|
| Web | `https://searchlight.jetlageuropa.org` |
| API | `https://api-searchlight.jetlageuropa.org` |
| API health | `https://api-searchlight.jetlageuropa.org/health` → `{"ok":true}` |

Both are served through a Cloudflare Tunnel. **No host ports are published** on
the server: `cloudflared` is the only ingress.

### Topology

```
                         Cloudflare  (zone: jetlageuropa.org)
                         ┌──────────────────────────────────────────────┐
  users ────────────────► searchlight.jetlageuropa.org          (web)   │
                         │ api-searchlight.jetlageuropa.org      (api)   │
                         └───────────────┬──────────────────────────────┘
                                         │  Cloudflare Tunnel
                                         │  (locally-managed, outbound only)
                                         ▼
   VPS (amd64 or arm64)  ── docker compose -p writemap ──
     ├── cloudflared  → http://web:80, http://api:3000  (internal net)
     ├── web    (nginx, static Astro build)
     ├── api    (Fastify; on boot: migrate, create missing servers, import games)
     └── postgres (volume: writemap_postgres_data)   NO host ports
```

Why `api-searchlight` (one label) and not `api.searchlight` (two): Cloudflare's
free Universal SSL covers `jetlageuropa.org` and `*.jetlageuropa.org` (one level
only), so a two-level host gets no free edge certificate.

### Where everything lives on the server

| Thing | Path |
|---|---|
| Repo clone | `/srv/WriteMap/TaibledFork` |
| Runtime env (secrets) | `/srv/WriteMap/TaibledFork/.env` (mode `600`, gitignored; template `.env.vps.example`) |
| Compose project name | `writemap` |
| Postgres data | docker volume `writemap_postgres_data` |
| Tunnel credentials + ingress | `/srv/WriteMap/cloudflared/` (mounted by `docker-compose.vps.yml`; owned by uid `65532`, the cloudflared container user) |
| Backups | `/srv/WriteMap/backups/` |
| Backup log | `/var/log/writemap-backup.log` |

Run the commands below as a user in the `docker` group (or prefix them with
`sudo`).

### Images built by CI

The server does not build the app. On every push to `main`, the "Docker images"
workflow (`.github/workflows/docker-images.yml`) builds the `api` and `web`
images and pushes them to the GitHub Container Registry:

| Image | Tags |
|---|---|
| `ghcr.io/jetlag-europa/searchlight-api` | `sha-<7-char commit>`, `latest` |
| `ghcr.io/jetlag-europa/searchlight-web` | `sha-<7-char commit>`, `latest` |

Every tag is a multi-platform image (`linux/amd64` + `linux/arm64`): each
platform builds natively on its own runner, and `docker pull` picks the one
matching the host. Pull requests only build them, to catch a broken image
before it is merged; a manual run (Actions → Docker images → Run workflow)
pushes a `sha-` tag for any branch. Images pushed from a fork live under that
owner: set `SEARCHLIGHT_IMAGE_REGISTRY=ghcr.io/<owner>` in `.env`.

### Set up a server

1. **Docker:** install Docker Engine with the Compose plugin
   (`curl -fsSL https://get.docker.com | sudo sh`), and add your user to the
   `docker` group.
2. **Code:** the repo is private, so give the server a read-only deploy key
   (repo Settings → Deploy keys) and clone with it. The clone must track
   `Jetlag-Europa/Searchlight`, since the image tags are its commits:
   ```bash
   ssh-keygen -t ed25519 -f ~/.ssh/searchlight_deploy -N ''   # add the .pub as a deploy key
   sudo mkdir -p /srv/WriteMap && sudo chown "$USER" /srv/WriteMap
   GIT_SSH_COMMAND='ssh -i ~/.ssh/searchlight_deploy -o IdentitiesOnly=yes' \
     git clone git@github.com:Jetlag-Europa/Searchlight.git /srv/WriteMap/TaibledFork
   cd /srv/WriteMap/TaibledFork
   git config core.sshCommand 'ssh -i ~/.ssh/searchlight_deploy -o IdentitiesOnly=yes'
   ```
   An existing clone of the old repository switches over with
   `git remote set-url origin git@github.com:Jetlag-Europa/Searchlight.git`,
   the `core.sshCommand` line above, and `git fetch origin && git checkout -B main origin/main`.
3. **Images:** the packages are private too. Log in to GHCR once with a GitHub
   personal access token (classic) that has only the `read:packages` scope,
   from an account that can read the repo:
   ```bash
   docker login ghcr.io -u <github-user>   # paste the token as the password
   ```
4. **Environment:** `cp .env.vps.example .env`, fill in every `fill_me`, and
   `chmod 600 .env`. The Postgres password is fixed when the volume is first
   created; keep `DATABASE_URL`'s password identical to `POSTGRES_PASSWORD`.
5. **Tunnel:** set up the Cloudflare Tunnel (below), then deploy.

### Deploy / update

```bash
cd /srv/WriteMap/TaibledFork
git pull
bash infra/deploy-vps.sh
```
`infra/deploy-vps.sh` pulls the images tagged `sha-<checked-out commit>` and
restarts the stack (`docker compose -p writemap -f docker-compose.yml -f
docker-compose.vps.yml up -d --no-build`), so the containers always run the code
of the checkout that holds the compose files. Wait for that commit's "Docker
images" run to go green first: until it has, the pull fails and nothing changes.
Each deploy also removes images no container uses that are more than a week
old, so pulled images don't fill the disk.

- **Roll back:** `git checkout <older commit>` and deploy again, or keep the
  checkout and run `SEARCHLIGHT_IMAGE_TAG=sha-<commit> bash infra/deploy-vps.sh`.
- **Build on the server instead** (CI down, or testing a local change):
  `bash infra/deploy-vps.sh --build`.

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

The tunnel is created from the server's CLI (`cloudflared tunnel login`, then
`cloudflared tunnel create <name>`). The `cloudflared` container reads its
config from a mounted file, so there is no `TUNNEL_TOKEN` and nothing to
configure in the Cloudflare dashboard.

Copy the `<tunnel-id>.json` credentials file that `tunnel create` writes to
`~/.cloudflared/` into `/srv/WriteMap/cloudflared/`, next to this
`/srv/WriteMap/cloudflared/config.yml`:
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

The directory is mounted read-only into the container at `/etc/cloudflared`.
Make it owned by uid `65532` (`sudo chown -R 65532:65532 /srv/WriteMap/cloudflared`)
so the non-root container user can read it without exposing the credentials
world-readable.

**DNS:** `cloudflared tunnel route dns <name> <host>` creates the proxied CNAME
for each public hostname.

**Changing ingress:** edit `config.yml`, then restart the connector, since
cloudflared does **not** hot-reload a mounted config:
```bash
docker compose -p writemap restart cloudflared
```

### Backups

Nightly via cron at 03:00 (`crontab -e`):
```cron
0 3 * * * /srv/WriteMap/TaibledFork/infra/backup.sh >> /var/log/writemap-backup.log 2>&1
```
`infra/backup.sh` `pg_dump`s the running postgres to a gzip in `backups/` next
to the clone (`/srv/WriteMap/backups/`) and prunes dumps older than 30 days.
Dumps are not encrypted. `WRITEMAP_BACKUP_DIR` and `WRITEMAP_COMPOSE_DIR`
override the two paths. Run on demand with `bash infra/backup.sh`.

### Reset the database (fresh start)

Deletes every session, account and game revision; take a backup first.
```bash
bash infra/backup.sh
docker compose -p writemap -f docker-compose.yml -f docker-compose.vps.yml down
docker volume rm writemap_postgres_data
bash infra/deploy-vps.sh
```
The API rebuilds the schema, the servers and the games on boot. Everyone logs in
again; role mappings changed through the admin UI must be redone.

### Restore a dump (into a fresh volume)

Restore before the API starts, so it doesn't create an empty schema first:
```bash
docker compose -p writemap -f docker-compose.yml -f docker-compose.vps.yml up -d postgres
until docker compose -p writemap exec -T postgres pg_isready -U taibled -d taibled; do sleep 2; done
gunzip -c <dump>.sql.gz | docker compose -p writemap exec -T postgres psql -U taibled -d taibled
bash infra/deploy-vps.sh
```

### Secrets in `.env`

See `.env.vps.example` for the full list. The ones that matter most:
- `POSTGRES_PASSWORD` / `DATABASE_URL`: same password.
- `DISCORD_CLIENT_SECRET` / `DISCORD_BOT_TOKEN` / `DISCORD_FEEDBACK_WEBHOOK_URL`.
- `SESSION_COOKIE_SECRET`: rotating it logs everyone out.
- `ADMIN_DISCORD_IDS`: Discord user IDs that get every permission on every server.
- `DISCORD_REDIRECT_URI=https://api-searchlight.jetlageuropa.org/auth/discord/callback`
  (must be registered in the Discord developer portal).
- `SESSION_COOKIE_DOMAIN`: left blank (`SameSite=None; Secure` handles the
  web/api subdomain split; Cloudflare serves HTTPS so `Secure` is satisfied).
- `OVERPASS_URL` (optional): a self-hosted Overpass, plus its Cloudflare Access
  service token in `OVERPASS_CF_ACCESS_CLIENT_ID` / `_SECRET` if it sits behind
  Access.

### Gotchas

- **No host ports.** Only `docker-compose.vps.yml` goes on top of
  `docker-compose.yml` here; the test overlay publishes ports.
- **Deploy pulls, it doesn't build.** A commit CI hasn't built yet (or a server
  logged out of `ghcr.io`) fails the pull and leaves the running stack as is.
- **`PUBLIC_API_BASE` is baked at build time.** On an API hostname change,
  update it in `docker-images.yml` and `docker-compose.vps.yml` and deploy a new
  web image.
- **Overpass is only used for free play** (no game selected) and OSM boundary
  lookups; games carry their own data and never query it. CF-Access headers only
  go to `OVERPASS_URL`; public Overpass servers get a plain `User-Agent` and are
  the fallback (slower, may time out).
- **Cloudflared config is not hot-reloaded.** Restart the container after
  editing `config.yml`.
- **Two-level subdomains need paid ACM.** Keep public hostnames one label deep
  under `jetlageuropa.org` to stay on free Universal SSL.

---

## Discord developer portal: redirect URIs

In the [Discord developer portal](https://discord.com/developers/applications)
→ your application → OAuth2 → Redirects, register one URI per environment:

```
https://api-searchlight.jetlageuropa.org/auth/discord/callback
http://localhost:3000/auth/discord/callback
```

`DISCORD_REDIRECT_URI` in each `.env` tells the API which one to send.
