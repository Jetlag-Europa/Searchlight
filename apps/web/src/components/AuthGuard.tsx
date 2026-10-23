import type { MeResponse } from "@searchlight/shared";
import { useEffect, useState } from "react";

import { clearStoredRevisions } from "@/game-definition/revisionCache";
import {
    clearActiveSession,
    offlineUserId,
    STORED_USER_KEY,
    verifiedUserId,
} from "@/lib/activeSession";
import { offlinePlayer, watchAuth } from "@/lib/authCheck";
import { forgetGameViews } from "@/lib/gameView";
import { readStorage, writeStorage } from "@/lib/safeStorage";

import { StatusChip } from "./StatusChip";
import { UserChip } from "./UserChip";

const API_BASE = import.meta.env.PUBLIC_API_BASE as string;

export function AuthGuard() {
    const [user, setUser] = useState<MeResponse["user"] | null>(null);
    const [unreachable, setUnreachable] = useState(false);

    useEffect(
        () =>
            watchAuth(`${API_BASE}/me`, {
                signedOut: () => {
                    const here = `${location.pathname}${location.search}${location.hash}`;
                    window.location.href = `/?returnTo=${encodeURIComponent(here)}`;
                },
                // A slow connection or a deploy: keep the player here, and
                // don't leave them behind the loading spinner either. The
                // last account verified here goes on playing what this
                // browser kept for it until /me answers.
                unreachable: () => {
                    offlineUserId.set(
                        offlinePlayer(
                            readStorage("localStorage", STORED_USER_KEY),
                            verifiedUserId.get(),
                        ),
                    );
                    setUnreachable(true);
                    document.getElementById("auth-loading-overlay")?.remove();
                },
                signedIn: (data) => {
                    // If a different user is now logged in (e.g. shared device, tab crash before logout),
                    // clear the previous user's game session so they don't inherit it.
                    const prevUser = readStorage(
                        "localStorage",
                        STORED_USER_KEY,
                    );
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
                    writeStorage(
                        "localStorage",
                        STORED_USER_KEY,
                        data.user.discordId,
                    );
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
            <div
                role="status"
                className="flex w-max items-center gap-1.5 rounded-full border border-destructive/50 bg-background/90 px-2.5 py-1 text-xs shadow-sm backdrop-blur-sm"
            >
                <span className="h-2 w-2 animate-pulse rounded-full bg-destructive" />
                <span className="text-muted-foreground">
                    Can&apos;t reach the server, retrying…
                </span>
            </div>
        </StatusChip>
    );
}
