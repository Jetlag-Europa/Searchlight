# Deployment — Mac mini M1

Everything runs on the Mac mini M1 — both the code you write and the two live
stacks. Docker Compose runs `postgres`, `api`, and `web` as three services per
stack. Cloudflare + Nginx Proxy Manager on FleetCommand terminate TLS and proxy
to the M1 over the LAN.

Two stacks run in parallel — **prod** and **dev** — each fully isolated by Docker
project names, separate volumes, and separate host ports.

---

## How it all fits together

```
Mac mini M1
├── /Users/juleswitold/Dev/WriteMap/   ← where you write and edit code
├── /srv/WriteMap/TaibledFork/         ← PROD clone + running stack
│     hideandseek.lucifersserver.com
│     apihideandseek.lucifersserver.com
└── /srv/WriteMap-Dev/TaibledFork/     ← DEV clone + running stack
      devhideandseek.lucifersserver.com
      apidevhideandseek.lucifersserver.com
```

---

## Day-to-day workflow

**Iterating on a new feature:**

1. Edit code under `/Users/juleswitold/Dev/WriteMap/TaibledFork/`, commit, and push to GitHub.
2. Pull and redeploy **dev**:
   ```bash
   cd /srv/WriteMap-Dev/TaibledFork && git pull && bash infra/deploy-dev.sh
   ```
3. Test on `https://devhideandseek.lucifersserver.com`.
4. When happy, redeploy **prod**:
   ```bash
   cd /srv/WriteMap/TaibledFork && git pull && bash infra/deploy-prod.sh
   ```

Prod only gets updated when you deliberately run step 4.
Dev can be redeployed as often as you like without touching prod.

---

## Port reference

| Service | Prod host port | Dev host port |
|---|---|---|
| API | `127.0.0.1:3000` | `127.0.0.1:3100` |
| Web | `127.0.0.1:8080` | `127.0.0.1:8180` |
| Postgres | not exposed | not exposed |

---

## Directory layout on the M1

```
/srv/
  WriteMap/
    TaibledFork/    ← prod git clone
    backups/        ← nightly dumps
  WriteMap-Dev/
    TaibledFork/    ← dev git clone
    backups/        ← dev dumps (optional)
```

---

## Prerequisites

- Docker Desktop (or Docker Engine) installed on the M1.
- `docker compose` available (V2 plugin, not `docker-compose`).
- NPM (Nginx Proxy Manager) running on FleetCommand with Let's Encrypt enabled.

---

## Production setup

### 1. Clone and configure

```bash
git clone <repo-url> /srv/WriteMap
cd /srv/WriteMap/TaibledFork
cp .env.example .env
nano .env          # fill in production values (see table below)
chmod 600 .env
```

Key values for production:

| Variable | Value |
|---|---|
| `DATABASE_URL` | `postgresql://taibled:<pw>@postgres:5432/taibled` |
| `DISCORD_CLIENT_ID` | from Discord developer portal |
| `DISCORD_CLIENT_SECRET` | from Discord developer portal |
| `DISCORD_REDIRECT_URI` | `https://apihideandseek.lucifersserver.com/auth/discord/callback` |
| `SESSION_COOKIE_SECRET` | `openssl rand -hex 32` |
| `SESSION_COOKIE_DOMAIN` | `.hideandseek.lucifersserver.com` |
| `FRONTEND_ORIGIN` | `https://hideandseek.lucifersserver.com` |
| `PUBLIC_API_BASE` | `https://apihideandseek.lucifersserver.com` |
| `NODE_ENV` | `production` |

### 2. Launch

```bash
cd /srv/WriteMap/TaibledFork
bash infra/deploy-prod.sh
```

On first boot, the `api` container runs `prisma migrate deploy` before starting
Fastify. Subsequent restarts skip the build if images are unchanged.

### 3. Update after a code push

```bash
cd /srv/WriteMap/TaibledFork && git pull && bash infra/deploy-prod.sh
```

---

## Dev setup

### 1. Clone and configure

```bash
git clone <repo-url> /srv/WriteMap-Dev
cd /srv/WriteMap-Dev/TaibledFork
cp .env.dev.example .env
nano .env          # fill in dev values
chmod 600 .env
```

### 2. Launch

```bash
cd /srv/WriteMap-Dev/TaibledFork
bash infra/deploy-dev.sh
```

### 3. Update after a code push

```bash
cd /srv/WriteMap-Dev/TaibledFork && git pull && bash infra/deploy-dev.sh
```

### 4. Wipe dev database (start fresh)

```bash
docker compose --project-name writemap-dev down -v
bash infra/deploy-dev.sh
```

---

## Discord developer portal — redirect URIs

In the [Discord developer portal](https://discord.com/developers/applications)
→ your application → OAuth2 → Redirects, all three of these must be registered:

```
http://localhost:3000/auth/discord/callback
https://apihideandseek.lucifersserver.com/auth/discord/callback
https://apidevhideandseek.lucifersserver.com/auth/discord/callback
```

The first is for local development. Both server URIs use the same Discord app —
`DISCORD_REDIRECT_URI` in each `.env` tells the API which one to send.

---

## Nginx Proxy Manager — proxy host config

All four hosts point to the M1's LAN IP (check `ifconfig` on the M1). NPM
handles TLS termination; containers are HTTP-only inside the LAN.

### Production

| Domain | Port | SSL |
|---|---|---|
| `hideandseek.lucifersserver.com` | `8080` | Let's Encrypt, Force SSL, HTTP/2 |
| `apihideandseek.lucifersserver.com` | `3000` | Let's Encrypt, Force SSL, HTTP/2 |

### Dev

| Domain | Port | SSL |
|---|---|---|
| `devhideandseek.lucifersserver.com` | `8180` | Let's Encrypt, Force SSL, HTTP/2 |
| `apidevhideandseek.lucifersserver.com` | `3100` | Let's Encrypt, Force SSL, HTTP/2 |

---

## Nightly backups

`infra/backup.sh` dumps the production Postgres, gzips it, and enforces 30-day
retention. Install the cron job on the M1:

```bash
crontab -e
```

Add:

```cron
0 3 * * * /srv/WriteMap/TaibledFork/infra/backup.sh >> /var/log/writemap-backup.log 2>&1
```

Backups are written to `/srv/WriteMap/backups/` as `writemap-YYYYMMDD-HHMMSS.sql.gz`.

> **Note:** backups are not encrypted at rest. See `PLAN.md` for the open question.

---

## Useful commands

```bash
# View logs
docker compose --project-name writemap logs -f
docker compose --project-name writemap-dev logs -f

# List all running stacks
docker compose ls

# Verify prod API
curl https://apihideandseek.lucifersserver.com/health
# → {"ok":true}

# Verify dev API
curl https://apidevhideandseek.lucifersserver.com/health
# → {"ok":true}
```
