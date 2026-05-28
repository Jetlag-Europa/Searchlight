import { useStore } from "@nanostores/react";
import { syncStatus, pendingEventCount } from "@/lib/context";

export function SyncIndicator() {
    const status = useStore(syncStatus);
    const pending = useStore(pendingEventCount);

    if (status === "synced") {
        return (
            <div
                className="fixed top-2 left-1/2 -translate-x-1/2 z-[1041] flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs bg-background/80 border border-border shadow-sm backdrop-blur-sm opacity-0 pointer-events-none"
                aria-hidden="true"
            />
        );
    }

    if (status === "syncing") {
        return (
            <div className="fixed top-2 left-1/2 -translate-x-1/2 z-[1041] flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs bg-background/90 border border-border shadow-sm backdrop-blur-sm">
                <span className="h-2 w-2 rounded-full bg-amber-400 animate-pulse" />
                <span className="text-muted-foreground">Syncing…</span>
            </div>
        );
    }

    // offline
    return (
        <div className="fixed top-2 left-1/2 -translate-x-1/2 z-[1041] flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs bg-background/90 border border-destructive/50 shadow-sm backdrop-blur-sm">
            <span className="h-2 w-2 rounded-full bg-destructive" />
            <span className="text-muted-foreground">
                Offline{pending > 0 ? ` · ${pending} pending` : ""}
            </span>
        </div>
    );
}
