import { useEffect, useState } from "react";
import type { MeResponse } from "@taibled/shared";
import { clearActiveSession } from "@/lib/activeSession";
import { UserChip } from "./UserChip";

const API_BASE = import.meta.env.PUBLIC_API_BASE as string;
const STORED_USER_KEY = "taibled-authed-user";

export function AuthGuard() {
  const [user, setUser] = useState<MeResponse["user"] | null>(null);

  useEffect(() => {
    fetch(`${API_BASE}/me`, { credentials: "include" })
      .then(async (res) => {
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
        const prevUser = localStorage.getItem(STORED_USER_KEY);
        if (prevUser && prevUser !== data.user.discordId) {
          console.info("[taibled] user changed", prevUser, "→", data.user.discordId, "— clearing active session");
          clearActiveSession();
        }
        localStorage.setItem(STORED_USER_KEY, data.user.discordId);

        setUser(data.user);
        document.getElementById("auth-loading-overlay")?.remove();
      })
      .catch(() => {
        window.location.href = "/";
      });
  }, []);

  if (!user) return null;
  return <UserChip user={user} apiBase={API_BASE} />;
}
