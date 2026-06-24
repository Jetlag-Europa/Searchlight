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
     ├── api    (Fastify; runs `prisma migrate deploy` on boot)
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

### Deploy / update (rebuild + restart)
```bash
cd /srv/WriteMap/TaibledFork
git pull                       # if pulling new code
sg docker -c 'bash infra/deploy-vps.sh'
```
`infra/deploy-vps.sh` runs `docker compose -p writemap -f docker-compose.yml -f
docker-compose.vps.yml up -d --build`. **`PUBLIC_API_BASE` is baked into the web
bundle at build time**, so a hostname change requires a rebuild (`--build`), not
just a restart.

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
- **`PUBLIC_API_BASE` baked at build time** — rebuild web on any API hostname change.
- **CF-Access headers only go to `OVERPASS_URL`** (the private Mac mini Overpass);
  public Overpass fallbacks get a plain `User-Agent`. If the Mac mini Overpass is
  down, queries fall back to public servers (slower, may time out).
- **Cloudflared config is not hot-reloaded** — restart the container after editing
  `config.yml`.
- **Two-level subdomains need paid ACM** — keep public hostnames one label deep
  under `jetlageuropa.org` to stay on free Universal SSL.
- **Mac mini Overpass must stay up** — the VPS depends on it.

---

## Deviations from the migration plan

1. **API hostname:** `api.searchlight.jetlageuropa.org` → **`api-searchlight.jetlageuropa.org`**
   (free TLS; see above).
2. **Tunnel:** dashboard/token-based → **locally-managed** (CLI-created tunnel,
   credentials + ingress in `/srv/WriteMap/cloudflared/`, no `TUNNEL_TOKEN`).

These required edits to `docker-compose.vps.yml` (web build arg + the `cloudflared`
service) that are currently **uncommitted on the VPS clone** — see
[`../summary.md`](../summary.md) for the diff and what to fold back into `master`.
