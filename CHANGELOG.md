# Changelog

What changed for players, game managers and server admins. Entries marked
**Upgrading** need action from whoever runs a Searchlight server.

## Game stats for server admins (2026-10-17)

- Server admins see on the games page how much each game is played: sessions live now and their players, sessions active in the last 24 hours and 7 days, sessions, players and questions in total, and when it was last played.
- "Live now" starts again at 0 whenever the server restarts.

## The server picker lists only your servers (2026-10-17)

- The session picker lists the Discord servers you're in, plus Home Games, instead of every server with an empty game list for the ones you aren't in.
- A server you aren't in still shows up while you have sessions there, e.g. from a game or join link, so you can open them. A server you just joined shows up within 10 minutes.

## Sessions are shared by link only (2026-10-17)

- Inviting a specific user by name is gone. A session's creator shares it with links: **Invites** makes join links, and **Share a copy** makes links that give each person their own copy. Both can be revoked.
- The new-session form no longer asks for Private or Shared; a session is shared once its creator makes a join link.
- The join page says why a link didn't work, and a creator opening their own join link is taken to the session.
- No one can look up the app's users any more; the invite search let any logged-in user list them all.
- **Upgrading:** invites still pending are deleted. Players who already accepted one stay in the session.

## Security fixes (2026-10-17)

- Hiding-zone and station names from a game are shown as plain text. An imported game could use them to run script in every player's browser.
- Other sites can no longer embed Searchlight in a frame.

## Curses that resize the hiding zones (2026-10-17)

- Add Question → **Resize Hiding Zones (Curse)** adds a card with a multiplier (×1.5 and ×0.5 are one tap; any positive number can be typed) that shows the zone radius from then on.
- The question list runs in the order things happened: questions below a curse are checked against the resized zones, questions above it against the size they were asked at. A curse added late can be moved to where it was cast with **Earlier** and **Later**.
- Curses multiply, a hidden curse counts as ×1, and the map and zone sidebar show the current size. Polygon zones keep their own area.
- Everyone in a session should reload the page after this update: an older page hides curses, and removes them for everyone if it then saves the question list.

## Pens erase with their eraser button (2026-10-17)

- In Pen Mode, a pen's eraser end or barrel button erases, whatever tool is chosen; letting go returns to that tool. On Windows, hold the button before the pen touches the screen. The barrel button no longer opens the map menu.
- In Pen Mode, the right and middle mouse buttons no longer draw.

## Measuring questions show your distance (2026-10-17)

- A measuring question's card shows how far the seeker is from what it measures to, and which one, e.g. "Your distance: 1.243 km to Brussels Airport". In hider mode it also shows the hider's distance, so the automatic Closer/Further answer can be checked.

## Slow results say they are calculating (2026-10-17)

- When the map takes more than half a second to work out the questions' results, a "Calculating…" pill shows under the Live indicator until it's done.

## Question names (2026-10-17)

- Every question card has a Name field, so a question can be called "Airport radar" instead of "Radius 2". The name shows on the card and on its map marker, and syncs with the session.

## Region-boundary questions cover the whole play area (2026-10-17)

- Where a game's regions don't cover its whole play area (such as Belgium's provinces along the French border and at sea), distance-to-boundary questions always kept those strips for "Hider Further" and always eliminated them for "Hider Closer". They are now measured to the nearest region's boundary.
- These questions no longer leave hairline slivers along the borders between regions.

## Free play is removed (2026-10-17)

- Every session plays a game; free play, inherited from JetLagHideAndSeek, is gone. Questions and hiding zones come only from the game, never from live OpenStreetMap lookups.
- When a session's game can't be loaded (offline, a server error, no access), a "Game not loaded" banner offers Retry and Change session. The board and drawing tools keep working meanwhile, but questions wait for the game.
- Removed with free play: the place picker, drawing a play area, "Exclude Country", Copy/Paste Hiding Zone and its links, the tutorial, and the zone sidebar's station lookups, station imports and editable radius. A game's polygon hiding zones are drawn as areas.
- The old built-in question types (airports, major cities, McDonald's and 7-Eleven, train stations and lines, OSM zones, international borders, the built-in tentacles and others) are gone. Questions of these types in a session are hidden.
- Custom questions with nothing drawn yet no longer break the map, and clearing a radar or tentacle radius keeps the last value.
- The map opens on the game you last played, hider mode starts at the game's centre, and the session picker can be closed with Back to board or Escape.
- **Upgrading:** remove `OVERPASS_URL`, `OVERPASS_CF_ACCESS_CLIENT_ID` and `OVERPASS_CF_ACCESS_CLIENT_SECRET` from the server's `.env`; they are no longer used.

## Hider mode turns off again (2026-10-17)

- Turning hider mode off didn't stick: it came straight back on, also after a reload. Sessions this happened to open normally again.

## Unlisted games and game links (2026-10-17)

- A game can be unlisted: it isn't offered when creating a session, and sessions of it start only from a game link. Game managers still see it on `/games`, where they can list or unlist it, and can import a game unlisted.
- A game link (`/play?token=…`) lets anyone holding it start a session of that game, listed or not, even if they aren't on the game's server. Game managers make, copy and revoke links on `/games` → **Links**. Links don't expire. Sessions started from a link keep working after it is revoked.
- The session picker has a cog that opens `/games` for game managers.

## Kilometres by default (2026-10-16)

- Players who haven't picked a unit see kilometres instead of miles, and new thermometers start 5 km apart. A unit you picked is kept.

## Bug reports and feature requests on GitHub Issues (2026-10-16)

- The map menu's "Report a bug / suggest a feature" opens [GitHub Issues](https://github.com/Jetlag-Europa/Searchlight/issues/new/choose), replacing the in-app feedback pages.
- **Upgrading:** all in-app feedback is deleted; export it first if you want to keep it. `DISCORD_FEEDBACK_WEBHOOK_URL` is no longer used.

## Game creation for game devs (2026-10-16)

- The game creation guide (`/skills/create-game.md`) starts from the usual source, a Discord announcement linking a rules Google Doc and a Google My Map, and covers common My Maps problems such as mixed POI layers, placeholder names and regions drawn as several shapes. `game-tools.mjs` has helpers for both sources.
- The guide explains who can upload games: a Discord role with `games.create` or `games.edit`, granted on `/admin` → **Manage Roles**. The import dialog links to the guide.
- Game files' `$schema` now points at `https://searchlight.jetlageuropa.org/schemas/game-definition.v1.schema.json`.

## Self-hosting with prebuilt images (2026-10-16)

- Searchlight's Docker images are published as `ghcr.io/jetlag-europa/searchlight-{api,web}` for amd64 and arm64, so a server can pull them instead of building. See `DEPLOY.md`.
- **Upgrading:** `docker-compose.vps.yml` is now `docker-compose.cloudflared.yml`, and `infra/deploy-vps.sh` is gone: set `COMPOSE_FILE` and `COMPOSE_PROJECT_NAME` (required) in `.env`, then deploy with `docker compose pull && docker compose up -d`.

## Question layers for Brno, Brussels and OLD Luxembourg (2026-10-15)

- Brno 2026, Brussels 2026 and OLD Luxembourg 2026 offered no matching, measuring or tentacle questions. They now have their own:
  - Brno 2026: Museum, Airport, Park, Hospital, Library, Theme Park, Zoo, Golf Course, Cinema, Body of Water and its 29 districts.
  - Brussels 2026: Belgium 01.08's Airport, Museum, Cinema, Golf Course, Theme Park, Zoo, Consulate, Library, Hospital and High-Speed Rail, for the sites near its play area.
  - OLD Luxembourg 2026: Luxembourg 2-3 October's layers, without its stop-distance and Castle or Fort questions.

## New games and sync fixes (2026-10-13)

- New games: Greater Manchester 19-09, North London 26-09 (with its 55 council-listed parks) and Stockholm 19-09.
- Brno 2026, Brussels 2026 and OLD Luxembourg 2026 had every hiding zone outside the map; they are back in place.
- Switching sessions can no longer save one session's questions into another, and edits that haven't reached the server yet are kept. Failed saves retry, and a reconnected session catches up on what it missed.
- Nearest-line matching questions answer in milliseconds instead of seconds to minutes per marker move.
- A hider just inside a tentacle's radius is no longer eliminated.
- Radars start at the radii the game declares, and Export Game JSON exports the version of the game being played.
- **Upgrading:** the database was reset with this release; sessions from before it are gone.

## Games declare all their questions (2026-10-12)

- A game offers only the questions its definition declares; radar and thermometer must be turned on (`radars`, `thermometer`). Every preloaded game has both.
- Tentacle, matching and measuring questions come only from the game's own layers, never from live OpenStreetMap lookups.
- The game creation guide is rewritten, with `game-tools.mjs` for converting map data and `check-game.mjs` for checking a game before uploading it.

## Luxembourg 2–3 October (2026-10-01)

- New game: Luxembourg 2–3 October 2026.
- No more "At least one place type must be selected" message when a session loads.

## Save fixes (2026-09-25)

- A failed save can no longer undo newer answers or settings.
- The game update notice is smaller, stays out of the map controls and asks before upgrading.

## Answer and sync fixes (2026-09-23)

- Matching and tentacle answers stay tied to the right place even when a game reuses feature IDs.
- Unsent edits survive switching sessions, and offline edits stay with the account that made them.
- A deleted drawing can no longer come back.

## Faster questions (2026-09-22)

- Questions are worked out in the background, once each, so the map stays responsive while answers change.
- Planning mode shows matching and measuring outlines and tentacle areas again.

## Rotterdam 12-09 (2026-09-11)

- New game: Rotterdam 12-09, with NS stations for matching and measuring and municipal borders for nearest-border measuring.
- Your session reopens after the browser clears the tab's storage.

## Games from JSON (2026-09-07)

- Games are created and updated by importing their JSON definition. Each session stays on the version of its game it started with.
- A game's definition is only shown to players who may see the game.

## Roles and permissions (2026-05-21)

- Server admins map their Discord server's roles to Searchlight permissions on `/admin`.

## Log in with Discord (2026-05-21)

- Searchlight needs a Discord login; the map is at `/map`.
