# Changelog

Notable changes for players, game managers and server admins, newest first.
Lines marked **Upgrading** are for whoever runs a Searchlight server.
[Releases](https://github.com/Jetlag-Europa/Searchlight/releases) sum these entries up a few at a time.

## Game link previews (2026-10-21)

- A game link (`/play?token=…`) posted in Discord, Slack, Telegram, WhatsApp and similar apps now previews as the game's name, its server and an image of its map (the play area and hiding zones), instead of the site's general description. A revoked link previews as "Link no longer active".
- **Upgrading:** the web container's nginx now forwards link-preview requests to the API at `http://api:3000`, the name the compose files give it, found through Docker's DNS on the compose network. Without it, previews fall back to the general one. A web app hosted on Cloudflare (see `DEPLOY.md`) keeps the general preview.

## Numbered releases (2026-10-20)

- Searchlight now has numbered releases on [GitHub Releases](https://github.com/Jetlag-Europa/Searchlight/releases), each summing up the changes since the one before. 1.0 is Searchlight as Jules built it on top of JetLagHideAndSeek, up to 26 September 2026; 2.0 is everything since, starting with importable games.
- **Upgrading:** when a release is published, its Docker images are also tagged with its version, such as `2.0.0` and `2.0`. Set `SEARCHLIGHT_IMAGE_TAG=2.0` in `.env` to stay on a release and still get its fixes, instead of following `latest`.

## Every matching cell while planning (2026-10-20)

- A new option, **Show all matching cells when planning?**, draws the borders of every cell a matching question could answer with, not just the seeker's own, while planning mode is on. They are drawn thin and faint behind the seeker's cell, clipped to the play area and simplified. It works for "nearest" questions on point layers, for "same region" questions, and for custom points; line layers such as rivers and rail lines still show only the seeker's cell. Dragging the pin reuses the drawn borders, so only the seeker's cell is redrawn.
- The option is off by default, as a layer with hundreds of cells can slow down the map in some browsers.

## Overlap check agrees with the checker (2026-10-20)

- The import page's and `/designer`'s overlap check now measures an overlap by how far it reaches into a region, as `check-game.mjs` does, instead of by its average width, and no longer ignores one under 1 m² however far it reaches. A border corner poking about 1 m into a neighbour used to pass as rounding on the page, which then marked the layer `noOverlaps`, while the checker flagged it as a defect. The page now finds and fixes such corners. The preloaded games had none.
- The file the page offers for download after a fix keeps the original's formatting. A file on one line used to come back indented, several times larger: a 4.9 MB game came back as 23 MB, and the size warning then counted the larger copy.
- The overlap check, which the import button waits for, runs 3–6 times faster: a game with about 50,000 border vertices, such as Belgium or Greater Manchester, now takes under a second instead of 3–4 s. It also works from the regions' coordinates, so a region carrying a stale or 3D `bbox` no longer makes it miss an overlap.

## Radar listed once, at any radius (2026-10-19)

- The import page's and `/designer`'s "Questions offered" list shows a game's radar as one question, such as "Radar: any radius (presets 400 m, 600 m)" or "Radar: any radius (starts at 1 km)", instead of one "Radar (1000 meters)" line per declared size. The declared sizes were always only where a new radar starts and the radar card's quick picks; players can ask any radius. `check-game.mjs` lists it the same way.

## Fewer false heavy-geometry warnings (2026-10-19)

- The game checker (on the import page, `/designer` and `check-game.mjs`) no longer warns about a region layer only used for matching because of its total vertex count: matching only ever works with the one region a seeker is in. It counts every vertex of layers used for measuring and of line layers used for matching, and the largest region of a region layer used for matching.
- It only suggests simplifying where the vertices lie closer than about 50 m, and now says to use a topology-preserving simplifier, since simplifying each region on its own opens gaps and overlaps between neighbours. A heavy layer whose vertices are already far apart gets a note instead.
- Belgium's "Arrondissement" layer (24,748 vertices, already about 330 m apart) and Greater Manchester's "Ward" layer (36,201 vertices), both only used for matching, are no longer flagged.

## Faster distance-to-border questions on fixed layers (2026-10-19)

- On a region layer marked `"noOverlaps": true` (see below), a distance-to-border question now buffers the whole border network once, each shared border once, instead of buffering every region and cutting them together. In Belgium, a province-border question takes about 1 second at most distances (down from 1 to 2.5 seconds), and 3 to 4 seconds about a kilometre from a border (down from 8 to 12 seconds). The zones it leaves are the same.

## Import page, with a fix for overlapping regions (2026-10-19)

- Importing a game now has its own page, `/games/import`, opened from **+ Import Game JSON** on the games page. It draws the file on the map like `/designer`, lists the checker's findings, and imports it, with the same server, update and unlisted options the import dialog had.
- The import page and `/designer` check every region layer for overlapping regions, such as provinces whose borders were traced separately. For each layer they show how many overlaps there are, their area, the widest, and how many hiding zones reach into one, and draw them on the map.
- **Fix** gives each overlap to the first region in the file, as the game already does when it decides which region a player is in: players stay in the regions they were in (new corners are rounded to about 0.1 m), and a distance to a border moves by at most the overlap's width. Regions that only touch their neighbours are left as they were. The page then offers the fixed file for download, so your copy stays in step.
- A layer already marked `noOverlaps` whose regions do overlap can't be imported until it's fixed or the mark is removed, and `check-game.mjs --strict` fails on one.
- Fixed layers, and layers found without overlaps, are marked `"noOverlaps": true` in the file, and distance-to-border questions on them are answered faster (see above).
- The preloaded games are fixed and marked. Their overlaps were up to 42 m wide (Bucharest, Exeter-Rotterdam and Rotterdam), 29 m in Belgium's provinces.
- **Upgrading:** 21 of the 22 preloaded games changed (all but Brussels), so the API imports a new revision of each of them on its next start.

## Enclaves no longer ruled out by distance questions (2026-10-19)

- A distance-to-boundary question could wrongly rule out the middle of an enclave: a place inside a hole in a region, such as Brussels inside Flemish Brabant. In Belgium, a hider in central Brussels who answered "farther" from a province border than a seeker near one was eliminated, and a "closer" answer kept all of Brussels possible. Measuring and radius questions now keep holes inside holes as they should.

## Faster measuring questions (2026-10-19)

- Measuring questions now build their distance buffers in a map projection centred on the area, which is several times faster than working on the globe directly and just as accurate: the buffer stays within the same tolerance as before (0.05% of the distance, at least 3 ft). In Belgium, "closer to a province border" now takes about 2 seconds instead of 7 to 8 at most distances.
- Borders are never simplified, so answers and the zones they leave are unchanged.
- Working out a distance-to-boundary question no longer blocks the page while it cuts up the regions.
- On a big game, a question asked about a kilometre from a border is still slow (about 10 seconds in Belgium, down from 15 to 19). On a layer marked `noOverlaps` it's faster still (see "Faster distance-to-border questions on fixed layers" above).

## Link copying, place search and full screen fixes (2026-10-19)

- The **Invite** and **Share a copy** drawers only say "Copied!" when the link was really copied. When the browser refuses, as iPhone Safari does after creating a link, they show the link in a field to copy by hand. A failed revoke now shows an error.
- Place search shows the results for what you typed last, not a slower answer to an earlier search. Names with `&`, `#` or `+`, such as "Bahnhof & Post", are searched in full.
- Short Google Plus codes use the whole town after the code ("Q9CM+3P Bad Homburg", not just "Bad"), also with a comma after the code as Google Maps copies it. A short code without a town asks for one.
- The map's full-screen button shows the right icon after leaving full screen with Esc, and is hidden where the browser can't go full screen, such as on iPhone.

## Old questions are back (2026-10-19)

- The old Searchlight looked many questions up in OpenStreetMap while playing. The questions players asked there are now part of their games, with the data looked up once and stored in the game:
  - Bern: Same Canton (also Distance to Canton Boundary), Same Bezirk and Same Administrative Region.
  - Zurich: Same Bezirk, Distance to International Border, Distance to Airport and Distance to Canton Boundary.
  - Budapest: Same District and Distance to Coastline.
  - Brno: Nearest Mountain and Distance to Mountain.
  - Belgium: Nearest Aquarium, Distance to Aquarium, Nearest Mountain and Distance to Mountain.
  - South Limburg: Same Postcode.
  - Rotterdam 12-09: Nearest Park and Distance to Park.
  - London and Accessible London: Distance to High-Speed Rail and Distance to Coastline.
  - Greater Manchester: Distance to Coastline, plus Nearest Library, Distance to Library and Tentacles: Library.
  - North London: Nearest Airport.
  - Paris: Distance to High-Speed Rail and Distance to Coastline.
  - Stockholm 2026 and Luxembourg 2026: Distance to Coastline.
  - Bucharest: Tentacles: Theme Park.
- Sessions already running keep their game version. New sessions get the new questions.
- "Same train line" and a few other old questions still have no equivalent.

## Back where you were after logging in (2026-10-19)

- Logging in now takes you back to the page you opened, such as `/games`, `/admin` or a game link, instead of always the map.
- After logging in from an invite link you're back on the invite page; click **Join** to join the session. Before, you were joined automatically.
- The **Invites** button is now called **Invite**.

## Server list loads without waiting on Discord (2026-10-19)

- The server list in the session picker now shows what Searchlight already knows about your servers and checks with Discord in the background, so it only waits on Discord the first time you open it.
- It checks the servers you aren't in less often. After joining a Discord server, click **Check again** under the server list to see it straight away; otherwise it can take up to half a day to appear.
- Opening a game or session still checks your membership and roles as before.

## Game designer page (2026-10-18)

- A new page, `/designer`, shows a game file on a map before you import it: its play area, bounds, hiding zones and each feature layer, with a panel listing its details, the questions players will be offered and any problems found. No login is needed, and the file never leaves your browser.
- Importing a game now shows the game checker's warnings and notes, and marks the ones that are always data mistakes as defects. They don't block the import, except a layer marked `noOverlaps` whose regions overlap (see "Import page" above).
- `check-game.mjs` no longer starts with `#!/usr/bin/env node`, so run it as `node check-game.mjs`, as the game guide does.

## Planning mode previews each answer (2026-10-18)

- In planning mode, unlocked radar, thermometer, matching and measuring cards show how many hiding zones each answer would leave, such as "Outside → 31 zones" and "Inside → 12 zones", so you can pick the question that splits the zones most evenly. The counts start from what the locked questions leave and skip zones you disabled by hand.
- A zone the line runs through stays possible either way, so it counts for both answers, and the two numbers can add up to more than the zones left.
- The counts update shortly after you stop changing the question. On a big game, a question about the distance to a boundary can take a while to count.

## Undo after deleting questions (2026-10-18)

- Deleting a question, or all of them, now shows a notice with an **Undo** button for 8 seconds. Undo puts the questions back where they were and syncs to everyone, without undoing what your teammates changed in the meantime.
- Only the latest delete can be undone, and switching sessions ends it.
- On phones, notices can now be tapped while the Questions sidebar is open.
- The "No solutions found" error no longer goes missing while another notice is showing.

## Asked questions are marked (2026-10-18)

- The type pickers of matching, measuring and tentacle questions mark the types already asked in the session with "✓ asked", and a radar's quick-pick sizes show the sizes already asked muted. Hidden questions count as asked; custom ones don't.
- A new matching, measuring or tentacle question starts at a type not asked yet, and a new radar at a size not asked yet.
- Nothing is blocked: any type or size can still be picked, since house rules vary.

## New questions start where you are (2026-10-18)

- With Follow Me on, questions added from **Add Question** start at your last GPS position instead of the middle of the map. Without a position they start at the map centre as before, and right-clicking the map still places them where you clicked.
- Thermometers added from **Add Question** no longer have their start and end swapped.
- Follow Me no longer turns itself off when the phone is slow to find your position, for example indoors or on a train. Only refusing location access turns it off. If the phone loses your position, your dot fades until it's found again.

## Hiding zones left (2026-10-18)

- The map and the zone sidebar show how many hiding zones are left, such as "23 of 155 zones left", while "Display hiding zones?" is on. Zones you disabled by hand don't count, and the sidebar says how many it left out.
- The "Calculating…" pill now sits below the session name, where the count goes, so it no longer covers the session name on narrower screens. On phones the count hides while a sidebar is open.
- Switching sessions no longer briefly shows the previous session's zones.

## A lighter map page (2026-10-18)

- The map page loads about 50 KB less JavaScript (gzipped) and the games page about 27 KB less, so both open faster on slow connections.
- Browsers delete an old local copy of drawings from before drawings synced with the session, which could take up megabytes of storage.

## The board survives a reload (2026-10-18)

- Zones you disabled by hand stay disabled when you reload the page or the game gets a new revision. They are kept per session, so each session has its own, and switching back brings yours back. Zones disabled before this update are cleared once.
- A pasted overlay and the zone display settings also survive a reload and a new revision. Opening another session still resets them.
- Zone names now appear from the zoom that suits the game's size, instead of a medium game's until they were toggled.

## Network blips no longer log you out (2026-10-18)

- A slow connection or a server error, such as during a deploy, no longer sends you to the login page. The page shows "Can't reach the server, retrying…" and carries on once the server answers. Only being logged out takes you to the login page.
- The games and admin pages and your saved preferences also load once the server is back, instead of failing until you reload, and changing a setting before your preferences have loaded no longer overwrites them.
- A change the server refuses, such as a question list that's too large, no longer jams syncing. Before, it was retried forever, held up every later change, made the board ignore other players' changes to the same thing and came back after a reload. Now a notice says what couldn't be saved, and the board reloads to show what the server has.

## Uploaded fixes to preloaded games survive restarts (2026-10-18)

- When a game manager uploads a new version of a preloaded game (one that ships with Searchlight, such as paris-2026), or rolls it back to an older one, a server restart no longer quietly puts the shipped version back. The shipped file replaces the game again only once the file itself changes.
- **Upgrading:** the first start after this update can still reset a preloaded game to its file once, if the file holds content the server never preloaded before, such as a reverted file or an upload copied into it.

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
