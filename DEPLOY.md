# Deployment — Mac mini M1

TaibledFork runs on the Mac mini M1 as three Docker Compose services:
`postgres`, `api`, and `web`. Nginx Proxy Manager on FleetCommand
terminates TLS and proxies to the M1 over the LAN.

---

## Prerequisites

- Docker Desktop (or Docker Engine) installed on the M1.
- `docker compose` available (V2 plugin, not `docker-compose`).
- NPM (Nginx Proxy Manager) running on FleetCommand with Let's Encrypt enabled.

---

## 1. Environment file

Create `/srv/taibled/.env` on the M1 with restrictive permissions:

```bash
mkdir -p /srv/taibled
nano /srv/taibled/.env       # paste from .env.example and fill in values
chmod 600 /srv/taibled/.env
```

Key values for production:

| Variable | Example |
|---|---|
| `DATABASE_URL` | `postgresql://taibled:<pw>@postgres:5432/taibled` |
| `DISCORD_CLIENT_ID` | from Discord developer portal |
| `DISCORD_CLIENT_SECRET` | from Discord developer portal |
| `DISCORD_REDIRECT_URI` | `https://api.hideandseek.lucifersserver.com/auth/discord/callback` |
| `SESSION_COOKIE_SECRET` | `openssl rand -hex 32` |
| `SESSION_COOKIE_DOMAIN` | `.hideandseek.lucifersserver.com` |
| `FRONTEND_ORIGIN` | `https://hideandseek.lucifersserver.com` |
| `PUBLIC_API_BASE` | `https://api.hideandseek.lucifersserver.com` |
| `NODE_ENV` | `production` |

---

## 2. Discord developer portal — redirect URIs

In the [Discord developer portal](https://discord.com/developers/applications)
→ your application → OAuth2 → Redirects, add **both** of these:

```
http://localhost:3000/auth/discord/callback
https://api.hideandseek.lucifersserver.com/auth/discord/callback
```

The first is for local development. The second is for production.
Both must be registered or Discord will reject the OAuth callback.

---

## 3. Copy the repo and start the stack

```bash
# On the M1
git clone <repo-url> /srv/taibled/app
cd /srv/taibled/app

# Symlink or copy the env file so compose can find it
cp /srv/taibled/.env .env

docker compose up -d --build
```

On first boot, the `api` container runs `prisma migrate deploy` before
starting Fastify. Subsequent restarts are fast (no rebuild).

To rebuild after a code update:

```bash
git pull
docker compose up -d --build
```

---

## 4. Nginx Proxy Manager — proxy host config

On FleetCommand's NPM, add two proxy hosts pointing to the M1's LAN IP
(e.g. `192.168.1.X`) — check `ifconfig` on the M1 for the exact address.

### `hideandseek.lucifersserver.com` → web container

| Field | Value |
|---|---|
| Domain | `hideandseek.lucifersserver.com` |
| Scheme | `http` |
| Forward Hostname/IP | `192.168.1.X` (M1 LAN IP) |
| Forward Port | `8080` |
| SSL | Let's Encrypt, Force SSL, HTTP/2 |

### `api.hideandseek.lucifersserver.com` → API container

| Field | Value |
|---|---|
| Domain | `api.hideandseek.lucifersserver.com` |
| Scheme | `http` |
| Forward Hostname/IP | `192.168.1.X` (M1 LAN IP) |
| Forward Port | `3000` |
| SSL | Let's Encrypt, Force SSL, HTTP/2 |

Both use the LAN IP directly — no Tailscale, everything is on the same
network. NPM handles TLS termination; the API and web containers are
HTTP-only inside the LAN.

---

## 5. Nightly backups

The script `infra/backup.sh` dumps Postgres, gzips the output, and
enforces 30-day retention. Install the cron job on the M1:

```bash
crontab -e
```

Add this line (adjust the path if the repo is elsewhere):

```cron
0 3 * * * /srv/taibled/app/infra/backup.sh >> /var/log/taibled-backup.log 2>&1
```

Backups are written to `/srv/taibled/backups/` as
`taibled-YYYYMMDD-HHMMSS.sql.gz`.

> **Note:** backups are not encrypted at rest. See `infra/backup.sh`
> and `PLAN.md` for the open question on encryption.

---

## 6. Verifying the deployment

```bash
# API health
curl https://api.hideandseek.lucifersserver.com/health
# → {"ok":true}

# Web — should serve the landing page
curl -I https://hideandseek.lucifersserver.com/
# → HTTP/2 200

# Auth flow — open in a browser
# https://hideandseek.lucifersserver.com → land on landing page → Log in with Discord
```
