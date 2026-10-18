import type { GameSessionSummary } from "@searchlight/shared";
import { atom } from "nanostores";

import { readStorage, removeStorage, writeStorage } from "@/lib/safeStorage";

const SS_KEY = "taibled-active-session";
/**
 * A session for the map page to open instead of the session picker, set by
 * pages that start one (/browse here; /join and /play use the same literal).
 */
export const PENDING_SESSION_KEY = "taibled-pending-link-session";
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

// Set only after /me verifies the current cookie. Persisted identity hints
// cannot authorize painting cached questions from a previous account.
export const verifiedUserId = atom<string | null>(null);

export function setActiveSession(session: GameSessionSummary): void {
    writeStorage("sessionStorage", SS_KEY, session.id);
    writeStorage("localStorage", LS_KEY, session.id);
    activeSessionId.set(session.id);
    activeSessionData.set(session);
}

export function clearActiveSession(): void {
    // An empty marker keeps this tab cleared even if another tab selects later.
    writeStorage("sessionStorage", SS_KEY, "");
    removeStorage("localStorage", LS_KEY);
    activeSessionId.set("");
    activeSessionData.set(null);
}
