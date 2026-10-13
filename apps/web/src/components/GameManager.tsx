import type {
    Game,
    GameLinkSummary,
    GamesResponse,
    ServersResponse,
    ServerWithPermissions,
} from "@searchlight/shared";
import { useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

import { ImportGameDialog } from "./ImportGameDialog";
const API_BASE = import.meta.env.PUBLIC_API_BASE as string;

// games.create-unlisted lets trusted people upload private games and manage
// their own; making a game public takes games.create or games.edit.
const MANAGE_PERMISSIONS = [
    "games.create",
    "games.create-unlisted",
    "games.edit",
    "games.delete",
];
const IMPORT_PERMISSIONS = ["games.create", "games.create-unlisted", "games.edit"];
const LIST_PERMISSIONS = ["games.create", "games.edit", "server.admin"];

async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${API_BASE}${path}`, {
        credentials: "include",
        ...init,
        headers: init?.body ? { "Content-Type": "application/json" } : undefined,
    });
    if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(data.message ?? `${res.status}`);
    }
    return (res.status === 204 ? undefined : await res.json()) as T;
}

const joinUrl = (token: string) =>
    `${window.location.origin}/join?token=${encodeURIComponent(token)}`;

function GameLinks({ game }: { game: Game }) {
    const [links, setLinks] = useState<GameLinkSummary[] | null>(null);
    const [label, setLabel] = useState("");
    const [creating, setCreating] = useState(false);
    const [copiedId, setCopiedId] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        apiRequest<{ links: GameLinkSummary[] }>(`/games/${game.id}/links`)
            .then((data) => setLinks(data.links))
            .catch((e: Error) => setError(e.message));
    }, [game.id]);

    const copy = async (link: GameLinkSummary) => {
        await navigator.clipboard.writeText(joinUrl(link.token)).catch(() => {});
        setCopiedId(link.id);
    };

    const create = async () => {
        setCreating(true);
        setError(null);
        try {
            const link = await apiRequest<GameLinkSummary>(`/games/${game.id}/links`, {
                method: "POST",
                body: JSON.stringify({ label: label.trim() || undefined }),
            });
            setLinks((prev) => [link, ...(prev ?? [])]);
            setLabel("");
            await copy(link);
        } catch (e: unknown) {
            setError((e as Error).message);
        } finally {
            setCreating(false);
        }
    };

    const revoke = async (link: GameLinkSummary) => {
        if (
            !confirm(
                "Revoke this link? It stops starting new sessions; sessions already started from it keep working.",
            )
        )
            return;
        setError(null);
        try {
            await apiRequest(`/games/${game.id}/links/${link.id}`, { method: "DELETE" });
            setLinks((prev) => (prev ?? []).filter((l) => l.id !== link.id));
        } catch (e: unknown) {
            setError((e as Error).message);
        }
    };

    return (
        <div className="mt-3 pt-3 border-t border-border space-y-2">
            <p className="text-xs text-muted-foreground">
                Anyone with a link can start their own session of this game, as often as they
                like, without seeing it in the game list.
            </p>
            {links?.map((link) => (
                <div key={link.id} className="flex items-center justify-between gap-2 text-xs">
                    <div className="min-w-0">
                        <p className="font-medium">{link.label ?? "Unlabelled link"}</p>
                        <p className="text-muted-foreground font-mono truncate">
                            {joinUrl(link.token)}
                        </p>
                    </div>
                    <div className="flex gap-2 shrink-0">
                        <Button size="sm" variant="outline" onClick={() => copy(link)}>
                            {copiedId === link.id ? "Copied" : "Copy"}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => revoke(link)}>
                            Revoke
                        </Button>
                    </div>
                </div>
            ))}
            {links?.length === 0 && (
                <p className="text-xs text-muted-foreground italic">No active links.</p>
            )}
            <div className="flex gap-2">
                <input
                    className="flex-1 min-w-0 border border-input rounded-md px-2.5 py-1 text-xs bg-background"
                    placeholder="Label (optional), e.g. who it's for"
                    maxLength={100}
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                />
                <Button size="sm" onClick={create} disabled={creating}>
                    {creating ? "Creating…" : "New link"}
                </Button>
            </div>
            {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
    );
}

function GameCard({
    game,
    permissions,
    onChanged,
    onDeleted,
}: {
    game: Game;
    permissions: string[];
    onChanged: (game: Game) => void;
    onDeleted: (id: string) => void;
}) {
    const [error, setError] = useState<string | null>(null);
    const [showLinks, setShowLinks] = useState(false);
    const isPrivate = game.listing === "unlisted";
    const canDelete =
        permissions.includes("games.delete") || (game.isOwner && game.canManage);
    const canList = permissions.some((p) => LIST_PERMISSIONS.includes(p));

    const handleDelete = async () => {
        if (!confirm(`Delete game "${game.name}"? This cannot be undone.`)) return;
        setError(null);
        try {
            await apiRequest(`/games/${game.id}`, { method: "DELETE" });
            onDeleted(game.id);
        } catch (e: unknown) {
            setError((e as Error).message);
        }
    };

    const setListing = async (listing: Game["listing"]) => {
        if (
            listing === "listed" &&
            !confirm(
                `Make "${game.name}" public? It will appear in the game list, and its private links stop working.`,
            )
        )
            return;
        setError(null);
        try {
            const updated = await apiRequest<Game>(`/games/${game.id}`, {
                method: "PATCH",
                body: JSON.stringify({ listing }),
            });
            setShowLinks(false);
            onChanged(updated);
        } catch (e: unknown) {
            setError((e as Error).message);
        }
    };

    const handleExport = async () => {
        setError(null);
        try {
            const res = await fetch(
                `${API_BASE}/games/${encodeURIComponent(game.gameKey)}/export`,
                { credentials: "include" },
            );
            if (!res.ok) throw new Error(`Export failed with status ${res.status}`);
            const data = await res.json();
            const blob = new Blob([JSON.stringify(data, null, 2)], {
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

    return (
        <div className="border border-border rounded-lg p-3">
            <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                    <p className="text-sm font-medium flex items-center gap-2">
                        {game.name}
                        {isPrivate && <Badge variant="secondary">Private</Badge>}
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5 font-mono">
                        ID: {game.gameKey}
                    </p>
                    {error && <p className="text-xs text-destructive mt-1">{error}</p>}
                </div>
                <div className="flex flex-wrap justify-end gap-2 shrink-0">
                    {isPrivate && game.canManage && (
                        <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setShowLinks((v) => !v)}
                        >
                            {showLinks ? "Hide links" : "Links"}
                        </Button>
                    )}
                    {game.canManage && !isPrivate && (
                        <Button size="sm" variant="outline" onClick={() => setListing("unlisted")}>
                            Make private
                        </Button>
                    )}
                    {game.canManage && isPrivate && canList && (
                        <Button size="sm" variant="outline" onClick={() => setListing("listed")}>
                            Make public
                        </Button>
                    )}
                    <Button size="sm" variant="outline" onClick={handleExport}>
                        Export JSON
                    </Button>
                    {canDelete && (
                        <Button size="sm" variant="destructive" onClick={handleDelete}>
                            Delete
                        </Button>
                    )}
                </div>
            </div>
            {showLinks && <GameLinks game={game} />}
        </div>
    );
}

function ServerSection({ server }: { server: ServerWithPermissions }) {
    const hasAnyGamePerm = server.permissions.some((p) => MANAGE_PERMISSIONS.includes(p));
    const canImport = server.permissions.some((p) => IMPORT_PERMISSIONS.includes(p));
    const privateOnly =
        server.permissions.includes("games.create-unlisted") &&
        !server.permissions.some((p) => LIST_PERMISSIONS.includes(p));

    const [games, setGames] = useState<Game[] | null>(null);
    const [loading, setLoading] = useState(true);

    const loadGames = () =>
        fetch(`${API_BASE}/games?serverId=${encodeURIComponent(server.id)}&manage=true`, {
            credentials: "include",
        })
            .then(async (res) => {
                if (!res.ok) {
                    setGames([]);
                    return;
                }
                const data: GamesResponse = await res.json();
                setGames(data.games);
            })
            .catch(() => setGames([]))
            .finally(() => setLoading(false));

    useEffect(() => {
        loadGames();
    }, [server.id]);

    if (!hasAnyGamePerm) return null;

    return (
        <div className="mb-8">
            <h2 className="text-base font-semibold mb-1">{server.name}</h2>
            {privateOnly && (
                <p className="text-xs text-muted-foreground mb-3">
                    Games you import here are private: share them with game links.
                </p>
            )}

            {loading && <p className="text-sm text-muted-foreground">Loading…</p>}

            {games !== null && (
                <div className="space-y-2 mb-3 mt-3">
                    {games.length === 0 && (
                        <p className="text-sm text-muted-foreground italic">No games yet.</p>
                    )}
                    {games.map((g) => (
                        <GameCard
                            key={g.id}
                            game={g}
                            permissions={server.permissions}
                            onChanged={(updated) =>
                                setGames((prev) =>
                                    (prev ?? []).map((x) => (x.id === updated.id ? updated : x)),
                                )
                            }
                            onDeleted={(id) =>
                                setGames((prev) => (prev ?? []).filter((x) => x.id !== id))
                            }
                        />
                    ))}
                </div>
            )}

            {canImport && (
                <div className="flex gap-2">
                    <ImportGameDialog serverId={server.id} onImported={loadGames} />
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
        s.permissions.some((p) => MANAGE_PERMISSIONS.includes(p)),
    );
    const importableServers = servers.filter((s) =>
        s.permissions.some((p) => IMPORT_PERMISSIONS.includes(p)),
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
