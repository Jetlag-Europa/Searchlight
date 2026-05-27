import { useEffect, useState, useRef } from "react";
import type { PendingInvitesResponse, InviteSummary } from "@taibled/shared";
import {
    Drawer,
    DrawerContent,
    DrawerHeader,
    DrawerTitle,
    DrawerTrigger,
} from "@/components/ui/drawer";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const API_BASE = import.meta.env.PUBLIC_API_BASE as string;
const POLL_INTERVAL_MS = 30_000;

export function InviteDrawer({ className, onOpen }: { className?: string; onOpen?: () => void }) {
    const [invites, setInvites] = useState<InviteSummary[]>([]);
    const [loading, setLoading] = useState(false);
    const [open, setOpen] = useState(false);
    const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

    const fetchInvites = async () => {
        try {
            const res = await fetch(`${API_BASE}/sessions/pending-invites`, {
                credentials: "include",
            });
            if (!res.ok) return;
            const data: PendingInvitesResponse = await res.json();
            setInvites(data.invites);
        } catch {
            // silently ignore — invite badge is non-critical
        }
    };

    useEffect(() => {
        fetchInvites();
        timerRef.current = setInterval(fetchInvites, POLL_INTERVAL_MS);
        return () => {
            if (timerRef.current) clearInterval(timerRef.current);
        };
    }, []);

    const handleAccept = async (inviteId: string) => {
        setLoading(true);
        try {
            const res = await fetch(`${API_BASE}/sessions/invites/${inviteId}/accept`, {
                method: "POST",
                credentials: "include",
            });
            if (res.ok) {
                setInvites((prev) => prev.filter((i) => i.id !== inviteId));
            }
        } finally {
            setLoading(false);
        }
    };

    const handleDecline = async (inviteId: string) => {
        setLoading(true);
        try {
            const res = await fetch(`${API_BASE}/sessions/invites/${inviteId}/decline`, {
                method: "POST",
                credentials: "include",
            });
            if (res.ok) {
                setInvites((prev) => prev.filter((i) => i.id !== inviteId));
            }
        } finally {
            setLoading(false);
        }
    };

    return (
        <Drawer open={open} onOpenChange={(v) => { setOpen(v); if (v) onOpen?.(); }}>
            <DrawerTrigger asChild>
                <Button
                    variant="outline"
                    size="sm"
                    className={cn("relative", className)}
                >
                    Invites
                    {invites.length > 0 && (
                        <span className="absolute -top-1.5 -right-1.5 h-4 w-4 flex items-center justify-center bg-destructive text-destructive-foreground text-[10px] font-bold rounded-full">
                            {invites.length}
                        </span>
                    )}
                </Button>
            </DrawerTrigger>
            <DrawerContent aria-describedby={undefined}>
                <DrawerHeader>
                    <DrawerTitle>Pending Invites</DrawerTitle>
                </DrawerHeader>
                <div className="px-4 pb-6 space-y-3 max-h-96 overflow-y-auto">
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
                                        disabled={loading}
                                    >
                                        Accept
                                    </Button>
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        onClick={() => handleDecline(invite.id)}
                                        disabled={loading}
                                    >
                                        Decline
                                    </Button>
                                </div>
                            </div>
                        ))
                    )}
                </div>
            </DrawerContent>
        </Drawer>
    );
}
