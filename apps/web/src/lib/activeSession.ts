import { atom } from "nanostores";
import type { GameSessionSummary } from "@taibled/shared";

const SS_KEY = "taibled-active-session";

// Tab-local session ID — sessionStorage so each tab tracks its own session
// independently. Survives reload within the tab; invisible to other tabs.
export const activeSessionId = atom<string>(
    typeof sessionStorage !== "undefined"
        ? (sessionStorage.getItem(SS_KEY) ?? "")
        : ""
);

// Full session detail for the currently active session (in-memory only).
export const activeSessionData = atom<GameSessionSummary | null>(null);

export function setActiveSession(session: GameSessionSummary): void {
    sessionStorage.setItem(SS_KEY, session.id);
    activeSessionId.set(session.id);
    activeSessionData.set(session);
}

export function clearActiveSession(): void {
    sessionStorage.removeItem(SS_KEY);
    activeSessionId.set("");
    activeSessionData.set(null);
}
