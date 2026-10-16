import { useStore } from "@nanostores/react";
import type {
    CreateLinkResponse,
    InviteSummary,
    PendingInvitesResponse,
    SessionInviteDetail,
    SessionInvitesResponse,
    SessionLinksResponse,
    SessionLinkSummary,
    SessionParticipantsResponse,
    UserSearchResponse,
    UserSearchResult,
} from "@searchlight/shared";
import type { ForkAcceptResponse } from "@searchlight/shared";
import { useCallback,useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
    Drawer,
    DrawerContent,
    DrawerHeader,
    DrawerTitle,
    DrawerTrigger,
} from "@/components/ui/drawer";
import { activeSessionData } from "@/lib/activeSession";
import { pendingSessionLoad } from "@/lib/context";
import { cn } from "@/lib/utils";

const API_BASE = import.meta.env.PUBLIC_API_BASE as string;
const POLL_INTERVAL_MS = 30_000;

async function errorMessage(res: Response): Promise<string> {
    const body = await res.json().catch(() => null) as { message?: string } | null;
    return body?.message ?? `Request failed (${res.status})`;
}

// The server marks a session shared when its creator invites someone.
function markActiveSessionShared(sessionId: string) {
    const current = activeSessionData.get();
    if (current?.id === sessionId && current.visibility !== "shared") {
        activeSessionData.set({ ...current, visibility: "shared" });
    }
}

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

export function InviteDrawer({ className, onOpen }: { className?: string; onOpen?: () => void }) {
    const session = useStore(activeSessionData);
    const isCreator = session?.role === "creator";

    // ── Incoming invites (for this user) ─────────────────────────────────────
    const [invites, setInvites] = useState<InviteSummary[]>([]);
    const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const [actionLoading, setActionLoading] = useState(false);

    const fetchInvites = async () => {
        try {
            const res = await fetch(`${API_BASE}/sessions/pending-invites`, {
                credentials: "include",
            });
            if (!res.ok) return;
            const data: PendingInvitesResponse = await res.json();
            setInvites(data.invites);
        } catch {
            // non-critical
        }
    };

    useEffect(() => {
        fetchInvites();
        timerRef.current = setInterval(fetchInvites, POLL_INTERVAL_MS);
        return () => { if (timerRef.current) clearInterval(timerRef.current); };
    }, []);

    const [open, setOpen] = useState(false);

    const handleAccept = async (invite: InviteSummary) => {
        setActionLoading(true);
        try {
            const res = await fetch(`${API_BASE}/sessions/invites/${invite.id}/accept`, {
                method: "POST",
                credentials: "include",
            });
            if (res.ok) {
                setInvites((prev) => prev.filter((i) => i.id !== invite.id));
                setOpen(false);
                if (invite.inviteType === "fork") {
                    const { sessionId } = await res.json() as ForkAcceptResponse;
                    pendingSessionLoad.set(sessionId);
                } else {
                    pendingSessionLoad.set(invite.sessionId);
                }
            }
        } finally {
            setActionLoading(false);
        }
    };

    const handleDecline = async (inviteId: string) => {
        setActionLoading(true);
        try {
            const res = await fetch(`${API_BASE}/sessions/invites/${inviteId}/decline`, {
                method: "POST",
                credentials: "include",
            });
            if (res.ok) setInvites((prev) => prev.filter((i) => i.id !== inviteId));
        } finally {
            setActionLoading(false);
        }
    };

    const [activeTab, setActiveTab] = useState<"user" | "link">("user");

    // ── User tab ──────────────────────────────────────────────────────────────
    const [sentInvites, setSentInvites] = useState<SessionInviteDetail[]>([]);
    const [loadingSent, setLoadingSent] = useState(false);
    const [revokingId, setRevokingId] = useState<string | null>(null);

    const fetchSentInvites = useCallback(async () => {
        if (!session || !isCreator) return;
        setLoadingSent(true);
        try {
            const res = await fetch(`${API_BASE}/sessions/${session.id}/invites`, {
                credentials: "include",
            });
            if (!res.ok) return;
            const data: SessionInvitesResponse = await res.json();
            // Only show join invites here; fork invites are in ShareDrawer
            setSentInvites(data.invites.filter((i) => i.inviteType === "join"));
        } catch {
            // non-critical
        } finally {
            setLoadingSent(false);
        }
    }, [session, isCreator]);

    const handleRevoke = async (inviteId: string) => {
        if (!session) return;
        setRevokingId(inviteId);
        try {
            const res = await fetch(`${API_BASE}/sessions/${session.id}/invites/${inviteId}`, {
                method: "DELETE",
                credentials: "include",
            });
            if (res.ok) setSentInvites((prev) => prev.filter((i) => i.id !== inviteId));
        } finally {
            setRevokingId(null);
        }
    };

    const [query, setQuery] = useState("");
    const [searchResults, setSearchResults] = useState<UserSearchResult[]>([]);
    const [searching, setSearching] = useState(false);
    const [invitingId, setInvitingId] = useState<string | null>(null);
    const [sendError, setSendError] = useState<string | null>(null);
    const [memberIds, setMemberIds] = useState<Set<string>>(new Set());

    const fetchMembers = useCallback(async () => {
        if (!session || !isCreator) return;
        try {
            const res = await fetch(`${API_BASE}/sessions/${session.id}/participants`, {
                credentials: "include",
            });
            if (!res.ok) return;
            const data: SessionParticipantsResponse = await res.json();
            setMemberIds(new Set(
                data.participants.filter((p) => p.acceptedAt !== null).map((p) => p.userId),
            ));
        } catch {
            // non-critical
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
                const alreadyInvited = new Set(sentInvites.map((i) => i.invitedUserId));
                setSearchResults(data.users.filter(
                    (u) => !alreadyInvited.has(u.discordId) && !memberIds.has(u.discordId),
                ));
            } catch {
                // ignore
            } finally {
                setSearching(false);
            }
        }, 300);
        return () => clearTimeout(t);
    }, [query, session, isCreator, sentInvites, memberIds]);

    const handleInvite = async (invitedUser: UserSearchResult) => {
        if (!session) return;
        setInvitingId(invitedUser.discordId);
        setSendError(null);
        try {
            const res = await fetch(`${API_BASE}/sessions/${session.id}/invites`, {
                method: "POST",
                credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ invitedUserId: invitedUser.discordId, inviteType: "join" }),
            });
            if (!res.ok) {
                setSendError(await errorMessage(res));
                return;
            }
            markActiveSessionShared(session.id);
            setQuery("");
            setSearchResults([]);
            await fetchSentInvites();
        } catch {
            setSendError("Could not send the invite. Check your connection.");
        } finally {
            setInvitingId(null);
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
            fetchSentInvites();
            fetchMembers();
            fetchLinks();
        } else {
            setQuery("");
            setSearchResults([]);
            setSendError(null);
        }
    };

    const totalBadge = invites.length;

    return (
        <Drawer open={open} onOpenChange={handleOpenChange}>
            <DrawerTrigger asChild>
                <Button className={cn("relative", className)}>
                    Invites
                    {totalBadge > 0 && (
                        <span className="absolute -top-1.5 -right-1.5 h-4 w-4 flex items-center justify-center bg-destructive text-destructive-foreground text-[10px] font-bold rounded-full">
                            {totalBadge}
                        </span>
                    )}
                </Button>
            </DrawerTrigger>
            <DrawerContent aria-describedby={undefined}>
                <DrawerHeader>
                    <DrawerTitle>Invites</DrawerTitle>
                </DrawerHeader>

                <div className="px-4 pb-6 max-h-[70vh] overflow-y-auto">
                    {/* ── Send invite section (creator only) ── */}
                    {isCreator && session && (
                        <>
                            <p className="text-sm font-medium mb-3">
                                Invite to <span className="text-foreground">{session.name}</span>
                            </p>
                            <TabBar active={activeTab} onChange={(t) => { setActiveTab(t); setSendError(null); }} />

                            {sendError && (
                                <p className="text-xs text-destructive mb-3">{sendError}</p>
                            )}

                            {activeTab === "user" && (
                                <div className="space-y-3">
                                    <p className="text-xs text-muted-foreground">
                                        Invite someone to play this session with you. You both see and edit the same map live.
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
                                                        disabled={invitingId === u.discordId}
                                                        onClick={() => handleInvite(u)}
                                                    >
                                                        {invitingId === u.discordId ? "…" : "Invite"}
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
                                                        disabled={revokingId === inv.id}
                                                        onClick={() => handleRevoke(inv.id)}
                                                        className="text-muted-foreground hover:text-destructive shrink-0"
                                                    >
                                                        {revokingId === inv.id ? "…" : "Revoke"}
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
                            )}

                            <div className="border-t border-border mt-4 mb-4" />
                        </>
                    )}

                    {/* ── Incoming invites section ── */}
                    <div className="space-y-3">
                        {isCreator && (
                            <p className="text-sm font-medium text-muted-foreground">Incoming</p>
                        )}
                        {invites.length === 0 ? (
                            <p className="text-sm text-muted-foreground text-center py-4">
                                No pending invites.
                            </p>
                        ) : (
                            invites.map((invite) => (
                                <div
                                    key={invite.id}
                                    className="border border-border rounded-lg p-3 flex items-center justify-between gap-3"
                                >
                                    <div className="min-w-0">
                                        <p className="text-sm font-medium truncate">
                                            {invite.inviteType === "fork"
                                                ? `Private copy of ${invite.sessionName}`
                                                : invite.sessionName}
                                        </p>
                                        <p className="text-xs text-muted-foreground mt-0.5">
                                            {invite.gameName} · from {invite.invitedByDisplayName}
                                            {invite.inviteType === "fork" ? " · your own copy" : ""}
                                        </p>
                                    </div>
                                    <div className="flex gap-2 shrink-0">
                                        <Button
                                            size="sm"
                                            onClick={() => handleAccept(invite)}
                                            disabled={actionLoading}
                                        >
                                            {invite.inviteType === "fork" ? "Get copy" : "Accept"}
                                        </Button>
                                        <Button
                                            size="sm"
                                            variant="outline"
                                            onClick={() => handleDecline(invite.id)}
                                            disabled={actionLoading}
                                        >
                                            Decline
                                        </Button>
                                    </div>
                                </div>
                            ))
                        )}
                    </div>
                </div>
            </DrawerContent>
        </Drawer>
    );
}
