import { clearStoredRevisions } from "@/game-definition/revisionCache";
import {
    offlineUserId,
    STORED_USER_KEY,
    verifiedUserId,
} from "@/lib/activeSession";
import { offlinePlayer } from "@/lib/authCheck";
import { readStorage, removeStorage, writeStorage } from "@/lib/safeStorage";

// Offline play is for the account stored under STORED_USER_KEY. When its
// login ends (a 401) it no longer may, but the next account to log in must
// still be told apart from it, so it moves here.
export const PREVIOUS_USER_KEY = "taibled-previous-user";
// When /me last verified the stored account, in ms since the epoch.
export const VERIFIED_AT_KEY = "taibled-authed-user-verified";
// How long after that it may still play offline. Past it, a shared device
// stops showing the last player's board (the hider's position included),
// as the login cookie may well have lapsed by then.
export const OFFLINE_ACCESS_MS = 7 * 24 * 60 * 60 * 1000;
// Set by the login links (inline scripts in index, play and join.astro, so
// the name is written out there too) as a login starts, to the time it
// started. Whoever logs in may be someone else, so the stored account
// mustn't play offline until /me says who it is: if that first check fails,
// the new player would get the last one's board, and their edits would queue
// as that account.
export const LOGIN_STARTED_KEY = "taibled-login-started";
// How long after it started a login counts. A Discord login is done well
// within it; one cancelled or failed (the API down for a deploy, say) is
// forgotten after it, rather than ending the stored account's offline play,
// and deleting its kept games, whenever /me next fails. A mark without a
// time, from an older build, has expired.
export const LOGIN_STARTED_MS = 15 * 60 * 1000;

function loginStarted(now: number): boolean {
    const startedAt = readStorage("localStorage", LOGIN_STARTED_KEY);
    if (startedAt === null) return false;
    if (Math.abs(now - Number(startedAt)) < LOGIN_STARTED_MS) return true;
    removeStorage("localStorage", LOGIN_STARTED_KEY);
    return false;
}

/** The account this browser played as last, to compare a new login with. */
export function lastUser(): string | null {
    return (
        readStorage("localStorage", STORED_USER_KEY) ||
        readStorage("localStorage", PREVIOUS_USER_KEY) ||
        null
    );
}

/** `userId` is verified: it may play offline here for a while. */
export function rememberUser(userId: string, now = Date.now()): void {
    writeStorage("localStorage", STORED_USER_KEY, userId);
    writeStorage("localStorage", VERIFIED_AT_KEY, String(now));
    removeStorage("localStorage", PREVIOUS_USER_KEY);
    removeStorage("localStorage", LOGIN_STARTED_KEY);
}

/**
 * The stored account, if it may still play offline: /me verified it less
 * than OFFLINE_ACCESS_MS ago, and no login started since (in the last
 * LOGIN_STARTED_MS). Otherwise its
 * offline access ends as with a 401. An account stored by an older build,
 * which kept no time, counts as verified now: its player may be mid-game on
 * a bad connection, and the clock starts here.
 */
export function offlineAccount(now = Date.now()): string | null {
    const stored = readStorage("localStorage", STORED_USER_KEY);
    if (!stored) return null;
    if (loginStarted(now)) {
        void endOfflineAccess();
        return null;
    }
    const verifiedAt = readStorage("localStorage", VERIFIED_AT_KEY);
    if (verifiedAt === null) {
        writeStorage("localStorage", VERIFIED_AT_KEY, String(now));
        return stored;
    }
    // A clock set wrong either way doesn't keep it open for good.
    if (Math.abs(now - Number(verifiedAt)) < OFFLINE_ACCESS_MS) return stored;
    void endOfflineAccess();
    return null;
}

/**
 * /me failed again: who plays on this page until it answers. The week and a
 * login started (in another tab, say) decide whether this page starts
 * playing offline, not when it stops: a player already doing so here keeps
 * their board and their edits keep queuing as them, however long the
 * connection stays bad. Ending it under them would leave a board that still
 * takes edits but saves none. /me answering ends it: verified, the account
 * plays online; a 401 logs out.
 */
export function playOfflineWhileUnreachable(now = Date.now()): string | null {
    const player = offlinePlayer(
        offlineUserId.get() ?? offlineAccount(now),
        verifiedUserId.get(),
    );
    offlineUserId.set(player);
    return player;
}

/**
 * The stored account's login is gone (/me said 401), or was last verified
 * too long ago: nothing it kept opens offline any more, until it logs in
 * again.
 */
export async function endOfflineAccess(): Promise<void> {
    const stored = readStorage("localStorage", STORED_USER_KEY);
    if (stored) writeStorage("localStorage", PREVIOUS_USER_KEY, stored);
    removeStorage("localStorage", STORED_USER_KEY);
    removeStorage("localStorage", VERIFIED_AT_KEY);
    offlineUserId.set(null);
    await clearStoredRevisions();
}

/** Logging out: forget the account and the games it kept here. */
export async function forgetAccount(): Promise<void> {
    verifiedUserId.set(null);
    offlineUserId.set(null);
    removeStorage("localStorage", STORED_USER_KEY);
    removeStorage("localStorage", VERIFIED_AT_KEY);
    removeStorage("localStorage", PREVIOUS_USER_KEY);
    removeStorage("localStorage", LOGIN_STARTED_KEY);
    await clearStoredRevisions();
}
