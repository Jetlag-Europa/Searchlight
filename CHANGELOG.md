# Changelog

Notable changes for players, game managers and server admins, newest first.
Lines marked **Upgrading** are for whoever runs a Searchlight server.

## Smoother server restarts (2026-10-18)

- Restarting or updating the server no longer cuts off requests in flight. The API now shuts down within a second instead of being killed after 10 seconds, and players' live sync reconnects and catches up, as after any dropped connection.
- A player removed from a session, or whose session was deleted, while their live connection was being set up could keep receiving the session's updates. That connection is now refused.
- A player whose connection stalls is disconnected after 30 seconds and catches up once it recovers, instead of the server holding every update for them in memory.

## Changes from other websites are refused (2026-10-18)

- Another website can no longer make changes in Searchlight with a logged-in player's account. Before, a page elsewhere could, for example, join a visiting player to a session through one of its links, which showed the page's owner the player's Discord name and avatar.
- **Upgrading:** `FRONTEND_ORIGIN` must be exactly the origin the web app is opened on: the API now refuses changes sent from any other origin with a 403. Scripts that send no `Origin` header, such as game import scripts, work as before.

## No more upstream analytics (2026-10-18)

- Searchlight no longer sends page views and session recordings to Google Analytics and Microsoft Clarity. Both trackers came from the upstream project and reported, boards included, to its author's accounts. Searchlight has no analytics now.
- The app's icons now load from Searchlight itself, and the installed app is called "Searchlight" instead of "Jet Lag Hide and Seek Map Generator".

## Game stats for server admins (2026-10-17)

- The games page now shows server admins how much each game is played: how many sessions are live and how many players are connected to them, how many were active in the last day and week, totals for sessions, players and questions asked, and when the game was last played.
- The live count starts from zero whenever the server restarts.

## A server picker with only your servers (2026-10-17)

- The session picker lists the Discord servers you belong to, plus Home Games. Servers you aren't in no longer appear with an empty game list.
- A server you aren't in still appears while you have sessions there, for example from a game link or a join link, so you can always get back to them. After you join a Discord server, it shows up within about 10 minutes.

## Sharing sessions by link (2026-10-17)

- Sessions are now shared with links instead of invitations to specific users. From **Invites**, a session's creator makes join links that bring people into the session; from **Share a copy**, they make links that give each person a private copy of it. Either kind can be revoked at any time.
- New sessions no longer ask whether they are private or shared: a session becomes shared once its creator makes a join link.
- If a link doesn't work, the join page now says why. A creator who opens their own join link is simply taken to the session.
- Searchlight no longer lets anyone search its users. The invitation search had let any logged-in user list every account.
- **Upgrading:** pending invitations are deleted. Players who had already accepted one stay in their sessions.

## Security fixes (2026-10-17)

- Names in a game, such as hiding-zone and station names, are now always shown as plain text. Before, a maliciously crafted game could run code in the browser of everyone playing it.
- Other websites can no longer embed Searchlight in a frame.

## Curses that resize the hiding zones (2026-10-17)

- Curses that make the hiding zones bigger or smaller can be added from **Add Question → Resize Hiding Zones (Curse)**. The card takes a multiplier, with ×1.5 and ×0.5 a tap away, and shows the zone radius from that point on.
- The question list follows the order in which things happened. Questions below a curse are checked against the resized zones, and questions above it against the size the zones had when they were asked, so a hider who answered from the edge of a large zone isn't ruled out when the zones later shrink. A curse added late can be moved to where it was cast with **Earlier** and **Later**.
- Several curses multiply together, a hidden curse has no effect, and the map and zone sidebar always show the current size. Polygon zones keep their shape.
- Everyone in a session should reload the page after this update. An older page doesn't know about curses, and if it saves the question list, it removes them for everyone.

## Erasing with a pen's eraser button (2026-10-17)

- In Pen Mode, the eraser end of a pen and its side button now erase, whichever tool is selected, and letting go switches back. On Windows, press the button before the pen touches the screen. The side button no longer opens the map menu.
- The right and middle mouse buttons no longer draw in Pen Mode.

## Your distance on measuring questions (2026-10-17)

- Measuring questions show how far the seeker is from the nearest thing being measured, and which one it is, for example "Your distance: 1.243 km to Brussels Airport". In hider mode, the hider's distance is shown too, so the automatic Closer or Further answer is easy to check.

## A sign when results take a while (2026-10-17)

- When the map needs more than half a second to work out the questions' results, a small "Calculating…" pill appears under the Live indicator until it's done, so a slow question no longer looks like a frozen page.

## Question names (2026-10-17)

- Questions can be given a name, such as "Airport radar" instead of "Radius 2". The name appears on the question's card and its map marker, and everyone in the session sees it.

## Region-boundary questions across the whole play area (2026-10-17)

- Some games' regions don't quite cover their play area, such as Belgium's provinces along the French border and at sea. Questions about the distance to a region boundary used to get those strips wrong: they were always kept for "Hider Further" and always eliminated for "Hider Closer". They are now measured to the nearest region's boundary.
- These questions also no longer leave thin slivers along the borders between regions.

## Every session plays a game (2026-10-17)

- Free play, inherited from JetLagHideAndSeek, is gone: every session now plays one of Searchlight's games. Questions and hiding zones come from the game itself rather than from live OpenStreetMap lookups.
- If a session's game can't be loaded, for example while offline, a "Game not loaded" banner offers to retry or change session. The board and drawing tools keep working in the meantime, and questions resume once the game has loaded.
- The free-play tools went with it: the place picker, drawing a custom play area, "Exclude Country", copying and pasting hiding zones, the tutorial, and the zone sidebar's station lookups and imports. A game's polygon hiding zones are now drawn as areas.
- The old built-in question types are gone, among them airports, major cities, McDonald's and 7-Eleven, train lines, OSM zones and international borders. Any such questions left in a session are hidden.
- New custom questions with nothing drawn yet no longer break the map, and clearing a radar or tentacle radius keeps the previous value.
- The map reopens on the game you last played, hider mode starts at the centre of the game, and the session picker can be closed with **Back to board** or Escape.
- **Upgrading:** `OVERPASS_URL`, `OVERPASS_CF_ACCESS_CLIENT_ID` and `OVERPASS_CF_ACCESS_CLIENT_SECRET` are no longer used and can be removed from `.env`.

## Hider mode turns off again (2026-10-17)

- Turning hider mode off didn't stick: it came straight back on, even after a reload. This is fixed, and sessions it happened to open normally again.

## Unlisted games and game links (2026-10-17)

- Games can be unlisted. An unlisted game isn't offered when creating a session; sessions of it can only be started from a game link. Game managers still see it on `/games`, where they can list or unlist it, and they can import a new game as unlisted.
- A game link (`/play?token=…`) lets anyone who has it start a session of that game, listed or not, even without being on the game's Discord server. Game managers create, copy and revoke links from **Links** on `/games`. Links don't expire, and sessions started from one keep working after it is revoked.
- Game managers can reach `/games` from a new cog in the session picker.

## Kilometres by default (2026-10-16)

- Players who haven't chosen a unit now get kilometres rather than miles, and new thermometers start 5 km apart. A unit you've already chosen is kept.

## Feedback moves to GitHub Issues (2026-10-16)

- "Report a bug / suggest a feature" in the map menu now opens [GitHub Issues](https://github.com/Jetlag-Europa/Searchlight/issues/new/choose) and replaces the in-app feedback pages.
- **Upgrading:** all in-app feedback is deleted, so export it first if you want to keep it. `DISCORD_FEEDBACK_WEBHOOK_URL` is no longer used.

## Making games from an announcement (2026-10-16)

- The game creation guide (`/skills/create-game.md`) now starts where most games do: a Discord announcement linking a rules document and a Google My Map. It walks through turning both into a game and handling the usual My Maps problems, such as mixed point layers, placeholder names and regions drawn in several pieces.
- The guide explains who can upload games (a Discord role with `games.create` or `games.edit`, granted under **Manage Roles** on `/admin`), and the import dialog links to it.
- Game files now point their `$schema` at `https://searchlight.jetlageuropa.org/schemas/game-definition.v1.schema.json`.

## Prebuilt images for self-hosting (2026-10-16)

- Searchlight's Docker images are published as `ghcr.io/jetlag-europa/searchlight-{api,web}` for amd64 and arm64, so a server can pull them instead of building its own. See `DEPLOY.md`.
- **Upgrading:** `docker-compose.vps.yml` is renamed `docker-compose.cloudflared.yml`, and `infra/deploy-vps.sh` is removed. Set `COMPOSE_FILE` and `COMPOSE_PROJECT_NAME` in `.env` (the project name is required), then update with `docker compose pull && docker compose up -d`.

## Question layers for Brno, Brussels and OLD Luxembourg (2026-10-15)

- Brno 2026, Brussels 2026 and OLD Luxembourg 2026 had no matching, measuring or tentacle questions. They now have their own:
  - **Brno 2026:** museums, airport, parks, hospitals, libraries, theme parks, zoo, golf courses, cinemas, bodies of water and its 29 districts.
  - **Brussels 2026:** the airport, museum, cinema, golf course, theme park, zoo, consulate, library, hospital and high-speed rail layers of Belgium 01.08, limited to the sites that matter in its play area.
  - **OLD Luxembourg 2026:** the layers of Luxembourg 2–3 October, apart from its stop-distance and castle questions.

## New games and more reliable sync (2026-10-13)

- New games: Greater Manchester 19-09, North London 26-09 (with its 55 council-listed parks) and Stockholm 19-09.
- Brno 2026, Brussels 2026 and OLD Luxembourg 2026 placed every hiding zone off the map; their zones are back where they belong.
- Switching sessions can no longer save one session's questions into another, and edits that haven't reached the server yet are no longer lost. Failed saves are retried, and a session that reconnects catches up on everything it missed.
- Nearest-line matching questions now update in milliseconds when a marker moves, where they could take minutes.
- A hider just inside a tentacle's radius is no longer eliminated.
- Radars start at the radii the game sets, and **Export Game JSON** exports the version of the game being played.
- **Upgrading:** this release starts from an empty database; sessions from before it are not kept.

## Games decide their own questions (2026-10-12)

- A game offers exactly the questions its definition declares. Radar and thermometer questions are now switched on in the game (`radars`, `thermometer`); every preloaded game has both.
- Tentacle, matching and measuring questions come only from the game's own layers, never from live OpenStreetMap lookups.
- The game creation guide is rewritten, with `game-tools.mjs` for converting map data and `check-game.mjs` for checking a game before uploading it.

## Luxembourg 2–3 October (2026-10-01)

- New game: Luxembourg 2–3 October 2026.
- Sessions no longer show a stray "At least one place type must be selected" message while loading.

## Safer saving (2026-09-25)

- A save that fails can no longer undo newer answers or settings.
- The game update notice is smaller, stays clear of the map controls and asks before upgrading.

## Answer and sync fixes (2026-09-23)

- Matching and tentacle answers stay tied to the right place, even when a game reuses feature IDs.
- Unsent edits survive switching sessions, and offline edits stay with the account that made them.
- Deleted drawings no longer reappear.

## Faster questions (2026-09-22)

- Question results are worked out in the background and reused where possible, so the map stays responsive while answers change.
- Planning mode shows matching and measuring outlines and tentacle areas again.

## Rotterdam 12-09 (2026-09-11)

- New game: Rotterdam 12-09, with NS stations for matching and measuring questions and municipal borders for measuring to the nearest border.
- Your session reopens even after the browser clears the tab's storage.

## Games defined in JSON (2026-09-07)

- Games are created and updated by importing their JSON definition, and each session stays on the version of its game it started with.
- A game's definition is only available to players allowed to see the game.

## Roles and permissions (2026-05-21)

- Server admins choose on `/admin` which of their Discord server's roles may manage games and settings in Searchlight.

## Discord login (2026-05-21)

- Searchlight now requires logging in with Discord, and the map moves to `/map`.
