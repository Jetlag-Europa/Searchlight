import { atom } from "nanostores";
import { persistentAtom } from "@nanostores/persistent";
import type { GameSessionSummary } from "@taibled/shared";

// Persisted session ID — survives page reload. Cleared when session is gone or invalid.
export const activeSessionId = persistentAtom<string>("taibled-active-session", "");

// Full session detail for the currently active session (in-memory only).
export const activeSessionData = atom<GameSessionSummary | null>(null);

export function setActiveSession(session: GameSessionSummary): void {
  activeSessionId.set(session.id);
  activeSessionData.set(session);
}

export function clearActiveSession(): void {
  activeSessionId.set("");
  activeSessionData.set(null);
}
