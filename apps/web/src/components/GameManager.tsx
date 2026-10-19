import { useStore } from "@nanostores/react";
import {
    compareByEventDate,
    type Game,
    type GamesResponse,
    type GameStats,
    type GameStatsResponse,
    type ServersResponse,
    type ServerWithPermissions,
    type UpdateGameBody,
} from "@searchlight/shared";
import { BookOpen } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { verifiedUserId } from "@/lib/activeSession";
import { formatEventDate, rulesLink } from "@/lib/eventDate";

import { GameDetailsDialog } from "./GameDetailsDialog";
import { GameLinksDialog } from "./GameLinksDialog";
import { ImportGameDialog } from "./ImportGameDialog";
const API_BASE = import.meta.env.PUBLIC_API_BASE as string;

// Unlike the session picker's catalog, this page lists unlisted and archived
// games too.
const gamesUrl = (serverId: string) =>
    `${API_BASE}/games?serverId=${encodeURIComponent(serverId)}&includeUnlisted=true&includeArchived=true`;

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
    const [saving, setSaving] = useState(false);
    const canDelete = permissions.includes("games.delete");
    // Any game permission manages listing and links, as on the API.
    const canManage = ["games.create", "games.edit", "games.delete", "server.admin"].some((p) =>
        permissions.includes(p),
    );

    const patchGame = async (body: UpdateGameBody) => {
        setError(null);
        setSaving(true);
        try {
            const res = await fetch(`${API_BASE}/games/${game.id}`, {
                method: "PATCH",
                credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({})) as { message?: string };
                throw new Error(data.message ?? `${res.status}`);
            }
            onUpdated(await res.json());
        } catch (e: unknown) {
            setError((e as Error).message);
        } finally {
            setSaving(false);
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

    const rules = rulesLink(game.rulesUrl);
    return (
        <div className="border border-border rounded-lg p-3 flex items-center justify-between gap-3">
            <div className="min-w-0">
                <p className="text-sm font-medium flex flex-wrap items-center gap-2">
                    {game.name}
                    {game.archivedAt && (
                        <span
                            className="rounded-full border border-border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
                            title="A past event: not offered when creating a session, and shown in Find a game only on request. Its sessions and links keep working."
                        >
                            Archived
                        </span>
                    )}
                    {game.unlisted && (
                        <span
                            className="rounded-full border border-border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
                            title="Not offered when creating a session; sessions start from a game link, also for game managers"
                        >
                            Unlisted
                        </span>
                    )}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5">
                    <span className="font-mono">ID: {game.gameKey}</span>
                    {game.date && <span>{formatEventDate(game.date, game.endDate)}</span>}
                    {rules && (
                        <a
                            href={rules}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 underline hover:text-foreground"
                            aria-label={`Rules of ${game.name} (opens in a new tab)`}
                        >
                            <BookOpen className="h-3 w-3" />
                            Rules
                        </a>
                    )}
                </p>
                {stats && <GameStatsLine stats={stats} />}
                {error && <p className="text-xs text-destructive mt-1">{error}</p>}
            </div>
            <div className="flex flex-wrap justify-end gap-2 shrink-0">
                {canManage && <GameDetailsDialog game={game} onUpdated={onUpdated} />}
                {canManage && (
                    <Button
                        size="sm"
                        variant="outline"
                        disabled={saving}
                        onClick={() => patchGame({ archived: !game.archivedAt })}
                        title={
                            game.archivedAt
                                ? "Offer this game again when creating a session"
                                : "A past event: stop offering it when creating a session and in Find a game. Its sessions and links keep working."
                        }
                    >
                        {game.archivedAt ? "Unarchive" : "Archive"}
                    </Button>
                )}
                {canManage && (
                    <Button
                        size="sm"
                        variant="outline"
                        disabled={saving}
                        onClick={() => patchGame({ unlisted: !game.unlisted })}
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

    // Newest event first, as the API lists them; archived games apart.
    const sorted = [...(games ?? [])].sort(compareByEventDate);
    const currentGames = sorted.filter((g) => !g.archivedAt);
    const archivedGames = sorted.filter((g) => g.archivedAt);
    const card = (g: Game) => (
        <GameCard
            key={g.id}
            game={g}
            stats={stats.get(g.id)}
            permissions={server.permissions}
            onDeleted={(id) => setGames((prev) => (prev ?? []).filter((x) => x.id !== id))}
            onUpdated={(game) => setGames((prev) => (prev ?? []).map((x) => (x.id === game.id ? game : x)))}
        />
    );

    return (
        <div className="mb-8">
            <h2 className="text-base font-semibold mb-3">{server.name}</h2>

            {loading && <p className="text-sm text-muted-foreground">Loading…</p>}

            {games !== null && (
                <div className="space-y-2 mb-3">
                    {games.length === 0 && (
                        <p className="text-sm text-muted-foreground italic">No games yet.</p>
                    )}
                    {currentGames.map(card)}
                    {archivedGames.length > 0 && (
                        <details className="group">
                            <summary className="cursor-pointer select-none text-sm text-muted-foreground hover:text-foreground py-1">
                                Archived ({archivedGames.length})
                            </summary>
                            <div className="space-y-2 mt-2">{archivedGames.map(card)}</div>
                        </details>
                    )}
                </div>
            )}

            {canImport && (
                <div className="flex gap-2">
                    <ImportGameDialog
                        serverId={server.id}
                        onImported={() => {
                            fetch(gamesUrl(server.id), { credentials: "include" })
                                .then((r) => (r.ok ? r.json() : null))
                                .then((data: GamesResponse | null) => {
                                    if (data) setGames(data.games);
                                });
                        }}
                    />
                </div>
            )}
        </div>
    );
}

export function GameManager() {
    const [servers, setServers] = useState<ServerWithPermissions[] | null>(null);
    const [reloadCounter, setReloadCounter] = useState(0);
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
                    <ImportGameDialog
                        servers={importableServers}
                        onImported={() => setReloadCounter((c) => c + 1)}
                        trigger={
                            <Button className="font-semibold shadow-sm">
                                + Import Game JSON
                            </Button>
                        }
                    />
                )}
            </div>
            {adminServers.map((s) => (
                <ServerSection key={`${s.id}-${reloadCounter}`} server={s} />
            ))}
        </div>
    );
}
