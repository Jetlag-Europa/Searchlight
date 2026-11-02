import { useStore } from "@nanostores/react";
import type { MeResponse } from "@searchlight/shared";
import { useEffect, useRef } from "react";

import { verifiedUserId } from "@/lib/activeSession";
import { authRetryDelay } from "@/lib/authCheck";
import {
    applyPreferences,
    collectPreferences,
    PREF_ENTRIES,
    preferencesLoaded,
} from "@/lib/preferencesSync";

const API_BASE = import.meta.env.PUBLIC_API_BASE as string;

export function PreferencesSync() {
    const userId = useStore(verifiedUserId);
    const suppressSave = useRef(true);
    const pendingTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

    useEffect(() => {
        const doSave = (keepalive = false) => {
            clearTimeout(pendingTimer.current);
            pendingTimer.current = undefined;
            fetch(`${API_BASE}/me/preferences`, {
                method: "PATCH",
                credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(collectPreferences()),
                keepalive,
            }).catch((e) => console.warn("[searchlight:prefs] save failed", e));
        };

        const schedSave = () => {
            if (suppressSave.current) return;
            clearTimeout(pendingTimer.current);
            pendingTimer.current = setTimeout(() => doSave(), 500);
        };

        // Flush any pending save on page unload so a quick reload doesn't lose changes
        const onUnload = () => {
            if (pendingTimer.current !== undefined) doSave(true);
        };
        window.addEventListener("beforeunload", onUnload);
        window.addEventListener("pagehide", onUnload);

        // Listen for changes (fires on change only, not on initial subscribe)
        const unlisteners = PREF_ENTRIES.map(({ atom }) => atom.listen(schedSave));

        return () => {
            unlisteners.forEach((u) => u());
            clearTimeout(pendingTimer.current);
            window.removeEventListener("beforeunload", onUnload);
            window.removeEventListener("pagehide", onUnload);
        };
    }, []);

    // Load from server and apply, overriding whatever localStorage had. Wait
    // for AuthGuard's verified login, which waits out a server that's down,
    // and retry until it loads: saving before that would overwrite the
    // server's preferences with the local ones.
    useEffect(() => {
        if (!userId) return;
        let stopped = false;
        let failures = 0;
        let retryTimer: ReturnType<typeof setTimeout> | undefined;
        const load = () => {
            fetch(`${API_BASE}/me`, { credentials: "include" })
                .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
                .then(({ preferences }: MeResponse) => {
                    if (stopped) return;
                    if (preferences && Object.keys(preferences).length > 0) {
                        applyPreferences(preferences);
                        console.info(
                            "[searchlight:prefs] loaded from server",
                            preferences,
                        );
                    }
                    suppressSave.current = false;
                    preferencesLoaded.set(true);
                })
                .catch((e) => {
                    if (stopped) return;
                    console.warn("[searchlight:prefs] load failed", e);
                    retryTimer = setTimeout(load, authRetryDelay(++failures));
                });
        };
        load();
        return () => {
            stopped = true;
            clearTimeout(retryTimer);
        };
    }, [userId]);

    return null;
}
