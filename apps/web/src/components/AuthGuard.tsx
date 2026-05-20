import { useEffect, useState } from "react";
import type { MeResponse } from "@taibled/shared";
import { UserChip } from "./UserChip";

const API_BASE = import.meta.env.PUBLIC_API_BASE as string;

function wipeLocalStorageOnce() {
  if (localStorage.getItem("taibled-wiped") === "1") return;
  const toDelete: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)!;
    if (key.startsWith("jetlag-") || key.startsWith("annot-") || key === "current-game-id") {
      toDelete.push(key);
    }
  }
  toDelete.forEach((key) => localStorage.removeItem(key));
  localStorage.setItem("taibled-wiped", "1");
}

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
        wipeLocalStorageOnce();
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
