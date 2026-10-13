# VPS Migration Handoff — Move prod to the Azure VPS

> ✅ **This migration was completed on 2026-06-24. Prod now runs on the Azure VPS.**
> This document is the *original plan* and is kept for history. For the **as-built**
> operational reference (what's actually deployed), see [`VPS_Setup.md`](VPS_Setup.md).
>
> **Two things ended up different from the plan below — read these before trusting it:**
> 1. **API host is `api-searchlight.jetlageuropa.org`** (single-label), NOT
>    `api.searchlight.jetlageuropa.org`. Cloudflare free Universal SSL only covers
>    one subdomain level (`*.jetlageuropa.org`); the two-level host failed the TLS
>    handshake. Every `api.searchlight…` reference below should read `api-searchlight…`.
> 2. **The tunnel is locally-managed, not token-based.** It was created from the VPS
>    CLI (`cloudflared tunnel login` + `tunnel create`); the connector reads
>    `/srv/WriteMap/cloudflared/config.yml` (mounted read-only). `TUNNEL_TOKEN` is
>    unused. Ignore the Phase 0 "copy the tunnel token" step.
>
> **Since then:** games became self-contained JSON definitions (October 2026) and
> no longer query Overpass; the Mac mini Overpass now serves only free play (no
> game selected) and OSM boundary lookups. The Zurich Bezirk/canton/coastline
> checks below describe the old app.

Move the **production** stack off the Mac mini and onto an Azure VPS, fronted by a
**Cloudflare Tunnel** (no open ports). The Mac mini keeps running **only** the
self-hosted Overpass, now reached publicly (and authenticated) by the VPS.

This is intended as a temporary home for prod; dev work resumes on the Mac mini
later. See `DEPLOY.md` for the original Mac mini topology.

---

## Target topology

```
                         Cloudflare
                         ┌──────────────────────────────────────────┐
  users ────────────────► searchlight.jetlageuropa.org      (web)   │
                         │ api.searchlight.jetlageuropa.org  (api)   │
                         └───────────────┬──────────────────────────┘
                                         │  Cloudflare Tunnel (outbound only)
                                         ▼
   Azure VPS (Ubuntu 24.04, aarch64)  ── docker compose -p writemap ──
     ├── cloudflared   → http://web:80, http://api:3000  (internal net)
     ├── web    (nginx, static Astro build)
     ├── api    (Fastify; runs prisma migrate deploy on boot)
     └── postgres (volume: postgres_data)        NO host ports published

   Mac mini (stays up)
     └── Overpass @ https://overpass.lucifersserver.com/api/interpreter
          protected by Cloudflare Access (service token)
```

Key differences from Mac mini prod:

| | Mac mini prod | VPS prod |
|---|---|---|
| Edge | NPM on FleetCommand, host ports | Cloudflare Tunnel, **no ports** |
| Web host | hideandseek.lucifersserver.com | searchlight.jetlageuropa.org |
| API host | apihideandseek.lucifersserver.com | api.searchlight.jetlageuropa.org |
| Overpass | local `host.docker.internal:12345` | remote `overpass.lucifersserver.com` + CF Access |
| Compose overlay | `docker-compose.prod.yml` | `docker-compose.vps.yml` |

---

## What was pre-set up in the repo (already committed-ready)

These changes are on the dev clone and just need to be pushed/pulled to the VPS:

1. **`apps/api/src/routes/boundaries.ts`** — `overpassFetch` now sends
   `CF-Access-Client-Id` / `CF-Access-Client-Secret` headers, **but only to the
   private `OVERPASS_URL`** (never the public fallbacks). Reads
   `OVERPASS_CF_ACCESS_CLIENT_ID` / `OVERPASS_CF_ACCESS_CLIENT_SECRET`.
   *Without this, every boundary query (Bezirk/canton/coastline) would hit
   Cloudflare Access and get a 403 login page.*
2. **`docker-compose.vps.yml`** — production overlay: adds the `cloudflared`
   service, bakes `PUBLIC_API_BASE=https://api.searchlight.jetlageuropa.org` into
   the web build, publishes **no** host ports.
3. **`infra/deploy-vps.sh`** — `docker compose -p writemap -f docker-compose.yml
   -f docker-compose.vps.yml up -d --build`.
4. **`.env.vps.example`** — template for the VPS `.env`.
5. **`infra/backup.sh`** — now honours `WRITEMAP_BACKUP_DIR` /
   `WRITEMAP_COMPOSE_DIR` env overrides so it works off the Mac mini paths.

> **Env var naming fix:** the old `.env` had `CF-Access-Client-Id: ...` /
> `CF-Access-Client-Secret: ...`. Those are **invalid** for a Docker `env_file`
> (hyphens + `:` are not valid env vars) and were silently ignored. They are now
> `OVERPASS_CF_ACCESS_CLIENT_ID=` / `OVERPASS_CF_ACCESS_CLIENT_SECRET=`. The dev
> `.env` has already been corrected; apply the same on every clone.

**Before migrating: commit + push these to `master`** (with your approval), then
`git pull` on the VPS. Recommended: test on the dev stack first (the dev `.env`
already points `OVERPASS_URL` at the public endpoint, so the CF-Access fix is
exercised by dev too — confirm a Zurich Bezirk/canton question still resolves).

---

## Migration runbook

### Phase 0 — Cloudflare prerequisites (do first; DNS can take a few minutes)

1. **`jetlageuropa.org` must be on Cloudflare** (zone active, nameservers
   delegated). Confirm in the Cloudflare dashboard.
2. **Create the tunnel.** Zero Trust → Networks → Tunnels → *Create a tunnel* →
   **Cloudflared** → name it e.g. `searchlight-vps`. Copy the **tunnel token**
   (used as `TUNNEL_TOKEN` in `.env`). Do **not** install the connector on the
   host — our compose runs it as a container.
3. **Add two public hostnames** to that tunnel:
   | Public hostname | Service |
   |---|---|
   | `searchlight.jetlageuropa.org` | `HTTP` → `web:80` |
   | `api.searchlight.jetlageuropa.org` | `HTTP` → `api:3000` |
   (The service URLs use Docker service names because `cloudflared` shares the
   compose network. DNS CNAMEs are auto-created by Cloudflare.)
4. **Overpass / Cloudflare Access** (Mac mini side, likely already done since dev
   uses it): ensure `overpass.lucifersserver.com` is reachable and its Access
   application policy allows the **service token** whose ID/secret are in the
   `.env`. If you need a fresh token: Zero Trust → Access → Service Auth →
   *Create Service Token*; add it to the Access policy as an *Include → Service
   Token* rule.
5. **Discord developer portal** → your app → OAuth2 → Redirects: add
   `https://api.searchlight.jetlageuropa.org/auth/discord/callback`.
   (Keep the existing Mac mini URIs until you're sure you won't roll back.)

### Phase 1 — Provision the VPS

The VPS has only Node + Claude Code. Install Docker Engine + compose plugin
(arm64) and git:

```bash
# Docker Engine (official convenience script supports arm64 / Ubuntu 24.04)
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"   # log out/in for group to take effect
sudo apt-get update && sudo apt-get install -y git

docker --version && docker compose version
```

Pick a home for the clone (mirrors the Mac mini's `/srv` layout):

```bash
sudo mkdir -p /srv/WriteMap && sudo chown "$USER" /srv/WriteMap
git clone <repo-url> /srv/WriteMap/TaibledFork
# Use your repository's SSH or HTTPS clone URL; the directory name is local.
cd /srv/WriteMap/TaibledFork
```

Create the env file:

```bash
cp .env.vps.example .env
nano .env          # fill every `fill_me` (see checklist below)
chmod 600 .env
```

`.env` checklist:
- `POSTGRES_PASSWORD` / `DATABASE_URL` — pick a strong password (use the **same**
  in both, or just keep the dump's existing one — see Phase 2 note).
- `DISCORD_CLIENT_SECRET`, `DISCORD_BOT_TOKEN` — copy from Mac mini prod `.env`.
- `SESSION_COOKIE_SECRET` — copy from Mac mini prod `.env` **(reuse it so existing
  login sessions in the restored DB stay valid)**, or `openssl rand -hex 32` for a
  clean slate (everyone re-logs in).
- `OVERPASS_CF_ACCESS_CLIENT_ID` / `_SECRET` — the Cloudflare Access service token.
- `TUNNEL_TOKEN` — from Phase 0 step 2.
- `DISCORD_FEEDBACK_WEBHOOK_URL` — copy from Mac mini prod `.env`.
- Leave `SESSION_COOKIE_DOMAIN` blank (SameSite=None+Secure handles the split).

### Phase 2 — Migrate the database

On the **Mac mini**, dump prod (data + schema, including `_prisma_migrations`):

```bash
cd /Users/juleswitold/Dev/WriteMap/TaibledFork
docker compose --project-name writemap -f docker-compose.yml \
  exec -T postgres pg_dump -U taibled taibled | gzip > /tmp/prod-dump.sql.gz
```

Copy it to the VPS:

```bash
scp /tmp/prod-dump.sql.gz user@VPS_HOST:/srv/WriteMap/prod-dump.sql.gz
```

On the **VPS**, restore **before the API starts** (so it doesn't create an empty
schema first). Bring up only postgres, restore, then start everything:

```bash
cd /srv/WriteMap/TaibledFork

# 1. Start postgres alone
docker compose -p writemap -f docker-compose.yml -f docker-compose.vps.yml up -d postgres
# wait until healthy
until docker compose -p writemap exec -T postgres pg_isready -U taibled -d taibled; do sleep 2; done

# 2. Restore the dump into the (empty) taibled DB
gunzip -c /srv/WriteMap/prod-dump.sql.gz | \
  docker compose -p writemap exec -T postgres psql -U taibled -d taibled

# 3. Bring up the full stack (api migrate deploy will be a no-op — migrations
#    already present in the restored _prisma_migrations table)
bash infra/deploy-vps.sh
```

> **Password note:** the dump contains data, not the role password. The postgres
> role password comes from `POSTGRES_PASSWORD` when the volume is first created.
> Keep `DATABASE_URL`'s password identical to `POSTGRES_PASSWORD` and you're fine.
> If you ever restore into a pre-existing volume, the original password wins.

### Phase 3 — Verify

```bash
# Containers healthy (api, web, postgres, cloudflared all Up)
docker compose -p writemap ps
docker compose -p writemap logs -f cloudflared   # look for "Registered tunnel connection"

# Through Cloudflare:
curl https://api.searchlight.jetlageuropa.org/health      # → {"ok":true}
```

In a browser on `https://searchlight.jetlageuropa.org`:
- Log in with Discord (confirms OAuth redirect + cross-subdomain cookie).
- Open a session and load **Zurich 2026** → a Bezirk/canton/coastline question
  (confirms the VPS → Cloudflare-Access → Mac mini Overpass path with the new
  CF-Access headers). Watch `docker compose -p writemap logs -f api` for any
  Overpass 403s — a 403 means the Access service token / policy is wrong.

### Phase 4 — Backups (VPS)

```bash
mkdir -p /srv/WriteMap/backups
crontab -e
```
Add:
```cron
0 3 * * * WRITEMAP_BACKUP_DIR=/srv/WriteMap/backups WRITEMAP_COMPOSE_DIR=/srv/WriteMap/TaibledFork /srv/WriteMap/TaibledFork/infra/backup.sh >> /var/log/writemap-backup.log 2>&1
```

### Phase 5 — Cutover & decommission

1. Once the VPS is verified, **stop the Mac mini prod stack** so there aren't two
   live copies writing divergent data:
   ```bash
   cd /Users/juleswitold/Dev/WriteMap/TaibledFork
   docker compose -p writemap down        # keeps the volume; data preserved
   ```
2. Leave the Mac mini **Overpass** running — the VPS depends on it.
3. Repoint the old web/api DNS if you want them to redirect, or just retire them.
4. Keep the final Mac mini dump (`/tmp/prod-dump.sql.gz`) as the migration
   snapshot.

---

## Rollback

If the VPS misbehaves, the Mac mini prod is untouched (Phase 5 step 1 only
`down`s it, no `-v`). Bring it back:

```bash
cd /Users/juleswitold/Dev/WriteMap/TaibledFork && bash infra/deploy-prod.sh
```
Any data created on the VPS after cutover would need a reverse dump/restore.

---

## Gotchas

- **No host ports on the VPS.** Everything is internal; `cloudflared` is the only
  ingress. Don't add `docker-compose.prod.yml` to the VPS command — that publishes
  ports you don't want exposed on a public VPS.
- **`PUBLIC_API_BASE` is baked at build time** into the static web bundle. If you
  change the API hostname you must rebuild web (`up -d --build`), not just restart.
- **CF-Access headers only go to `OVERPASS_URL`.** Public Overpass fallbacks get a
  plain `User-Agent`. If the Mac mini Overpass is down, queries fall back to the
  public servers (slower, may time out) — expected.
- **Cookie cross-subdomain:** relies on `NODE_ENV=production` →
  `SameSite=None; Secure`. Cloudflare serves HTTPS so Secure is satisfied. Leave
  `SESSION_COOKIE_DOMAIN` blank.
- **arm64:** all base images (`postgres:16`, `node:22-slim/alpine`,
  `nginx:alpine`, `cloudflare/cloudflared`) are multi-arch — builds work on
  aarch64 without changes.
```
