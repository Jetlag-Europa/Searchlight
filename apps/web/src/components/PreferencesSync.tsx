import { useStore } from "@nanostores/react";
import type { MeResponse, UserPreferences } from "@searchlight/shared";
import { useEffect, useRef } from "react";

import { verifiedUserId } from "@/lib/activeSession";
import { authRetryDelay } from "@/lib/authCheck";
import { applyPreferences, collectPreferences, PREF_ENTRIES } from "@/lib/preferencesSync";

const API_BASE = import.meta.env.PUBLIC_API_BASE as string;

export function PreferencesSync() {
  const userId = useStore(verifiedUserId);
  const suppressSave = useRef(true);
  const pendingTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Only what this device changed: the server merges it, so another device's
  // changes aren't undone by this one's stale values.
  const changed = useRef(new Set<keyof UserPreferences>());

  useEffect(() => {
    const doSave = (keepalive = false) => {
      clearTimeout(pendingTimer.current);
      pendingTimer.current = undefined;
      const keys = [...changed.current];
      changed.current.clear();
      fetch(`${API_BASE}/me/preferences`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(collectPreferences(keys)),
        keepalive,
      })
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
        })
        .catch((e) => {
          // The next save sends them again.
          for (const key of keys) changed.current.add(key);
          console.warn("[searchlight:prefs] save failed", e);
        });
    };

    const schedSave = (key: keyof UserPreferences) => {
      if (suppressSave.current) return;
      changed.current.add(key);
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
    const unlisteners = PREF_ENTRIES.map(({ key, atom }) => atom.listen(() => schedSave(key)));

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
            console.info("[searchlight:prefs] loaded from server", preferences);
          }
          suppressSave.current = false;
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
