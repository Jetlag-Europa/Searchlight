import { useStore } from "@nanostores/react";
import type { Game, GamesResponse, GameStats, GameStatsResponse, ServersResponse, ServerWithPermissions } from "@searchlight/shared";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { verifiedUserId } from "@/lib/activeSession";

import { GameLinksDialog } from "./GameLinksDialog";
import { GameSettingsDialog } from "./GameSettingsDialog";
const API_BASE = import.meta.env.PUBLIC_API_BASE as string;

// Unlike the session picker's catalog, this page lists unlisted games too.
const gamesUrl = (serverId: string) =>
    `${API_BASE}/games?serverId=${encodeURIComponent(serverId)}&includeUnlisted=true`;

// Server admins (and global admins, on every server) see each game's usage.
const GAME_PAGE_PERMISSIONS = ["games.create", "games.edit", "games.delete", "server.admin"];

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
        <span title={title}>
            <span className="text-foreground font-medium tabular-nums">{value}</span> {label}
        </span>
    );
}

function GameStatsLine({ stats }: { stats: GameStats }) {
    return (
        <p className="text-xs text-muted-foreground mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5">
            <span title="Sessions with a player connected right now, and the players connected to them">
                {stats.liveSessions > 0 && (
                    <span className="inline-block h-1.5 w-1.5 rounded-full bg-green-500 mr-1 align-middle" />
                )}
                <span className="text-foreground font-medium tabular-nums">{stats.liveSessions}</span> live
                {stats.livePlayers > 0 && ` (${stats.livePlayers} ${stats.livePlayers === 1 ? "player" : "players"})`}
            </span>
            <Stat label="active 24h" value={stats.activeSessions24h} title="Sessions created or changed in the last 24 hours" />
            <Stat label="active 7d" value={stats.activeSessions7d} title="Sessions created or changed in the last 7 days" />
            <Stat label={stats.totalSessions === 1 ? "session" : "sessions"} value={stats.totalSessions} title="Sessions ever started" />
            <Stat label={stats.players === 1 ? "player" : "players"} value={stats.players} title="Players who ever joined a session" />
            <Stat label={stats.questions === 1 ? "question" : "questions"} value={stats.questions} title="Questions across all sessions" />
            {stats.lastActivityAt && (
                <span title={new Date(stats.lastActivityAt).toLocaleString()}>
                    last played {timeAgo(stats.lastActivityAt)}
                </span>
            )}
        </p>
    );
}

function GameCard({
    game,
    stats,
    permissions,
    onDeleted,
    onUpdated,
}: {
    game: Game;
    stats: GameStats | undefined;
    permissions: string[];
    onDeleted: (id: string) => void;
    onUpdated: (game: Game) => void;
}) {
    const [error, setError] = useState<string | null>(null);
    const [savingListing, setSavingListing] = useState(false);
    const canDelete = permissions.includes("games.delete");
    // Any game permission manages listing and links, as on the API.
    const canManage = ["games.create", "games.edit", "games.delete", "server.admin"].some((p) =>
        permissions.includes(p),
    );
    // Same check as the API; a settings edit needs a revision to build on.
    const canEditSettings =
        ["games.edit", "server.admin"].some((p) => permissions.includes(p)) && !!game.currentRevisionId;

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
                const data = await res.json().catch(() => ({})) as { message?: string };
                throw new Error(data.message ?? `${res.status}`);
            }
            onUpdated(await res.json());
        } catch (e: unknown) {
            setError((e as Error).message);
        } finally {
            setSavingListing(false);
        }
    };
    const handleDelete = async () => {
        if (!confirm(`Delete game "${game.name}"? This cannot be undone.`)) return;
        setError(null);
        try {
            const res = await fetch(`${API_BASE}/games/${game.id}`, {
                method: "DELETE",
                credentials: "include",
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({})) as { message?: string };
                throw new Error(data.message ?? `${res.status}`);
            }
            onDeleted(game.id);
        } catch (e: unknown) {
            setError((e as Error).message);
        }
    };

    return (
        <div className="border border-border rounded-lg p-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
                <p className="text-sm font-medium flex items-center gap-2">
                    {game.name}
                    {game.unlisted && (
                        <span
                            className="rounded-full border border-border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
                            title="Not offered when creating a session; sessions start from a game link, also for game managers"
                        >
                            Unlisted
                        </span>
                    )}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5 font-mono">
                    ID: {game.gameKey}
                </p>
                {stats && <GameStatsLine stats={stats} />}
                {error && <p className="text-xs text-destructive mt-1">{error}</p>}
            </div>
            <div className="flex flex-wrap gap-2 sm:justify-end sm:shrink-0">
                {canManage && (
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
                {canManage && <GameLinksDialog game={game} />}
                {canEditSettings && <GameSettingsDialog game={game} onUpdated={onUpdated} />}
                <Button
                    size="sm"
                    variant="outline"
                    onClick={async () => {
                        setError(null);
                        try {
                            const res = await fetch(`${API_BASE}/games/${encodeURIComponent(game.gameKey)}/export`, {
                                credentials: "include",
                            });
                            if (!res.ok) throw new Error(`Export failed with status ${res.status}`);
                            const data = await res.json();
                            const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
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
                    }}
                >
                    Export JSON
                </Button>
                {canDelete && (
                    <Button size="sm" variant="destructive" onClick={handleDelete}>Delete</Button>
                )}
            </div>
        </div>
    );
}

function ServerSection({ server }: { server: ServerWithPermissions }) {
    const canCreate = server.permissions.includes("games.create");
    const canEdit = server.permissions.includes("games.edit");
    const canDelete = server.permissions.includes("games.delete");
    const isServerAdmin = server.permissions.includes("server.admin");
    const hasAnyGamePerm = canCreate || canEdit || canDelete || isServerAdmin;
    const canImport = canCreate || canEdit || isServerAdmin;

    const [games, setGames] = useState<Game[] | null>(null);
    const [stats, setStats] = useState<Map<string, GameStats>>(new Map());
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        fetch(gamesUrl(server.id), { credentials: "include" })
            .then(async (res) => {
                if (!res.ok) { setGames([]); return; }
                const data: GamesResponse = await res.json();
                setGames(data.games);
            })
            .catch(() => setGames([]))
            .finally(() => setLoading(false));
    }, [server.id]);

    useEffect(() => {
        if (!isServerAdmin) return;
        fetch(`${API_BASE}/games/stats?serverId=${encodeURIComponent(server.id)}`, { credentials: "include" })
            .then((res) => (res.ok ? res.json() : null))
            .then((data: GameStatsResponse | null) => {
                if (data) setStats(new Map(data.stats.map((s) => [s.gameId, s])));
            })
            .catch(() => {});
    }, [server.id, isServerAdmin]);


    if (!hasAnyGamePerm) return null;

    return (
        <div className="mb-8">
            <h2 className="text-base font-semibold mb-3">{server.name}</h2>

            {loading && <p className="text-sm text-muted-foreground">Loading…</p>}

            {games !== null && (
                <div className="space-y-2 mb-3">
                    {games.length === 0 && (
                        <p className="text-sm text-muted-foreground italic">No games yet.</p>
                    )}
                    {games.map((g) => (
                        <GameCard
                            key={g.id}
                            game={g}
                            stats={stats.get(g.id)}
                            permissions={server.permissions}
                            onDeleted={(id) => setGames((prev) => (prev ?? []).filter((x) => x.id !== id))}
                            onUpdated={(game) => setGames((prev) => (prev ?? []).map((x) => (x.id === game.id ? game : x)))}
                        />
                    ))}
                </div>
            )}

            {canImport && (
                <div className="flex gap-2">
                    <Button asChild variant="outline" size="sm">
                        <a href={`/games/import?server=${encodeURIComponent(server.id)}`}>
                            Import JSON Game
                        </a>
                    </Button>
                </div>
            )}
        </div>
    );
}

export function GameManager() {
    const [servers, setServers] = useState<ServerWithPermissions[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const userId = useStore(verifiedUserId);

    // Load once AuthGuard has verified the login, which waits out a server
    // that was down when the page opened.
    useEffect(() => {
        if (!userId) return;
        fetch(`${API_BASE}/servers`, { credentials: "include" })
            .then(async (res) => {
                if (!res.ok) throw new Error(`${res.status}`);
                const data: ServersResponse = await res.json();
                setServers(data.servers);
            })
            .catch((e: Error) => setError(e.message));
    }, [userId]);

    if (error) return <p className="text-destructive">Error: {error}</p>;
    if (!servers) return <p className="text-muted-foreground">Loading…</p>;

    const adminServers = servers.filter((s) =>
        s.permissions.some((p) => GAME_PAGE_PERMISSIONS.includes(p)),
    );
    const importableServers = servers.filter((s) =>
        s.permissions.some((p) => ["games.create", "games.edit", "server.admin"].includes(p)),
    );

    if (adminServers.length === 0) {
        return <p className="text-muted-foreground">You don’t have game management permissions in any server.</p>;
    }
    return (
        <div>
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-6 mb-6 border-b border-border">
                <div>
                    <h1 className="text-xl font-bold">Games & Maps</h1>
                    <p className="text-xs text-muted-foreground mt-1">
                        Import or export versioned game definitions as JSON, or manage server maps.
                    </p>
                </div>
                {importableServers.length > 0 && (
                    <Button asChild className="font-semibold shadow-sm">
                        <a href="/games/import">+ Import Game JSON</a>
                    </Button>
                )}
            </div>
            {adminServers.map((s) => (
                <ServerSection key={s.id} server={s} />
            ))}
        </div>
    );
}
