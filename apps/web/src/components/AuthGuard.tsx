import type { MeResponse } from "@searchlight/shared";
import { HardDrive } from "lucide-react";
import { useEffect, useState } from "react";

import { clearStoredRevisions } from "@/game-definition/revisionCache";
import {
    clearActiveSession,
    offlineUserId,
    verifiedUserId,
} from "@/lib/activeSession";
import { watchAuth } from "@/lib/authCheck";
import { forgetGameViews } from "@/lib/gameView";
import { listLocalSessions } from "@/lib/localStore";
import {
    endOfflineAccess,
    lastUser,
    playOfflineWhileUnreachable,
    rememberUser,
} from "@/lib/offlineAccess";

import { StatusChip } from "./StatusChip";
import { UserChip } from "./UserChip";

const API_BASE = import.meta.env.PUBLIC_API_BASE as string;

export function AuthGuard() {
    const [user, setUser] = useState<MeResponse["user"] | null>(null);
    const [unreachable, setUnreachable] = useState(false);
    const [localCount, setLocalCount] = useState(0);

    useEffect(() => {
        if (user || !unreachable) return;
        let cancelled = false;
        try {
            void listLocalSessions()
                .then((localSessions) => {
                    if (!cancelled) setLocalCount(localSessions.length);
                })
                .catch(() => {});
        } catch {
            // Ignore IndexedDB errors so local lookup never interferes with offline auth fallback.
        }
        return () => {
            cancelled = true;
        };
    }, [user, unreachable]);

    useEffect(
        () =>
            watchAuth(`${API_BASE}/me`, {
                signedOut: () => {
                    const here = `${location.pathname}${location.search}${location.hash}`;
                    // The login is gone: so is offline play with it.
                    void endOfflineAccess().finally(() => {
                        window.location.href = `/?returnTo=${encodeURIComponent(here)}`;
                    });
                },
                // A slow connection or a deploy: keep the player here, and
                // don't leave them behind the loading spinner either. The
                // last account verified here (in the last week) goes on
                // playing what this browser kept for it until /me answers,
                // even past the week once it has started.
                unreachable: () => {
                    playOfflineWhileUnreachable();
                    setUnreachable(true);
                    document.getElementById("auth-loading-overlay")?.remove();
                },
                signedIn: (data) => {
                    // If a different user is now logged in (e.g. shared device, tab crash before logout),
                    // clear the previous user's game session so they don't inherit it.
                    const prevUser = lastUser();
                    if (prevUser && prevUser !== data.user.discordId) {
                        console.info(
                            "[searchlight] user changed",
                            prevUser,
                            "→",
                            data.user.discordId,
                            "— clearing active session",
                        );
                        clearActiveSession();
                        forgetGameViews();
                        void clearStoredRevisions();
                    }
                    rememberUser(data.user.discordId);
                    // Verified before the offline player is dropped, so the
                    // same account plays on without a gap.
                    verifiedUserId.set(data.user.discordId);
                    offlineUserId.set(null);

                    setUnreachable(false);
                    setUser(data.user);
                    document.getElementById("auth-loading-overlay")?.remove();
                },
            }),
        [],
    );

    if (user) return <UserChip user={user} apiBase={API_BASE} />;
    if (!unreachable) return null;
    return (
        <StatusChip slot="user">
            <div className="flex flex-col items-end gap-1">
                <div
                    role="status"
                    className="flex w-max items-center gap-1.5 rounded-full border border-destructive/50 bg-background/90 px-2.5 py-1 text-xs shadow-sm backdrop-blur-sm"
                >
                    <span className="h-2 w-2 animate-pulse rounded-full bg-destructive" />
                    <span className="text-muted-foreground">
                        Can&apos;t reach the server, retrying…
                    </span>
                </div>
                <a
                    href="/local"
                    className="flex w-max items-center gap-1.5 rounded-full border border-border bg-background/90 px-3 py-1.5 text-xs font-medium text-foreground shadow-sm backdrop-blur-sm transition-colors hover:bg-accent"
                >
                    <HardDrive
                        aria-hidden="true"
                        className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                    />
                    <span>
                        {localCount > 0
                            ? `Local sessions (${localCount})`
                            : "Local play"}
                    </span>
                </a>
            </div>
        </StatusChip>
    );
}
