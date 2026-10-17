import type { MeResponse } from "@searchlight/shared";
import { useEffect, useState } from "react";

import { clearActiveSession, verifiedUserId } from "@/lib/activeSession";
import { authCheckOutcome, authRetryDelay } from "@/lib/authCheck";
import { forgetGameViews } from "@/lib/gameView";
import { readStorage, writeStorage } from "@/lib/safeStorage";

import { UserChip } from "./UserChip";

const API_BASE = import.meta.env.PUBLIC_API_BASE as string;
const STORED_USER_KEY = "taibled-authed-user";
const ME_TIMEOUT_MS = 8000;

export function AuthGuard() {
    const [user, setUser] = useState<MeResponse["user"] | null>(null);
    const [unreachable, setUnreachable] = useState(false);

    useEffect(() => {
        let stopped = false;
        let failures = 0;
        let controller: AbortController | undefined;
        let retryTimer: ReturnType<typeof setTimeout> | undefined;

        const check = async () => {
            clearTimeout(retryTimer);
            retryTimer = undefined;
            controller?.abort();
            const current = new AbortController();
            controller = current;
            const timeout = setTimeout(() => current.abort(), ME_TIMEOUT_MS);

            let status: number | undefined;
            let data: MeResponse | undefined;
            try {
                const res = await fetch(`${API_BASE}/me`, {
                    credentials: "include",
                    signal: current.signal,
                });
                if (res.ok) data = (await res.json()) as MeResponse;
                status = res.status;
            } catch (err) {
                // Also a timeout: the request was aborted.
                console.warn("[searchlight] /me failed:", err);
            } finally {
                clearTimeout(timeout);
            }
            if (stopped || controller !== current) return;

            const outcome = authCheckOutcome(status);
            if (outcome === "signed-out") {
                window.location.href = "/";
                return;
            }
            if (outcome === "unreachable" || !data) {
                // A slow connection or a deploy: keep the player here, and
                // don't leave them behind the loading spinner either.
                failures++;
                const delay = authRetryDelay(failures);
                console.warn(
                    "[searchlight] can't reach the server (" +
                        (status ?? "no response") +
                        "), checking /me again in",
                    delay,
                    "ms",
                );
                setUnreachable(true);
                document.getElementById("auth-loading-overlay")?.remove();
                retryTimer = setTimeout(() => void check(), delay);
                return;
            }

            // If a different user is now logged in (e.g. shared device, tab crash before logout),
            // clear the previous user's game session so they don't inherit it.
            const prevUser = readStorage("localStorage", STORED_USER_KEY);
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
            writeStorage("localStorage", STORED_USER_KEY, data.user.discordId);
            verifiedUserId.set(data.user.discordId);

            setUnreachable(false);
            setUser(data.user);
            document.getElementById("auth-loading-overlay")?.remove();
        };

        // Back online: check now instead of waiting out the backoff.
        const handleOnline = () => {
            if (retryTimer !== undefined) void check();
        };
        window.addEventListener("online", handleOnline);
        void check();
        return () => {
            stopped = true;
            controller?.abort();
            clearTimeout(retryTimer);
            window.removeEventListener("online", handleOnline);
        };
    }, []);

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
