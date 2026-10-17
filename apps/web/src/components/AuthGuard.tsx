import type { MeResponse } from "@searchlight/shared";
import { useEffect, useState } from "react";

import { clearActiveSession, verifiedUserId } from "@/lib/activeSession";
import { forgetGameViews } from "@/lib/gameView";
import { readStorage, writeStorage } from "@/lib/safeStorage";

import { UserChip } from "./UserChip";

const API_BASE = import.meta.env.PUBLIC_API_BASE as string;
const STORED_USER_KEY = "taibled-authed-user";

export function AuthGuard() {
    const [user, setUser] = useState<MeResponse["user"] | null>(null);

    useEffect(() => {
        const controller = new AbortController();
        const timeout = setTimeout(() => {
            controller.abort();
            console.warn("[searchlight] /me timed out — redirecting to login");
            window.location.href = "/";
        }, 8000);

        fetch(`${API_BASE}/me`, {
            credentials: "include",
            signal: controller.signal,
        })
            .then(async (res) => {
                clearTimeout(timeout);
                if (res.status === 401) {
                    window.location.href = "/";
                    return;
                }
                if (!res.ok) {
                    window.location.href = "/";
                    return;
                }
                const data: MeResponse = await res.json();

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

                setUser(data.user);
                document.getElementById("auth-loading-overlay")?.remove();
            })
            .catch((err) => {
                clearTimeout(timeout);
                if ((err as Error).name !== "AbortError") {
                    window.location.href = "/";
                }
            });
    }, []);

    if (!user) return null;
    return <UserChip user={user} apiBase={API_BASE} />;
}
