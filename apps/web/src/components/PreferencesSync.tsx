import type { MeResponse } from "@searchlight/shared";
import { useEffect, useRef } from "react";

import { applyPreferences, collectPreferences,PREF_ENTRIES } from "@/lib/preferencesSync";

const API_BASE = import.meta.env.PUBLIC_API_BASE as string;

export function PreferencesSync() {
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

        // Load from server and apply, overriding whatever localStorage had
        fetch(`${API_BASE}/me`, { credentials: "include" })
            .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
            .then(({ preferences }: MeResponse) => {
                if (!preferences || Object.keys(preferences).length === 0) return;
                applyPreferences(preferences);
                console.info("[searchlight:prefs] loaded from server", preferences);
            })
            .catch((e) => console.warn("[searchlight:prefs] load failed", e))
            .finally(() => {
                suppressSave.current = false;
            });

        return () => {
            unlisteners.forEach((u) => u());
            clearTimeout(pendingTimer.current);
            window.removeEventListener("beforeunload", onUnload);
            window.removeEventListener("pagehide", onUnload);
        };
    }, []);

    return null;
}
