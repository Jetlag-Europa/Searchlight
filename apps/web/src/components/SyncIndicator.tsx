import { useStore } from "@nanostores/react";

import { connectedUsers,pendingEventCount, syncStatus } from "@/lib/context";

const MAX_AVATARS = 5;

// z-[1042]: on a phone the map's status chips reach the middle of the top
// edge; the sync status stays on top of them.
export function SyncIndicator() {
    const status = useStore(syncStatus);
    const pending = useStore(pendingEventCount);
    const users = useStore(connectedUsers);

    if (status === "synced") {
        return (
            <div
                className="fixed top-2 left-1/2 -translate-x-1/2 z-[1042] flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs bg-background/80 border border-border shadow-sm backdrop-blur-sm opacity-0 pointer-events-none"
                aria-hidden="true"
            />
        );
    }

    if (status === "live") {
        const visible = users.slice(0, MAX_AVATARS);
        const overflow = users.length - MAX_AVATARS;
        return (
            <div className="fixed top-2 left-1/2 -translate-x-1/2 z-[1042] flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs bg-background/90 border border-border shadow-sm backdrop-blur-sm">
                <span className="h-2 w-2 rounded-full bg-green-500" />
                <span className="text-muted-foreground">Live</span>
                {users.length > 0 && (
                    <>
                        <span className="w-px h-3 bg-border" />
                        <div className="flex -space-x-1.5">
                            {visible.map((u) => (
                                <img
                                    key={u.userId}
                                    src={u.avatarUrl}
                                    alt={u.displayName}
                                    title={u.displayName}
                                    className="h-4 w-4 rounded-full border border-background object-cover"
                                />
                            ))}
                        </div>
                        {overflow > 0 && (
                            <span className="text-muted-foreground">+{overflow}</span>
                        )}
                    </>
                )}
            </div>
        );
    }

    if (status === "syncing") {
        return (
            <div className="fixed top-2 left-1/2 -translate-x-1/2 z-[1042] flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs bg-background/90 border border-border shadow-sm backdrop-blur-sm">
                <span className="h-2 w-2 rounded-full bg-amber-400 animate-pulse" />
                <span className="text-muted-foreground">Syncing…</span>
            </div>
        );
    }

    // offline
    return (
        <div className="fixed top-2 left-1/2 -translate-x-1/2 z-[1042] flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs bg-background/90 border border-destructive/50 shadow-sm backdrop-blur-sm">
            <span className="h-2 w-2 rounded-full bg-destructive" />
            <span className="text-muted-foreground">
                Offline{pending > 0 ? ` · ${pending} pending` : ""}
            </span>
        </div>
    );
}
