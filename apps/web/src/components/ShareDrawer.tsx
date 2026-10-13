import { useStore } from "@nanostores/react";
import type {
    CreateLinkResponse,
    SessionInviteDetail,
    SessionInvitesResponse,
    SessionLinksResponse,
    SessionLinkSummary,
    UserSearchResponse,
    UserSearchResult,
} from "@searchlight/shared";
import { useCallback,useEffect, useState } from "react";

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

function TabBar({
    active,
    onChange,
}: {
    active: "user" | "link";
    onChange: (t: "user" | "link") => void;
}) {
    return (
        <div className="flex border-b border-border mb-4">
            {(["user", "link"] as const).map((t) => (
                <button
                    key={t}
                    onClick={() => onChange(t)}
                    className={cn(
                        "px-4 py-2 text-sm font-medium capitalize transition-colors",
                        active === t
                            ? "border-b-2 border-primary text-foreground"
                            : "text-muted-foreground hover:text-foreground",
                    )}
                >
                    {t === "user" ? "Send to user" : "Link"}
                </button>
            ))}
        </div>
    );
}

export function ShareDrawer({ className, onOpen }: { className?: string; onOpen?: () => void }) {
    const session = useStore(activeSessionData);
    const isCreator = session?.role === "creator";

    const [open, setOpen] = useState(false);
    const [activeTab, setActiveTab] = useState<"user" | "link">("user");

    // ── User tab ──────────────────────────────────────────────────────────────
    const [query, setQuery] = useState("");
    const [searchResults, setSearchResults] = useState<UserSearchResult[]>([]);
    const [searching, setSearching] = useState(false);
    const [sharingId, setSharingId] = useState<string | null>(null);
    const [sentInvites, setSentInvites] = useState<SessionInviteDetail[]>([]);
    const [loadingSent, setLoadingSent] = useState(false);
    const [revokingInviteId, setRevokingInviteId] = useState<string | null>(null);

    const fetchSentInvites = useCallback(async () => {
        if (!session || !isCreator) return;
        setLoadingSent(true);
        try {
            const res = await fetch(`${API_BASE}/sessions/${session.id}/invites`, {
                credentials: "include",
            });
            if (!res.ok) return;
            const data: SessionInvitesResponse = await res.json();
            // Only show fork invites in Share drawer
            setSentInvites(data.invites);
        } catch {
            // non-critical
        } finally {
            setLoadingSent(false);
        }
    }, [session, isCreator]);

    useEffect(() => {
        const q = query.trim();
        if (!q || !session || !isCreator) { setSearchResults([]); return; }
        const t = setTimeout(async () => {
            setSearching(true);
            try {
                const res = await fetch(
                    `${API_BASE}/users/search?serverId=${session.serverId}&q=${encodeURIComponent(q)}`,
                    { credentials: "include" },
                );
                if (!res.ok) return;
                const data: UserSearchResponse = await res.json();
                const alreadyShared = new Set(sentInvites.map((i) => i.invitedUserId));
                setSearchResults(data.users.filter((u) => !alreadyShared.has(u.discordId)));
            } catch {
                // ignore
            } finally {
                setSearching(false);
            }
        }, 300);
        return () => clearTimeout(t);
    }, [query, session, isCreator, sentInvites]);

    const handleShare = async (user: UserSearchResult) => {
        if (!session) return;
        setSharingId(user.discordId);
        try {
            const res = await fetch(`${API_BASE}/sessions/${session.id}/invites`, {
                method: "POST",
                credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ invitedUserId: user.discordId, inviteType: "fork" }),
            });
            if (res.ok) {
                setQuery("");
                setSearchResults([]);
                await fetchSentInvites();
            }
        } finally {
            setSharingId(null);
        }
    };

    const handleRevokeInvite = async (inviteId: string) => {
        if (!session) return;
        setRevokingInviteId(inviteId);
        try {
            const res = await fetch(`${API_BASE}/sessions/${session.id}/invites/${inviteId}`, {
                method: "DELETE",
                credentials: "include",
            });
            if (res.ok) setSentInvites((prev) => prev.filter((i) => i.id !== inviteId));
        } finally {
            setRevokingInviteId(null);
        }
    };

    // ── Link tab ──────────────────────────────────────────────────────────────
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
            setLinks(data.links.filter((l) => l.linkType === "fork"));
        } catch {
            // non-critical
        } finally {
            setLoadingLinks(false);
        }
    }, [session, isCreator]);

    const handleCreateLink = async () => {
        if (!session) return;
        setCreatingLink(true);
        try {
            const res = await fetch(`${API_BASE}/sessions/${session.id}/links`, {
                method: "POST",
                credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ linkType: "fork" }),
            });
            if (res.ok) {
                const data: CreateLinkResponse = await res.json();
                const url = `${window.location.origin}/join?token=${data.token}`;
                await navigator.clipboard.writeText(url).catch(() => {});
                await fetchLinks();
                setCopiedLinkId(data.id);
                setTimeout(() => setCopiedLinkId(null), 2000);
            }
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
            fetchSentInvites();
            fetchLinks();
        } else {
            setQuery("");
            setSearchResults([]);
        }
    };

    if (!isCreator) return null;

    return (
        <Drawer open={open} onOpenChange={handleOpenChange}>
            <DrawerTrigger asChild>
                <Button className={cn(className)}>
                    Share
                </Button>
            </DrawerTrigger>
            <DrawerContent aria-describedby={undefined}>
                <DrawerHeader>
                    <DrawerTitle>
                        Share <span className="text-muted-foreground font-normal">{session?.name}</span>
                    </DrawerTitle>
                </DrawerHeader>

                <div className="px-4 pb-6 max-h-[70vh] overflow-y-auto">
                    <TabBar active={activeTab} onChange={setActiveTab} />

                    {activeTab === "user" && (
                        <div className="space-y-3">
                            <p className="text-xs text-muted-foreground">
                                Send a personal copy of this session’s questions to a user. They get their own private snapshot.
                            </p>

                            <input
                                type="text"
                                placeholder="Search by name or username…"
                                className="w-full border border-input rounded-md px-3 py-1.5 text-sm bg-background"
                                value={query}
                                onChange={(e) => setQuery(e.target.value)}
                            />

                            {searching && <p className="text-xs text-muted-foreground">Searching…</p>}

                            {searchResults.length > 0 && (
                                <div className="space-y-1.5">
                                    {searchResults.map((u) => (
                                        <div
                                            key={u.discordId}
                                            className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2"
                                        >
                                            <div className="min-w-0">
                                                <p className="text-sm font-medium truncate">{u.displayName}</p>
                                                <p className="text-xs text-muted-foreground">@{u.username}</p>
                                            </div>
                                            <Button
                                                size="sm"
                                                disabled={sharingId === u.discordId}
                                                onClick={() => handleShare(u)}
                                            >
                                                {sharingId === u.discordId ? "…" : "Share"}
                                            </Button>
                                        </div>
                                    ))}
                                </div>
                            )}

                            {!searching && query.trim().length > 0 && searchResults.length === 0 && (
                                <p className="text-xs text-muted-foreground">No users found.</p>
                            )}

                            {loadingSent && sentInvites.length === 0 && (
                                <p className="text-xs text-muted-foreground">Loading…</p>
                            )}
                            {sentInvites.length > 0 && (
                                <div className="space-y-1.5">
                                    <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">Pending</p>
                                    {sentInvites.map((inv) => (
                                        <div
                                            key={inv.id}
                                            className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2"
                                        >
                                            <p className="text-sm truncate">{inv.invitedUserDisplayName}</p>
                                            <Button
                                                size="sm"
                                                variant="ghost"
                                                disabled={revokingInviteId === inv.id}
                                                onClick={() => handleRevokeInvite(inv.id)}
                                                className="text-muted-foreground hover:text-destructive shrink-0"
                                            >
                                                {revokingInviteId === inv.id ? "…" : "Revoke"}
                                            </Button>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}

                    {activeTab === "link" && (
                        <div className="space-y-3">
                            <p className="text-xs text-muted-foreground">
                                Anyone with this link gets their own private copy of your session’s questions.
                            </p>

                            <Button
                                className="w-full"
                                disabled={creatingLink}
                                onClick={handleCreateLink}
                            >
                                {creatingLink ? "Creating…" : "Create share link"}
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
                    )}
                </div>
            </DrawerContent>
        </Drawer>
    );
}
