import type { GameSessionSummary, SessionRole } from "@searchlight/shared";
import { atom, computed } from "nanostores";

import { readStorage, removeStorage, writeStorage } from "@/lib/safeStorage";

const SS_KEY = "taibled-active-session";
const LS_KEY = "taibled-last-session";

function initialSessionId(): string {
    const own = readStorage("sessionStorage", SS_KEY);
    if (own !== null) return own;

    const last = readStorage("localStorage", LS_KEY);
    // Adopt the fallback so later selections in other tabs cannot replace it.
    if (last) writeStorage("sessionStorage", SS_KEY, last);
    return last ?? "";
}

// Prefer this tab's selection; a discarded or new tab inherits the durable one.
export const activeSessionId = atom<string>(initialSessionId());

// Full session detail for the currently active session (in-memory only).
export const activeSessionData = atom<GameSessionSummary | null>(null);

// The active session's role: from the server, or while offline from the last
// time this browser loaded the session. Null when it isn't known.
export const activeSessionRole = atom<SessionRole | null>(null);

// Nothing on the board may be changed: its user only spectates the session.
// (A personal "view only" lock would join in here.)
export const sessionReadOnly = computed(
    activeSessionRole,
    (role) => role === "viewer",
);

/** Edits to `sessionId` must not be made, queued or sent from this board. */
export function isSessionReadOnly(sessionId: string): boolean {
    return sessionReadOnly.get() && sessionId === activeSessionId.get();
}

// Set only after /me verifies the current cookie. Persisted identity hints
// cannot authorize painting cached questions from a previous account.
export const verifiedUserId = atom<string | null>(null);

export function setActiveSession(session: GameSessionSummary): void {
    writeStorage("sessionStorage", SS_KEY, session.id);
    writeStorage("localStorage", LS_KEY, session.id);
    activeSessionRole.set(session.role);
    activeSessionId.set(session.id);
    activeSessionData.set(session);
}

export function clearActiveSession(): void {
    // An empty marker keeps this tab cleared even if another tab selects later.
    writeStorage("sessionStorage", SS_KEY, "");
    removeStorage("localStorage", LS_KEY);
    activeSessionRole.set(null);
    activeSessionId.set("");
    activeSessionData.set(null);
}
