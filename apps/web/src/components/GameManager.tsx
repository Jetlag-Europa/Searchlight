import type { Game,GamesResponse, ServersResponse, ServerWithPermissions } from "@searchlight/shared";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";

import { GameLinksDialog } from "./GameLinksDialog";
import { ImportGameDialog } from "./ImportGameDialog";
const API_BASE = import.meta.env.PUBLIC_API_BASE as string;

// Unlike the session picker's catalog, this page lists unlisted games too.
const gamesUrl = (serverId: string) =>
    `${API_BASE}/games?serverId=${encodeURIComponent(serverId)}&includeUnlisted=true`;

function GameCard({
    game,
    permissions,
    onDeleted,
    onUpdated,
}: {
    game: Game;
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
        <div className="border border-border rounded-lg p-3 flex items-center justify-between gap-3">
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
                {error && <p className="text-xs text-destructive mt-1">{error}</p>}
            </div>
            <div className="flex flex-wrap justify-end gap-2 shrink-0">
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
    const hasAnyGamePerm = canCreate || canEdit || canDelete;
    const canImport = canCreate || canEdit;

    const [games, setGames] = useState<Game[] | null>(null);
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
                            permissions={server.permissions}
                            onDeleted={(id) => setGames((prev) => (prev ?? []).filter((x) => x.id !== id))}
                            onUpdated={(game) => setGames((prev) => (prev ?? []).map((x) => (x.id === game.id ? game : x)))}
                        />
                    ))}
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

    useEffect(() => {
        fetch(`${API_BASE}/servers`, { credentials: "include" })
            .then(async (res) => {
                if (!res.ok) throw new Error(`${res.status}`);
                const data: ServersResponse = await res.json();
                setServers(data.servers);
            })
            .catch((e: Error) => setError(e.message));
    }, []);

    if (error) return <p className="text-destructive">Error: {error}</p>;
    if (!servers) return <p className="text-muted-foreground">Loading…</p>;

    const adminServers = servers.filter((s) =>
        s.permissions.some((p) => ["games.create", "games.edit", "games.delete"].includes(p)),
    );
    const importableServers = servers.filter((s) =>
        s.permissions.some((p) => ["games.create", "games.edit"].includes(p)),
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
