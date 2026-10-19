import type { MeResponse } from "@searchlight/shared";
import { useEffect, useState } from "react";

import { clearActiveSession, verifiedUserId } from "@/lib/activeSession";
import { watchAuth } from "@/lib/authCheck";
import { forgetGameViews } from "@/lib/gameView";
import { readStorage, writeStorage } from "@/lib/safeStorage";

import { UserChip } from "./UserChip";

const API_BASE = import.meta.env.PUBLIC_API_BASE as string;
const STORED_USER_KEY = "taibled-authed-user";

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
                // don't leave them behind the loading spinner either.
                unreachable: () => {
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
                    }
                    writeStorage(
                        "localStorage",
                        STORED_USER_KEY,
                        data.user.discordId,
                    );
                    verifiedUserId.set(data.user.discordId);

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
        <div
            role="status"
            className="fixed top-2 right-14 z-[1041] flex items-center gap-1.5 rounded-full border border-destructive/50 bg-background/90 px-2.5 py-1 text-xs shadow-sm backdrop-blur-sm"
        >
            <span className="h-2 w-2 animate-pulse rounded-full bg-destructive" />
            <span className="text-muted-foreground">
                Can&apos;t reach the server, retrying…
            </span>
        </div>
    );
}
