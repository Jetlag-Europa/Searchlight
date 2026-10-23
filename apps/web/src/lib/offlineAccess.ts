import { clearStoredRevisions } from "@/game-definition/revisionCache";
import {
    offlineUserId,
    STORED_USER_KEY,
    verifiedUserId,
} from "@/lib/activeSession";
import { readStorage, removeStorage, writeStorage } from "@/lib/safeStorage";

// Offline play is for the account stored under STORED_USER_KEY. When its
// login ends (a 401) it no longer may, but the next account to log in must
// still be told apart from it, so it moves here.
export const PREVIOUS_USER_KEY = "taibled-previous-user";

/** The account this browser played as last, to compare a new login with. */
export function lastUser(): string | null {
    return (
        readStorage("localStorage", STORED_USER_KEY) ||
        readStorage("localStorage", PREVIOUS_USER_KEY) ||
        null
    );
}

/** `userId` is verified: it may play offline here next time. */
export function rememberUser(userId: string): void {
    writeStorage("localStorage", STORED_USER_KEY, userId);
    removeStorage("localStorage", PREVIOUS_USER_KEY);
}

/**
 * The stored account's login is gone (/me said 401): nothing it kept opens
 * offline any more, until it logs in again.
 */
export async function endOfflineAccess(): Promise<void> {
    const stored = readStorage("localStorage", STORED_USER_KEY);
    if (stored) writeStorage("localStorage", PREVIOUS_USER_KEY, stored);
    removeStorage("localStorage", STORED_USER_KEY);
    offlineUserId.set(null);
    await clearStoredRevisions();
}

/** Logging out: forget the account and the games it kept here. */
export async function forgetAccount(): Promise<void> {
    verifiedUserId.set(null);
    offlineUserId.set(null);
    removeStorage("localStorage", STORED_USER_KEY);
    removeStorage("localStorage", PREVIOUS_USER_KEY);
    await clearStoredRevisions();
}
