# Migration summary — VPS prod is live (handoff back to the dev/Mac-mini clone)

This is a note from the agent that executed the VPS migration, for whoever picks
up the dev clone next. **Production now runs on the Azure VPS** behind a Cloudflare
Tunnel. Full operational reference: [`docs/VPS_Setup.md`](docs/VPS_Setup.md).
The original plan was [`docs/VPS_MIGRATION.md`](docs/VPS_MIGRATION.md); two things
ended up different from that plan (details below).

## What got done (all verified 2026-06-24)
- Provisioned the VPS (Ubuntu 24.04 aarch64): Docker Engine 29.6 + Compose v5.2.
- Cloned the repo to `/srv/WriteMap/TaibledFork`, built `web` + `api` images on arm64.
- Wrote `/srv/WriteMap/TaibledFork/.env` (mode 600) with all prod secrets.
- Restored the prod DB dump (39 users, 9 games, 126 sessions, 238 strokes, 19
  migrations). `prisma migrate deploy` on api boot is a no-op.
- Created a Cloudflare Tunnel `searchlight-vps` and brought up the full stack with
  no published host ports.
- Verified end to end: web 200, api `/health` `{"ok":true}`, CORS, Discord OAuth
  redirect, Overpass-via-CF-Access (HTTP 200), web bundle points at the new API host.
- Installed a nightly Postgres backup cron (03:00) and test-ran it.
- Deleted the temporary/dangling `api.searchlight.jetlageuropa.org` DNS record.

The owner has registered the new Discord redirect URI and completed a browser
login test.

## Two deviations from the migration plan — IMPORTANT
1. **API hostname changed.** `api.searchlight.jetlageuropa.org` →
   **`api-searchlight.jetlageuropa.org`**. Reason: Cloudflare free Universal SSL
   only covers one subdomain level (`*.jetlageuropa.org`); the two-level host got
   a TLS handshake failure. The single-label host gets a free cert.
2. **Tunnel is locally-managed, not token-based.** The owner had no tunnel token,
   so the tunnel was created from the VPS CLI (`cloudflared tunnel login` +
   `tunnel create`). The connector reads `/srv/WriteMap/cloudflared/config.yml`
   (mounted read-only) instead of a `TUNNEL_TOKEN`. `TUNNEL_TOKEN` is now unused.

## Repo changes made on the VPS clone (currently UNCOMMITTED)
Only one tracked file changed — `docker-compose.vps.yml`:

```diff
   web:
     build:
       args:
-        PUBLIC_API_BASE: https://api.searchlight.jetlageuropa.org
+        PUBLIC_API_BASE: https://api-searchlight.jetlageuropa.org

   cloudflared:
     image: cloudflare/cloudflared:latest
     restart: unless-stopped
-    command: tunnel --no-autoupdate run
-    environment:
-      TUNNEL_TOKEN: ${TUNNEL_TOKEN}
+    # Locally-managed tunnel: credentials + ingress live in ~/.cloudflared
+    # (mounted below), so no dashboard config and no TUNNEL_TOKEN are needed.
+    command: tunnel --no-autoupdate --config /etc/cloudflared/config.yml run
+    volumes:
+      - /srv/WriteMap/cloudflared:/etc/cloudflared:ro
     depends_on:
       - web
       - api
```

`.env` also changed but is gitignored (not committed):
`PUBLIC_API_BASE`, `DISCORD_REDIRECT_URI` → the new `api-searchlight` host;
`TUNNEL_TOKEN` commented out as unused.

## Recommended follow-ups for the dev clone
1. **Decide whether to commit the `docker-compose.vps.yml` change to `master`.**
   It reflects the real deployment. If yes, also update `.env.vps.example`
   (`PUBLIC_API_BASE`, `DISCORD_REDIRECT_URI` → `api-searchlight`; drop/replace
   the `TUNNEL_TOKEN` section with a note about locally-managed tunnels).
   - Note: the compose `volumes:` path `/srv/WriteMap/cloudflared` is
     VPS-specific. Keep it as-is (it's the VPS overlay) or parameterize if you
     want the overlay reusable elsewhere.
2. **Update `docs/VPS_MIGRATION.md`** (or just point it at `docs/VPS_Setup.md`) so
   the hostname + token assumptions don't mislead a future run.
3. The repo `JulzyWulzy/TaibledFork` is **public** (confirmed it was created public,
   not flipped — security log had no `repo.access` event). No secrets are committed
   (`.env` is gitignored), but consider making it private.
4. **Phase 5 cutover is still pending on the Mac mini:** when the owner is happy,
   `cd <macmini repo> && docker compose -p writemap down` (keeps the volume).
   **Leave the Mac mini Overpass running — the VPS depends on it.**

## Rollback
Mac mini prod was only `down`ed (if at all), never `-v`'d, so its data is intact:
`cd <macmini repo> && bash infra/deploy-prod.sh`. Any data created on the VPS
after cutover would need a reverse dump/restore.
