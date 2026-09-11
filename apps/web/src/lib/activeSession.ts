import { atom } from "nanostores";
import type { GameSessionSummary } from "@taibled/shared";

const SS_KEY = "taibled-active-session";
// Durable mirror of SS_KEY. sessionStorage dies with the tab, and a phone
// discards backgrounded tabs aggressively — lock the screen, walk to the next
// location, reopen, and the pointer saying which session you were in is gone.
// The session's actual contents (strokes, questions, pending events) live in
// localStorage and survive, so without this the cache is intact but orphaned and
// the picker appears as if the session never existed.
const LS_KEY = "taibled-last-session";

// Storage throws in some privacy modes rather than returning null, and a throw
// here runs at module scope — it would take the whole app down. Every access is
// guarded.
function read(store: Storage | undefined, key: string): string {
    try {
        return store?.getItem(key) ?? "";
    } catch {
        return "";
    }
}

function write(store: Storage | undefined, key: string, value: string): void {
    try {
        store?.setItem(key, value);
    } catch {
        /* non-fatal: the session still works, it just won't be restored later */
    }
}

function remove(store: Storage | undefined, key: string): void {
    try {
        store?.removeItem(key);
    } catch {
        /* non-fatal */
    }
}

const ss = typeof sessionStorage !== "undefined" ? sessionStorage : undefined;
const ls = typeof localStorage !== "undefined" ? localStorage : undefined;

// Two-tier resolution, in priority order:
//   1. This tab's own pointer. A tab that has picked a session keeps it, so two
//      desktop tabs on different sessions stay independent exactly as before.
//   2. The last session used on this device. Only reached by a tab with no
//      pointer of its own — a cold start, or a tab the OS discarded.
// On falling back, the id is adopted into sessionStorage so the tab now owns it
// and stops depending on the shared value.
function initialSessionId(): string {
    const own = read(ss, SS_KEY);
    if (own) return own;

    const last = read(ls, LS_KEY);
    if (last) {
        write(ss, SS_KEY, last);
        console.info("[taibled:session] no tab pointer — adopting last session", last);
    }
    return last;
}

// Tab-local session ID, with a durable fallback (see initialSessionId).
export const activeSessionId = atom<string>(initialSessionId());

// Full session detail for the currently active session (in-memory only).
export const activeSessionData = atom<GameSessionSummary | null>(null);

export function setActiveSession(session: GameSessionSummary): void {
    write(ss, SS_KEY, session.id);
    write(ls, LS_KEY, session.id);
    activeSessionId.set(session.id);
    activeSessionData.set(session);
}

// Clears both tiers unconditionally. This is called on logout, on a user switch,
// and when a stored session turns out to be revoked or deleted — cases where
// leaving a durable pointer behind would be wrong. The cost is that a desktop
// user with two tabs on different sessions can have the other tab's durable
// pointer cleared; that tab keeps working from its own sessionStorage and only
// loses the auto-restore, which is the right side of this trade.
export function clearActiveSession(): void {
    remove(ss, SS_KEY);
    remove(ls, LS_KEY);
    activeSessionId.set("");
    activeSessionData.set(null);
}
