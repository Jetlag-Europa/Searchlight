import { useEffect, useState } from "react";
import type { ServersResponse, ServerWithPermissions, GamesResponse, Game } from "@taibled/shared";
import { Button } from "@/components/ui/button";

const API_BASE = import.meta.env.PUBLIC_API_BASE as string;

function GameCard({
    game,
    permissions,
    onDeleted,
}: {
    game: Game;
    permissions: string[];
    onDeleted: (id: string) => void;
}) {
    const [editing, setEditing] = useState(false);
    const [editName, setEditName] = useState(game.name);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const canEdit = permissions.includes("games.edit");
    const canDelete = permissions.includes("games.delete");

    const handleSave = async () => {
        if (!editName.trim() || editName === game.name) { setEditing(false); return; }
        setSaving(true);
        setError(null);
        try {
            const res = await fetch(`${API_BASE}/games/${game.id}`, {
                method: "PATCH",
                credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name: editName.trim() }),
            });
            if (!res.ok) throw new Error(`${res.status}`);
            setEditing(false);
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

    return (
        <div className="border border-border rounded-lg p-3 flex items-center justify-between gap-3">
            <div className="min-w-0">
                {editing ? (
                    <input
                        autoFocus
                        type="text"
                        className="border border-input rounded-md px-2 py-1 text-sm bg-background w-full"
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") handleSave(); if (e.key === "Escape") setEditing(false); }}
                    />
                ) : (
                    <p className="text-sm font-medium">{game.name}</p>
                )}
                <p className="text-xs text-muted-foreground mt-0.5">{game.kmlPath}</p>
                {error && <p className="text-xs text-destructive mt-1">{error}</p>}
            </div>
            <div className="flex gap-2 shrink-0">
                {canEdit && !editing && (
                    <Button size="sm" variant="outline" onClick={() => setEditing(true)}>Edit</Button>
                )}
                {editing && (
                    <>
                        <Button size="sm" onClick={handleSave} disabled={saving}>{saving ? "…" : "Save"}</Button>
                        <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
                    </>
                )}
                {canDelete && !editing && (
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

    const [games, setGames] = useState<Game[] | null>(null);
    const [loading, setLoading] = useState(true);
    const [showCreateForm, setShowCreateForm] = useState(false);
    const [newName, setNewName] = useState("");
    const [newKmlPath, setNewKmlPath] = useState("");
    const [newSentinelValue, setNewSentinelValue] = useState("");
    const [creating, setCreating] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        fetch(`${API_BASE}/games?serverId=${server.id}`, { credentials: "include" })
            .then(async (res) => {
                if (!res.ok) { setGames([]); return; }
                const data: GamesResponse = await res.json();
                setGames(data.games);
            })
            .catch(() => setGames([]))
            .finally(() => setLoading(false));
    }, [server.id]);

    const handleCreate = async () => {
        if (!newName.trim() || !newKmlPath.trim() || !newSentinelValue.trim()) return;
        setCreating(true);
        setError(null);
        try {
            const res = await fetch(`${API_BASE}/games`, {
                method: "POST",
                credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    serverId: server.id,
                    name: newName.trim(),
                    sentinelValue: newSentinelValue.trim(),
                    kmlPath: newKmlPath.trim(),
                    mapLocationJson: {},
                    hidingRadius: 1,
                    hidingRadiusUnits: "kilometers",
                }),
            });
            if (!res.ok) throw new Error(`${res.status}`);
            const created: Game = await res.json();
            setGames((prev) => [...(prev ?? []), created]);
            setShowCreateForm(false);
            setNewName("");
            setNewKmlPath("");
            setNewSentinelValue("");
        } catch (e: unknown) {
            setError(`Failed to create game: ${(e as Error).message}`);
        } finally {
            setCreating(false);
        }
    };

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
                        />
                    ))}
                </div>
            )}

            {canCreate && !showCreateForm && (
                <Button variant="outline" size="sm" onClick={() => setShowCreateForm(true)}>
                    + New game
                </Button>
            )}

            {showCreateForm && (
                <div className="border border-border rounded-lg p-4 space-y-3 mt-2">
                    <p className="text-sm font-medium">New game</p>
                    <div className="grid gap-2">
                        <div>
                            <label className="text-xs text-muted-foreground block mb-1">Name</label>
                            <input type="text" placeholder="e.g. Luxembourg 2027" className="w-full border border-input rounded-md px-3 py-1.5 text-sm bg-background" value={newName} onChange={(e) => setNewName(e.target.value)} />
                        </div>
                        <div>
                            <label className="text-xs text-muted-foreground block mb-1">KML path (relative to public/)</label>
                            <input type="text" placeholder="e.g. my-game.kml" className="w-full border border-input rounded-md px-3 py-1.5 text-sm bg-background" value={newKmlPath} onChange={(e) => setNewKmlPath(e.target.value)} />
                        </div>
                        <div>
                            <label className="text-xs text-muted-foreground block mb-1">Sentinel value (unique ID for the zone selector)</label>
                            <input type="text" placeholder="e.g. __my-game-2027__" className="w-full border border-input rounded-md px-3 py-1.5 text-sm bg-background" value={newSentinelValue} onChange={(e) => setNewSentinelValue(e.target.value)} />
                        </div>
                    </div>
                    {error && <p className="text-xs text-destructive">{error}</p>}
                    <div className="flex gap-2">
                        <Button size="sm" onClick={handleCreate} disabled={creating || !newName.trim()}>
                            {creating ? "Creating…" : "Create"}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setShowCreateForm(false)}>Cancel</Button>
                    </div>
                </div>
            )}
        </div>
    );
}

export function GameManager() {
    const [servers, setServers] = useState<ServerWithPermissions[] | null>(null);
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

    if (adminServers.length === 0) {
        return <p className="text-muted-foreground">You don't have game management permissions in any server.</p>;
    }

    return (
        <div>
            {adminServers.map((s) => (
                <ServerSection key={s.id} server={s} />
            ))}
        </div>
    );
}
