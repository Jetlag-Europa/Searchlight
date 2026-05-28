import { useEffect, useState, useRef, useCallback } from "react";
import { useStore } from "@nanostores/react";
import type {
    PendingInvitesResponse,
    InviteSummary,
    SessionInviteDetail,
    SessionInvitesResponse,
    UserSearchResult,
    UserSearchResponse,
} from "@taibled/shared";
import {
    Drawer,
    DrawerContent,
    DrawerHeader,
    DrawerTitle,
    DrawerTrigger,
} from "@/components/ui/drawer";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { activeSessionData } from "@/lib/activeSession";

const API_BASE = import.meta.env.PUBLIC_API_BASE as string;
const POLL_INTERVAL_MS = 30_000;

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

    const handleAccept = async (inviteId: string) => {
        setActionLoading(true);
        try {
            const res = await fetch(`${API_BASE}/sessions/invites/${inviteId}/accept`, {
                method: "POST",
                credentials: "include",
            });
            if (res.ok) setInvites((prev) => prev.filter((i) => i.id !== inviteId));
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

    // ── Sent invites (creator view) ───────────────────────────────────────────
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
            setSentInvites(data.invites);
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

    // ── User search ───────────────────────────────────────────────────────────
    const [query, setQuery] = useState("");
    const [searchResults, setSearchResults] = useState<UserSearchResult[]>([]);
    const [searching, setSearching] = useState(false);
    const [invitingId, setInvitingId] = useState<string | null>(null);

    useEffect(() => {
        const q = query.trim();
        if (!q || !session || !isCreator) {
            setSearchResults([]);
            return;
        }
        const t = setTimeout(async () => {
            setSearching(true);
            try {
                const res = await fetch(
                    `${API_BASE}/users/search?serverId=${session.serverId}&q=${encodeURIComponent(q)}`,
                    { credentials: "include" },
                );
                if (!res.ok) return;
                const data: UserSearchResponse = await res.json();
                // Filter out users who already have a pending sent invite.
                const alreadyInvited = new Set(sentInvites.map((i) => i.invitedUserId));
                setSearchResults(data.users.filter((u) => !alreadyInvited.has(u.discordId)));
            } catch {
                // ignore
            } finally {
                setSearching(false);
            }
        }, 300);
        return () => clearTimeout(t);
    }, [query, session, isCreator, sentInvites]);

    const handleInvite = async (invitedUserId: string) => {
        if (!session) return;
        setInvitingId(invitedUserId);
        try {
            const res = await fetch(`${API_BASE}/sessions/${session.id}/invites`, {
                method: "POST",
                credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ invitedUserId }),
            });
            if (res.ok) {
                setQuery("");
                setSearchResults([]);
                await fetchSentInvites();
            }
        } finally {
            setInvitingId(null);
        }
    };

    // ── Drawer open/close ─────────────────────────────────────────────────────
    const [open, setOpen] = useState(false);

    const handleOpenChange = (v: boolean) => {
        setOpen(v);
        if (v) {
            onOpen?.();
            fetchSentInvites();
        } else {
            setQuery("");
            setSearchResults([]);
        }
    };

    const totalBadge = invites.length;

    return (
        <Drawer open={open} onOpenChange={handleOpenChange}>
            <DrawerTrigger asChild>
                <Button variant="outline" size="sm" className={cn("relative", className)}>
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

                <div className="px-4 pb-6 space-y-5 max-h-[70vh] overflow-y-auto">
                    {/* ── Send invite section (creator only) ── */}
                    {isCreator && session && (
                        <div className="space-y-3">
                            <p className="text-sm font-medium">
                                Invite to <span className="text-foreground">{session.name}</span>
                            </p>

                            <input
                                type="text"
                                placeholder="Search by name or username…"
                                className="w-full border border-input rounded-md px-3 py-1.5 text-sm bg-background"
                                value={query}
                                onChange={(e) => setQuery(e.target.value)}
                            />

                            {searching && (
                                <p className="text-xs text-muted-foreground">Searching…</p>
                            )}

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
                                                onClick={() => handleInvite(u.discordId)}
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

                            {/* Pending sent invites */}
                            {loadingSent && sentInvites.length === 0 && (
                                <p className="text-xs text-muted-foreground">Loading sent invites…</p>
                            )}
                            {sentInvites.length > 0 && (
                                <div className="space-y-1.5">
                                    <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">
                                        Pending
                                    </p>
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

                            <div className="border-t border-border" />
                        </div>
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
                                        <p className="text-sm font-medium truncate">{invite.sessionName}</p>
                                        <p className="text-xs text-muted-foreground mt-0.5">
                                            {invite.gameName} · from {invite.invitedByDisplayName}
                                        </p>
                                    </div>
                                    <div className="flex gap-2 shrink-0">
                                        <Button
                                            size="sm"
                                            onClick={() => handleAccept(invite.id)}
                                            disabled={actionLoading}
                                        >
                                            Accept
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
