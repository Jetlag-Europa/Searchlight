import { useStore } from "@nanostores/react";
import {
  CASUAL_GAME_LIMIT,
  CASUAL_SERVER_ID,
  CASUAL_STORAGE_LIMIT_MB,
  type Game,
  type GameDefinition,
  type GamesResponse,
  type GameStats,
  type GameStatsResponse,
  type ServersResponse,
  type ServerWithPermissions,
} from "@searchlight/shared";
import { ChevronRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { RawInput } from "@/components/ui/input";
import { formatGameExportJson } from "@/game-definition/export";
import { verifiedUserId } from "@/lib/activeSession";
import { saveCreatorOpenHandoff } from "@/lib/creator/handoff";

import { GameHistoryDialog } from "./GameHistoryDialog";
import { GameLinksDialog } from "./GameLinksDialog";
import { GameSettingsDialog } from "./GameSettingsDialog";
const API_BASE = import.meta.env.PUBLIC_API_BASE as string;

// Unlike the session picker's catalog, this page lists unlisted games too.
const gamesUrl = (serverId: string) =>
  `${API_BASE}/games?serverId=${encodeURIComponent(serverId)}&includeUnlisted=true`;

// Server admins (and global admins, on every server) see each game's usage.
const GAME_PAGE_PERMISSIONS = ["games.create", "games.edit", "games.delete", "server.admin"];
const hasGamePermission = (server: ServerWithPermissions) =>
  server.permissions.some((p) => GAME_PAGE_PERMISSIONS.includes(p));

// A section with more games than this gets a search, collapsed rows sorted by
// last update, and paging; shorter ones look as they always did.
const LONG_SECTION = 10;
const PAGE_SIZE = 20;

const relativeTime = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

function timeAgo(iso: string): string {
  const minutes = Math.round((Date.parse(iso) - Date.now()) / 60_000);
  if (minutes > -60) return relativeTime.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours > -24) return relativeTime.format(hours, "hour");
  return relativeTime.format(Math.round(hours / 24), "day");
}

function Stat({ label, value, title }: { label: string; value: string | number; title: string }) {
  return (
    <span title={title} className="whitespace-nowrap">
      <span className="text-foreground/80 tabular-nums">{value}</span> {label}
    </span>
  );
}

function GameStatsLine({ stats }: { stats: GameStats }) {
  const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
  return (
    <p className="text-xs text-muted-foreground flex flex-wrap gap-x-3 gap-y-0.5">
      <span
        title="Sessions with a player connected right now, and the players connected to them"
        className="whitespace-nowrap"
      >
        {stats.liveSessions > 0 && (
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-green-500 mr-1 align-middle" />
        )}
        <span className="text-foreground/80 tabular-nums">{stats.liveSessions}</span> live
        {stats.livePlayers > 0 &&
          ` (${stats.livePlayers} ${plural(stats.livePlayers, "player", "players")})`}
      </span>
      <Stat
        label="active 24h"
        value={stats.activeSessions24h}
        title="Sessions created or changed in the last 24 hours"
      />
      <Stat
        label="active 7d"
        value={stats.activeSessions7d}
        title="Sessions created or changed in the last 7 days"
      />
      <Stat
        label={plural(stats.totalSessions, "session", "sessions")}
        value={stats.totalSessions}
        title="Sessions ever started"
      />
      <Stat
        label={plural(stats.players, "player", "players")}
        value={stats.players}
        title="Players who ever joined a session"
      />
      <Stat
        label={plural(stats.questions, "question", "questions")}
        value={stats.questions}
        title="Questions across all sessions"
      />
      {stats.localOpens > 0 && (
        <Stat
          label={plural(stats.localOpens, "local open", "local opens")}
          value={stats.localOpens}
          title="Downloads of the game for local play through its game links"
        />
      )}
      {stats.lastActivityAt && (
        <span title={new Date(stats.lastActivityAt).toLocaleString()} className="whitespace-nowrap">
          last played {timeAgo(stats.lastActivityAt)}
        </span>
      )}
    </p>
  );
}

function GameRow({
  game,
  stats,
  permissions,
  defaultOpen,
  summaryRef,
  onDeleted,
  onUpdated,
}: {
  game: Game;
  stats: GameStats | undefined;
  permissions: string[];
  defaultOpen: boolean;
  summaryRef: (el: HTMLElement | null) => void;
  onDeleted: (id: string) => void;
  onUpdated: (game: Game) => void;
}) {
  // Controlled, so a re-render (stats arriving, another row changing)
  // doesn't put the row back the way it started.
  const [open, setOpen] = useState(defaultOpen);
  const [error, setError] = useState<string | null>(null);
  const [savingListing, setSavingListing] = useState(false);
  const [openingCreator, setOpeningCreator] = useState(false);
  const userId = useStore(verifiedUserId);
  const casual = game.serverId === CASUAL_SERVER_ID;
  const ownGame = !!userId && game.createdById === userId;
  // Creators may delete their Casual games even after leaving every server.
  const canDelete = permissions.includes("games.delete") || (casual && ownGame);
  // Any game permission manages listing and links, as on the API. Casual
  // games are managed by their creator and global admins (the only ones
  // with server.admin there), and are always unlisted.
  const canManage = casual
    ? permissions.includes("server.admin") || ownGame
    : ["games.create", "games.edit", "games.delete", "server.admin"].some((p) =>
        permissions.includes(p),
      );
  // Same check as the API's (canUpdate in import-service.ts): games.edit or
  // server.admin, or on Casual Games the creator while they hold games.create.
  const canUpdate =
    ["games.edit", "server.admin"].some((p) => permissions.includes(p)) ||
    (casual && ownGame && permissions.includes("games.create"));
  // A settings edit or Creator load needs a revision to build on.
  const canEditSettings = canUpdate && !!game.currentRevisionId;
  const canExport = canManage || !casual;
  const canOpenInCreator = (canUpdate || canExport) && !!game.currentRevisionId;

  const handleToggleListed = async () => {
    setError(null);
    setSavingListing(true);
    try {
      const res = await fetch(`${API_BASE}/games/${game.id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ unlisted: !game.unlisted }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(data.message ?? `${res.status}`);
      }
      onUpdated(await res.json());
    } catch (e: unknown) {
      setError((e as Error).message);
    } finally {
      setSavingListing(false);
    }
  };
  const handleExport = async () => {
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/games/${encodeURIComponent(game.id)}/export`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error(`Export failed with status ${res.status}`);
      const data = await res.json();
      const blob = new Blob([formatGameExportJson(data, game.gameKey)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${game.gameKey}.game.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e: unknown) {
      setError((e as Error).message);
    }
  };
  const handleOpenInCreator = async () => {
    setError(null);
    setOpeningCreator(true);
    try {
      const res = await fetch(`${API_BASE}/games/${encodeURIComponent(game.id)}/export`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error(`Couldn't load game definition (${res.status})`);
      const raw = (await res.json()) as GameDefinition;
      const definition: GameDefinition = raw.id ? raw : { id: game.gameKey, ...raw };
      const openId = await saveCreatorOpenHandoff(
        canUpdate
          ? {
              mode: "edit",
              definition,
              replaceGameId: game.id,
              sourceGameName: game.name,
            }
          : {
              mode: "copy",
              definition,
              sourceGameName: game.name,
            },
      );
      if (!openId) {
        throw new Error(
          "Browser storage is unavailable. Export the JSON file and load it in Map Creator instead.",
        );
      }
      window.location.href = `/create?open=${encodeURIComponent(openId)}`;
    } catch (e: unknown) {
      setError((e as Error).message);
      setOpeningCreator(false);
    }
  };
  const handleDelete = async () => {
    if (
      !confirm(
        `Delete "${game.name}"? It disappears from the games list and its game links stop working. Sessions already started keep working until their creators delete them. This can't be undone: use Export JSON first if you want to keep a copy.`,
      )
    )
      return;
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/games/${game.id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(data.message ?? `${res.status}`);
      }
      onDeleted(game.id);
    } catch (e: unknown) {
      setError((e as Error).message);
    }
  };

  const uploader = ownGame ? "you" : game.createdByName;
  const updatedAt = game.currentRevisionId ? game.updatedAt : null;

  return (
    <details
      className="group border border-border rounded-lg"
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      {/* Text only, no buttons: <summary> is the row's toggle. Its content
          may be phrasing or heading content, so no divs. */}
      <summary
        ref={summaryRef}
        className="grid cursor-pointer list-none grid-cols-[auto_minmax(0,1fr)] items-start gap-x-2 rounded-lg p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden"
      >
        <ChevronRight
          aria-hidden="true"
          className="mt-1 h-4 w-4 text-muted-foreground transition-transform group-open:rotate-90"
        />
        <h3 className="flex flex-wrap items-center gap-x-2 gap-y-1 text-base font-semibold">
          <span className="min-w-0 break-words">{game.name}</span>
          {game.unlisted && !casual && (
            <span
              className="rounded-full border border-border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
              title="Not offered when creating a session; sessions start from a game link, also for game managers"
            >
              Unlisted
            </span>
          )}
        </h3>
        {(uploader || updatedAt) && (
          <span className="col-start-2 mt-0.5 text-xs text-muted-foreground">
            {uploader && `by ${uploader}`}
            {uploader && updatedAt && " · "}
            {updatedAt && (
              <span title={new Date(updatedAt).toLocaleString()}>updated {timeAgo(updatedAt)}</span>
            )}
          </span>
        )}
      </summary>
      <div className="flex flex-col gap-3 px-4 pb-4">
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground font-mono break-all">{game.gameKey}</p>
          {stats && (
            <div className="mt-2">
              <GameStatsLine stats={stats} />
            </div>
          )}
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
        <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
          {canManage && <GameLinksDialog game={game} />}
          {canEditSettings && <GameSettingsDialog game={game} onUpdated={onUpdated} />}
          {canManage && <GameHistoryDialog game={game} />}
          {canOpenInCreator && (
            <Button
              size="sm"
              variant="outline"
              disabled={openingCreator}
              onClick={handleOpenInCreator}
              title={
                canUpdate
                  ? "Open this game in Map Creator to edit and publish a new revision"
                  : "Open a copy of this game in Map Creator (will not modify the original game)"
              }
            >
              {openingCreator ? "Opening…" : canUpdate ? "Edit in Creator" : "Open in Creator"}
            </Button>
          )}
          {canUpdate && (
            <Button asChild size="sm" variant="outline">
              <a
                href={`/games/import?replace=${encodeURIComponent(game.id)}`}
                title="Upload a new version of this game from a file. The file's ID and server are ignored: the game keeps its own."
              >
                Replace with file…
              </a>
            </Button>
          )}
          {canExport && (
            <Button size="sm" variant="outline" onClick={handleExport}>
              Export JSON
            </Button>
          )}
          {canManage && !casual && (
            <Button
              size="sm"
              variant="outline"
              disabled={savingListing}
              onClick={handleToggleListed}
              title={
                game.unlisted
                  ? "Show this game to everyone who can play it"
                  : "Stop offering this game when creating a session; sessions then start from game links"
              }
            >
              {game.unlisted ? "Make listed" : "Make unlisted"}
            </Button>
          )}
          {canDelete && (
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={handleDelete}
            >
              Delete
            </Button>
          )}
        </div>
      </div>
    </details>
  );
}

// Newest upload first; games without a revision last.
const byLastUpdate = (a: Game, b: Game) =>
  (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "") || a.name.localeCompare(b.name);

function ServerSection({
  server,
  onGamesLoaded,
}: {
  server: ServerWithPermissions;
  onGamesLoaded?: (count: number) => void;
}) {
  const casual = server.id === CASUAL_SERVER_ID;
  const canCreate = server.permissions.includes("games.create");
  const canEdit = server.permissions.includes("games.edit");
  const canDelete = server.permissions.includes("games.delete");
  const isServerAdmin = server.permissions.includes("server.admin");
  const hasAnyGamePerm = canCreate || canEdit || canDelete || isServerAdmin;
  const canImport = canCreate || canEdit || isServerAdmin;

  const [games, setGames] = useState<Game[] | null>(null);
  const [stats, setStats] = useState<Map<string, GameStats>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [query, setQuery] = useState("");
  const [shownCount, setShownCount] = useState(PAGE_SIZE);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const summaries = useRef(new Map<string, HTMLElement>());
  // Where focus goes once a deleted game's row is gone: another row's id,
  // or "" for the heading.
  const focusAfterDelete = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(gamesUrl(server.id), { credentials: "include" })
      .then(async (res) => {
        if (!res.ok) {
          if (!cancelled) setError(`Couldn't load games (${res.status})`);
          return;
        }
        const data: GamesResponse = await res.json();
        if (!cancelled) setGames(data.games);
      })
      .catch(() => {
        if (!cancelled) setError("Couldn't load games (network error)");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [server.id, loadAttempt]);

  // Also after a delete, so deleting the last one can empty the page.
  useEffect(() => {
    if (games) onGamesLoaded?.(games.length);
  }, [games, onGamesLoaded]);

  useEffect(() => {
    const target = focusAfterDelete.current;
    if (target === null) return;
    focusAfterDelete.current = null;
    (summaries.current.get(target) ?? headingRef.current)?.focus();
  }, [games]);

  useEffect(() => {
    if (!isServerAdmin) return;
    fetch(`${API_BASE}/games/stats?serverId=${encodeURIComponent(server.id)}`, {
      credentials: "include",
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: GameStatsResponse | null) => {
        if (data) setStats(new Map(data.stats.map((s) => [s.gameId, s])));
      })
      .catch(() => {});
  }, [server.id, isServerAdmin, loadAttempt]);

  // A Casual creator who left every server still manages the games they made.
  if (!hasAnyGamePerm && (!casual || games?.length === 0)) return null;

  const long = (games?.length ?? 0) > LONG_SECTION;
  // Only while the search box shows: a delete can make the section short.
  const needle = long ? query.trim().toLowerCase() : "";
  const listed = !games
    ? []
    : !long
      ? games
      : games
          .filter(
            (g) =>
              !needle ||
              [g.name, g.gameKey, g.createdByName, g.createdById].some((v) =>
                v?.toLowerCase().includes(needle),
              ),
          )
          .sort(byLastUpdate);
  const shown = long ? listed.slice(0, shownCount) : listed;
  const left = listed.length - shown.length;

  const handleDeleted = (id: string) => {
    const i = listed.findIndex((g) => g.id === id);
    focusAfterDelete.current = (listed[i + 1] ?? listed[i - 1])?.id ?? "";
    setGames((prev) => (prev ?? []).filter((x) => x.id !== id));
  };

  return (
    <section id={casual ? "casual-games" : undefined} className="mb-10">
      <div className="flex flex-wrap items-end justify-between gap-2 mb-3">
        <div className="min-w-0">
          <h2 ref={headingRef} tabIndex={-1} className="text-lg font-semibold focus:outline-none">
            {server.name}
            {games && (
              <span className="font-normal text-muted-foreground">
                {` · ${games.length} ${games.length === 1 ? "game" : "games"}`}
              </span>
            )}
          </h2>
          {casual && (
            <p className="text-xs text-muted-foreground">
              Anyone in one of the JetLag Discord servers can upload Casual games: up to{" "}
              {CASUAL_GAME_LIMIT} games and {CASUAL_STORAGE_LIMIT_MB} MB in total per person. Only
              the creator and the Searchlight admins see each game here. Anyone with a game link can
              play it.
            </p>
          )}
          {/* Global admins have no limit, and see everyone's games. */}
          {casual && games && !isServerAdmin && (
            <p className="text-xs text-muted-foreground mt-1">
              You have {games.length} of {CASUAL_GAME_LIMIT} Casual games.
            </p>
          )}
        </div>
        {canImport && (
          <Button asChild variant="outline" size="sm">
            <a href={`/games/import?server=${encodeURIComponent(server.id)}`}>Import JSON Game</a>
          </Button>
        )}
      </div>

      {loading && <p className="text-sm text-muted-foreground">Loading…</p>}

      {error && (
        <div className="flex items-center gap-3 mb-3">
          <p className="text-sm text-destructive">{error}</p>
          <Button size="sm" variant="outline" onClick={() => setLoadAttempt((n) => n + 1)}>
            Retry
          </Button>
        </div>
      )}

      {games !== null && (
        <div className="space-y-3">
          {games.length === 0 && (
            <p className="text-sm text-muted-foreground italic">No games yet.</p>
          )}
          {long && (
            <RawInput
              type="search"
              aria-label={`Search ${server.name}`}
              placeholder="Search by game or uploader"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setShownCount(PAGE_SIZE);
              }}
            />
          )}
          {long && listed.length === 0 && (
            <p className="text-sm text-muted-foreground italic">No games match “{query.trim()}”.</p>
          )}
          {shown.map((g) => (
            <GameRow
              key={g.id}
              game={g}
              stats={stats.get(g.id)}
              permissions={server.permissions}
              defaultOpen={!long}
              summaryRef={(el) => {
                if (el) summaries.current.set(g.id, el);
                else summaries.current.delete(g.id);
              }}
              onDeleted={handleDeleted}
              onUpdated={(game) =>
                setGames((prev) => (prev ?? []).map((x) => (x.id === game.id ? game : x)))
              }
            />
          ))}
          {left > 0 && (
            <Button variant="outline" size="sm" onClick={() => setShownCount((n) => n + PAGE_SIZE)}>
              Show {Math.min(PAGE_SIZE, left)} more ({left} left)
            </Button>
          )}
        </div>
      )}
    </section>
  );
}

export function GameManager() {
  const [servers, setServers] = useState<ServerWithPermissions[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  // Check again asks Discord again, for someone who just joined a server.
  const recheck = useRef(false);
  const userId = useStore(verifiedUserId);
  // How many Casual games are listed for the user, for when they have no
  // permission there: creators keep their games after leaving every server.
  const [casualGames, setCasualGames] = useState<number | null>(null);

  // Load once AuthGuard has verified the login, which waits out a server
  // that was down when the page opened.
  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    setError(null);
    fetch(`${API_BASE}/servers${recheck.current ? "?recheck=true" : ""}`, {
      credentials: "include",
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`${res.status}`);
        const data: ServersResponse = await res.json();
        if (!cancelled) setServers(data.servers);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      });
    recheck.current = false;
    return () => {
      cancelled = true;
    };
  }, [userId, loadAttempt]);

  if (error) {
    return (
      <div className="flex items-center gap-3">
        <p className="text-destructive">Error: {error}</p>
        <Button size="sm" variant="outline" onClick={() => setLoadAttempt((n) => n + 1)}>
          Retry
        </Button>
      </div>
    );
  }
  if (!servers) return <p className="text-muted-foreground">Loading…</p>;

  // Casual is listed for its creators even without a permission there; its
  // section hides itself if they have no games after all.
  const adminServers = servers.filter((s) => hasGamePermission(s) || s.id === CASUAL_SERVER_ID);
  const casualServer = adminServers.find((s) => s.id === CASUAL_SERVER_ID);
  const casualShown = !!casualServer && (hasGamePermission(casualServer) || casualGames !== 0);
  const importableServers = servers.filter((s) =>
    s.permissions.some((p) => ["games.create", "games.edit", "server.admin"].includes(p)),
  );

  if (!servers.some(hasGamePermission) && !casualShown) {
    return (
      <div className="space-y-3">
        <p className="text-muted-foreground">
          To upload Casual games, join one of the JetLag Discord servers that use Searchlight.
        </p>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            recheck.current = true;
            setServers(null);
            setLoadAttempt((n) => n + 1);
          }}
        >
          Check again
        </Button>
      </div>
    );
  }
  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-6 mb-6 border-b border-border">
        <div>
          <h2 className="text-xl font-bold">Games & Maps</h2>
          <p className="text-xs text-muted-foreground mt-1">
            Import or export versioned game definitions as JSON, or manage server maps.
          </p>
          {casualShown && adminServers.length > 1 && (
            <a href="#casual-games" className="mt-1 inline-block text-xs underline">
              Jump to Casual games
            </a>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button asChild variant="outline" className="font-semibold">
            <a href="/create">Map Creator</a>
          </Button>
          {importableServers.length > 0 && (
            <Button asChild className="font-semibold shadow-sm">
              <a href="/games/import">+ Import Game JSON</a>
            </Button>
          )}
        </div>
      </div>
      {adminServers.map((s) => (
        <ServerSection
          key={s.id}
          server={s}
          onGamesLoaded={s.id === CASUAL_SERVER_ID ? setCasualGames : undefined}
        />
      ))}
    </div>
  );
}
