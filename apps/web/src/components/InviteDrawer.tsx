import { useStore } from "@nanostores/react";
import type {
    CreateLinkResponse,
    SessionLinksResponse,
    SessionLinkSummary,
} from "@searchlight/shared";
import { useCallback, useState } from "react";

import { Button } from "@/components/ui/button";
import {
    Drawer,
    DrawerContent,
    DrawerHeader,
    DrawerTitle,
    DrawerTrigger,
} from "@/components/ui/drawer";
import { activeSessionData } from "@/lib/activeSession";
import { cn } from "@/lib/utils";

const API_BASE = import.meta.env.PUBLIC_API_BASE as string;

async function errorMessage(res: Response): Promise<string> {
    const body = await res.json().catch(() => null) as { message?: string } | null;
    return body?.message ?? `Request failed (${res.status})`;
}

// The server marks a session shared when its creator makes a join link.
function markActiveSessionShared(sessionId: string) {
    const current = activeSessionData.get();
    if (current?.id === sessionId && current.visibility !== "shared") {
        activeSessionData.set({ ...current, visibility: "shared" });
    }
}

export function InviteDrawer({ className, onOpen }: { className?: string; onOpen?: () => void }) {
    const session = useStore(activeSessionData);
    const isCreator = session?.role === "creator";

    const [open, setOpen] = useState(false);
    const [sendError, setSendError] = useState<string | null>(null);

    const [links, setLinks] = useState<SessionLinkSummary[]>([]);
    const [loadingLinks, setLoadingLinks] = useState(false);
    const [creatingLink, setCreatingLink] = useState(false);
    const [revokingLinkId, setRevokingLinkId] = useState<string | null>(null);
    const [copiedLinkId, setCopiedLinkId] = useState<string | null>(null);

    const fetchLinks = useCallback(async () => {
        if (!session || !isCreator) return;
        setLoadingLinks(true);
        try {
            const res = await fetch(`${API_BASE}/sessions/${session.id}/links`, {
                credentials: "include",
            });
            if (!res.ok) return;
            const data: SessionLinksResponse = await res.json();
            setLinks(data.links.filter((l) => l.linkType === "join"));
        } catch {
            // non-critical
        } finally {
            setLoadingLinks(false);
        }
    }, [session, isCreator]);

    const handleCreateLink = async () => {
        if (!session) return;
        setCreatingLink(true);
        setSendError(null);
        try {
            const res = await fetch(`${API_BASE}/sessions/${session.id}/links`, {
                method: "POST",
                credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ linkType: "join" }),
            });
            if (!res.ok) {
                setSendError(await errorMessage(res));
                return;
            }
            markActiveSessionShared(session.id);
            const data: CreateLinkResponse = await res.json();
            const url = `${window.location.origin}/join?token=${data.token}`;
            await navigator.clipboard.writeText(url).catch(() => {});
            await fetchLinks();
            setCopiedLinkId(data.id);
            setTimeout(() => setCopiedLinkId(null), 2000);
        } catch {
            setSendError("Could not create the link. Check your connection.");
        } finally {
            setCreatingLink(false);
        }
    };

    const handleRevokeLink = async (linkId: string) => {
        if (!session) return;
        setRevokingLinkId(linkId);
        try {
            const res = await fetch(`${API_BASE}/sessions/${session.id}/links/${linkId}`, {
                method: "DELETE",
                credentials: "include",
            });
            if (res.ok) setLinks((prev) => prev.filter((l) => l.id !== linkId));
        } finally {
            setRevokingLinkId(null);
        }
    };

    const copyLink = async (token: string, linkId: string) => {
        const url = `${window.location.origin}/join?token=${token}`;
        await navigator.clipboard.writeText(url).catch(() => {});
        setCopiedLinkId(linkId);
        setTimeout(() => setCopiedLinkId(null), 2000);
    };

    // ── Drawer open/close ─────────────────────────────────────────────────────
    const handleOpenChange = (v: boolean) => {
        setOpen(v);
        if (v) {
            onOpen?.();
            fetchLinks();
        } else {
            setSendError(null);
        }
    };

    if (!isCreator) return null;

    return (
        <Drawer open={open} onOpenChange={handleOpenChange}>
            <DrawerTrigger asChild>
                <Button className={cn(className)}>
                    Invites
                </Button>
            </DrawerTrigger>
            <DrawerContent aria-describedby={undefined}>
                <DrawerHeader>
                    <DrawerTitle>
                        Invite to <span className="text-muted-foreground font-normal">{session?.name}</span>
                    </DrawerTitle>
                </DrawerHeader>

                <div className="px-4 pb-6 max-h-[70vh] overflow-y-auto">
                    {sendError && (
                        <p className="text-xs text-destructive mb-3">{sendError}</p>
                    )}

                    <div className="space-y-3">
                        <p className="text-xs text-muted-foreground">
                            Anyone with this link can join this session and edit it live with you.
                        </p>

                        <Button
                            className="w-full"
                            disabled={creatingLink}
                            onClick={handleCreateLink}
                        >
                            {creatingLink ? "Creating…" : "Create invite link"}
                        </Button>

                        {loadingLinks && links.length === 0 && (
                            <p className="text-xs text-muted-foreground">Loading…</p>
                        )}
                        {links.length > 0 && (
                            <div className="space-y-1.5">
                                <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">Active links</p>
                                {links.map((l) => (
                                    <div
                                        key={l.id}
                                        className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2"
                                    >
                                        <p className="text-xs text-muted-foreground truncate">
                                            Created {new Date(l.createdAt).toLocaleDateString()}
                                        </p>
                                        <div className="flex gap-1.5 shrink-0">
                                            <Button
                                                size="sm"
                                                variant="outline"
                                                className="text-xs"
                                                onClick={() => copyLink(l.token, l.id)}
                                            >
                                                {copiedLinkId === l.id ? "Copied!" : "Copy"}
                                            </Button>
                                            <Button
                                                size="sm"
                                                variant="ghost"
                                                disabled={revokingLinkId === l.id}
                                                onClick={() => handleRevokeLink(l.id)}
                                                className="text-muted-foreground hover:text-destructive"
                                            >
                                                {revokingLinkId === l.id ? "…" : "Revoke"}
                                            </Button>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </div>
            </DrawerContent>
        </Drawer>
    );
}
