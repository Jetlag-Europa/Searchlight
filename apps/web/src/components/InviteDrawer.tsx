import { useStore } from "@nanostores/react";
import type {
    CreateLinkResponse,
    SessionLinksResponse,
    SessionLinkSummary,
    SessionRole,
} from "@searchlight/shared";
import { useCallback, useEffect, useRef, useState } from "react";

import {
    sessionLinkUrl,
    UncopiedLinkField,
    useCopyLink,
    withCreatedLinks,
} from "@/components/CopyLink";
import { Button } from "@/components/ui/button";
import {
    Drawer,
    DrawerContent,
    DrawerHeader,
    DrawerTitle,
    DrawerTrigger,
} from "@/components/ui/drawer";
import { activeSessionData } from "@/lib/activeSession";
import { SESSION_ROLE_CHANGED_EVENT } from "@/lib/sseManager";
import { cn } from "@/lib/utils";

const API_BASE = import.meta.env.PUBLIC_API_BASE as string;

// The links this drawer makes: "join" lets people edit the session, "view"
// lets them watch it.
type InviteLinkType = Extract<SessionLinkSummary["linkType"], "join" | "view">;

// Someone in the session, as GET /sessions/:id lists them.
interface SessionParticipant {
    userId: string;
    displayName: string;
    role: SessionRole;
}

const ROLE_LABELS: Record<SessionRole, string> = {
    creator: "Creator",
    member: "Member",
    viewer: "Spectator",
};

async function errorMessage(res: Response): Promise<string> {
    const body = await res.json().catch(() => null) as { message?: string } | null;
    return body?.message ?? `Request failed (${res.status})`;
}

// The server marks a session shared when its creator makes a join or view link.
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
    const [creatingLinkType, setCreatingLinkType] = useState<InviteLinkType | null>(null);
    const [revokingLinkId, setRevokingLinkId] = useState<string | null>(null);
    const { copiedId: copiedLinkId, uncopiedUrl, setUncopiedUrl, copyLink } = useCopyLink();
    // Links created since the list started loading.
    const createdLinkIds = useRef(new Set<string>());

    const [participants, setParticipants] = useState<SessionParticipant[]>([]);
    const [changingRoleOf, setChangingRoleOf] = useState<string | null>(null);

    const fetchLinks = useCallback(async () => {
        if (!session || !isCreator) return;
        setLoadingLinks(true);
        createdLinkIds.current.clear();
        try {
            const res = await fetch(`${API_BASE}/sessions/${session.id}/links`, {
                credentials: "include",
            });
            if (!res.ok) return;
            const data: SessionLinksResponse = await res.json();
            const loaded = data.links.filter((l) => l.linkType === "join" || l.linkType === "view");
            setLinks((prev) => withCreatedLinks(loaded, prev, createdLinkIds.current));
        } catch {
            // non-critical
        } finally {
            setLoadingLinks(false);
        }
    }, [session, isCreator]);

    const fetchParticipants = useCallback(async () => {
        if (!session || !isCreator) return;
        try {
            const res = await fetch(`${API_BASE}/sessions/${session.id}`, {
                credentials: "include",
            });
            if (!res.ok) return;
            const data = await res.json() as { participants?: SessionParticipant[] };
            // The board may have switched sessions meanwhile.
            if (activeSessionData.get()?.id !== session.id) return;
            setParticipants(data.participants ?? []);
        } catch {
            // non-critical
        }
    }, [session, isCreator]);

    // Another session's people must not show, or be changed, under this one.
    useEffect(() => setParticipants([]), [session?.id]);

    // Roles change from here or from another of the creator's tabs.
    useEffect(() => {
        if (!open) return;
        const refresh = () => void fetchParticipants();
        window.addEventListener(SESSION_ROLE_CHANGED_EVENT, refresh);
        return () => window.removeEventListener(SESSION_ROLE_CHANGED_EVENT, refresh);
    }, [open, fetchParticipants]);

    const handleCreateLink = async (linkType: InviteLinkType) => {
        if (!session) return;
        setCreatingLinkType(linkType);
        setSendError(null);
        try {
            const res = await fetch(`${API_BASE}/sessions/${session.id}/links`, {
                method: "POST",
                credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ linkType }),
            });
            if (!res.ok) {
                setSendError(await errorMessage(res));
                return;
            }
            markActiveSessionShared(session.id);
            const data: CreateLinkResponse = await res.json();
            // Listed right away, so its "Copied!" shows for the full 2 s.
            createdLinkIds.current.add(data.id);
            setLinks((prev) => [
                {
                    id: data.id,
                    token: data.token,
                    linkType,
                    createdAt: new Date().toISOString(),
                },
                ...prev,
            ]);
            await copyLink(data.id, sessionLinkUrl(data.token));
        } catch {
            setSendError("Could not create the link. Check your connection.");
        } finally {
            setCreatingLinkType(null);
        }
    };

    const handleRevokeLink = async (linkId: string, token: string) => {
        if (!session) return;
        setRevokingLinkId(linkId);
        setSendError(null);
        try {
            const res = await fetch(`${API_BASE}/sessions/${session.id}/links/${linkId}`, {
                method: "DELETE",
                credentials: "include",
            });
            // A 404 means it is already gone.
            if (!res.ok && res.status !== 404) {
                setSendError(await errorMessage(res));
                return;
            }
            setLinks((prev) => prev.filter((l) => l.id !== linkId));
            const url = sessionLinkUrl(token);
            setUncopiedUrl((u) => (u === url ? null : u));
        } catch {
            setSendError("Could not revoke the link. Check your connection.");
        } finally {
            setRevokingLinkId(null);
        }
    };

    // Their open boards reload with the new role (participant.role-changed).
    const handleChangeRole = async (userId: string, role: Exclude<SessionRole, "creator">) => {
        if (!session) return;
        setChangingRoleOf(userId);
        setSendError(null);
        try {
            const res = await fetch(`${API_BASE}/sessions/${session.id}/participants/${userId}`, {
                method: "PATCH",
                credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ role }),
            });
            if (res.status === 404) {
                // They left or were removed meanwhile.
                setParticipants((prev) => prev.filter((p) => p.userId !== userId));
                return;
            }
            if (!res.ok) {
                setSendError(await errorMessage(res));
                return;
            }
            setParticipants((prev) => prev.map((p) => (p.userId === userId ? { ...p, role } : p)));
        } catch {
            setSendError("Could not change their role. Check your connection.");
        } finally {
            setChangingRoleOf(null);
        }
    };

    // ── Drawer open/close ─────────────────────────────────────────────────────
    const handleOpenChange = (v: boolean) => {
        setOpen(v);
        setUncopiedUrl(null);
        if (v) {
            onOpen?.();
            fetchLinks();
            fetchParticipants();
        } else {
            setSendError(null);
        }
    };

    if (!isCreator) return null;

    const linkSection = (linkType: InviteLinkType) => {
        const sectionLinks = links.filter((l) => l.linkType === linkType);
        const isSpectatorLink = linkType === "view";
        const creating = creatingLinkType === linkType;
        // The link the clipboard refused, if it is one of these.
        const sectionUncopiedUrl = sectionLinks.some((l) => sessionLinkUrl(l.token) === uncopiedUrl)
            ? uncopiedUrl
            : null;
        return (
            <div className="space-y-3">
                <p className="text-sm font-medium">
                    {isSpectatorLink ? "Spectator link" : "Invite link"}
                </p>
                <p className="text-xs text-muted-foreground">
                    {isSpectatorLink
                        ? "Anyone with this link can watch the board live, but can’t change anything and doesn’t see the hider’s position."
                        : "Anyone with this link can join this session and edit it live with you."}
                </p>

                <Button
                    className="w-full"
                    variant={isSpectatorLink ? "outline" : "default"}
                    disabled={creatingLinkType !== null}
                    onClick={() => handleCreateLink(linkType)}
                >
                    {creating
                        ? "Creating…"
                        : isSpectatorLink
                          ? "Create spectator link"
                          : "Create invite link"}
                </Button>

                <UncopiedLinkField url={sectionUncopiedUrl} />

                {loadingLinks && sectionLinks.length === 0 && (
                    <p className="text-xs text-muted-foreground">Loading…</p>
                )}
                {sectionLinks.length > 0 && (
                    <div className="space-y-1.5">
                        <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">Active links</p>
                        {sectionLinks.map((l) => (
                            <div
                                key={l.id}
                                className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2"
                            >
                                <p className="text-xs text-muted-foreground truncate">
                                    <span className="font-medium text-foreground">
                                        {isSpectatorLink ? "Spectator link" : "Invite link"}
                                    </span>
                                    {" · "}Created {new Date(l.createdAt).toLocaleDateString()}
                                </p>
                                <div className="flex gap-1.5 shrink-0">
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        className="text-xs"
                                        onClick={() => copyLink(l.id, sessionLinkUrl(l.token))}
                                    >
                                        {copiedLinkId === l.id ? "Copied!" : "Copy"}
                                    </Button>
                                    <Button
                                        size="sm"
                                        variant="ghost"
                                        disabled={revokingLinkId === l.id}
                                        onClick={() => handleRevokeLink(l.id, l.token)}
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
        );
    };

    // Everyone but the creator, who is always in.
    const others = participants.filter((p) => p.role !== "creator");

    return (
        <Drawer open={open} onOpenChange={handleOpenChange}>
            <DrawerTrigger asChild>
                <Button className={cn(className)}>
                    Invite
                </Button>
            </DrawerTrigger>
            <DrawerContent aria-describedby={undefined}>
                <DrawerHeader>
                    <DrawerTitle>
                        Invite to <span className="text-muted-foreground font-normal">{session?.name}</span>
                    </DrawerTitle>
                </DrawerHeader>

                <div className="px-4 pb-6 max-h-[70vh] overflow-y-auto space-y-6">
                    {sendError && (
                        <p className="text-xs text-destructive">{sendError}</p>
                    )}

                    {linkSection("join")}
                    {linkSection("view")}

                    {others.length > 0 && (
                        <div className="space-y-1.5">
                            <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">In this session</p>
                            {others.map((p) => {
                                const nextRole = p.role === "viewer" ? "member" : "viewer";
                                return (
                                    <div
                                        key={p.userId}
                                        className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2"
                                    >
                                        <div className="min-w-0">
                                            <p className="text-sm truncate">{p.displayName}</p>
                                            <p className="text-xs text-muted-foreground">{ROLE_LABELS[p.role]}</p>
                                        </div>
                                        <Button
                                            size="sm"
                                            variant="outline"
                                            className="text-xs shrink-0"
                                            disabled={changingRoleOf === p.userId}
                                            onClick={() => handleChangeRole(p.userId, nextRole)}
                                        >
                                            {changingRoleOf === p.userId
                                                ? "…"
                                                : nextRole === "viewer"
                                                  ? "Make spectator"
                                                  : "Let them edit"}
                                        </Button>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>
            </DrawerContent>
        </Drawer>
    );
}
