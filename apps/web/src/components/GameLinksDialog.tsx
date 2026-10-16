import type { Game, GameLinksResponse,GameLinkSummary } from "@searchlight/shared";
import { useCallback, useState } from "react";

import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
} from "@/components/ui/dialog";

const API_BASE = import.meta.env.PUBLIC_API_BASE as string;

export function gameLinkUrl(token: string): string {
    return `${window.location.origin}/play?token=${token}`;
}

async function errorMessage(res: Response): Promise<string> {
    const data = (await res.json().catch(() => ({}))) as { message?: string };
    return data.message ?? `${res.status}`;
}

/** Create, copy and revoke the links that start sessions of a game. */
export function GameLinksDialog({ game }: { game: Game }) {
    const [open, setOpen] = useState(false);
    const [links, setLinks] = useState<GameLinkSummary[] | null>(null);
    const [creating, setCreating] = useState(false);
    const [revokingId, setRevokingId] = useState<string | null>(null);
    const [copiedId, setCopiedId] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    const linksUrl = `${API_BASE}/games/${encodeURIComponent(game.id)}/links`;

    const fetchLinks = useCallback(async () => {
        setError(null);
        try {
            const res = await fetch(linksUrl, { credentials: "include" });
            if (!res.ok) throw new Error(await errorMessage(res));
            const data: GameLinksResponse = await res.json();
            setLinks(data.links);
        } catch (e: unknown) {
            setError(`Failed to load links: ${(e as Error).message}`);
        }
    }, [linksUrl]);

    const copyLink = async (link: GameLinkSummary) => {
        await navigator.clipboard.writeText(gameLinkUrl(link.token)).catch(() => {});
        setCopiedId(link.id);
        setTimeout(() => setCopiedId((id) => (id === link.id ? null : id)), 2000);
    };

    const handleCreate = async () => {
        setCreating(true);
        setError(null);
        try {
            const res = await fetch(linksUrl, { method: "POST", credentials: "include" });
            if (!res.ok) throw new Error(await errorMessage(res));
            const link: GameLinkSummary = await res.json();
            setLinks((prev) => [link, ...(prev ?? [])]);
            await copyLink(link);
        } catch (e: unknown) {
            setError(`Failed to create link: ${(e as Error).message}`);
        } finally {
            setCreating(false);
        }
    };

    const handleRevoke = async (link: GameLinkSummary) => {
        if (!confirm("Revoke this link? It stops working for everyone who has it.")) return;
        setRevokingId(link.id);
        setError(null);
        try {
            const res = await fetch(`${linksUrl}/${link.id}`, {
                method: "DELETE",
                credentials: "include",
            });
            if (!res.ok && res.status !== 404) throw new Error(await errorMessage(res));
            setLinks((prev) => (prev ?? []).filter((l) => l.id !== link.id));
        } catch (e: unknown) {
            setError(`Failed to revoke link: ${(e as Error).message}`);
        } finally {
            setRevokingId(null);
        }
    };

    return (
        <Dialog
            open={open}
            onOpenChange={(v) => {
                setOpen(v);
                if (v) fetchLinks();
            }}
        >
            <DialogTrigger asChild>
                <Button size="sm" variant="outline">
                    Links
                </Button>
            </DialogTrigger>
            <DialogContent className="max-w-lg">
                <DialogHeader>
                    <DialogTitle>Links to {game.name}</DialogTitle>
                    <DialogDescription>
                        Anyone with a link can start their own sessions of this game, even if
                        it is unlisted or they aren’t in its server. A link works until you
                        revoke it; listing or unlisting the game doesn’t change it. Sessions
                        already started keep working after a revoke.
                    </DialogDescription>
                </DialogHeader>

                <div className="space-y-3">
                    <Button className="w-full" disabled={creating} onClick={handleCreate}>
                        {creating ? "Creating…" : "Create link (copies it)"}
                    </Button>

                    {error && (
                        <p className="text-sm text-destructive p-3 bg-destructive/10 rounded-md">
                            {error}
                        </p>
                    )}

                    {links === null && !error && (
                        <p className="text-xs text-muted-foreground">Loading…</p>
                    )}
                    {links !== null && links.length === 0 && (
                        <p className="text-xs text-muted-foreground italic">No active links.</p>
                    )}
                    {links !== null && links.length > 0 && (
                        <div className="space-y-1.5 max-h-72 overflow-y-auto">
                            <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">
                                Active links
                            </p>
                            {links.map((l) => (
                                <div
                                    key={l.id}
                                    className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2"
                                >
                                    <div className="min-w-0">
                                        <p className="text-xs font-mono truncate">
                                            …{l.token.slice(-8)}
                                        </p>
                                        <p className="text-xs text-muted-foreground truncate">
                                            {l.createdByDisplayName} ·{" "}
                                            {new Date(l.createdAt).toLocaleDateString()}
                                        </p>
                                    </div>
                                    <div className="flex gap-1.5 shrink-0">
                                        <Button
                                            size="sm"
                                            variant="outline"
                                            className="text-xs"
                                            onClick={() => copyLink(l)}
                                        >
                                            {copiedId === l.id ? "Copied!" : "Copy"}
                                        </Button>
                                        <Button
                                            size="sm"
                                            variant="ghost"
                                            disabled={revokingId === l.id}
                                            onClick={() => handleRevoke(l)}
                                            className="text-muted-foreground hover:text-destructive"
                                        >
                                            {revokingId === l.id ? "…" : "Revoke"}
                                        </Button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </DialogContent>
        </Dialog>
    );
}
