import { persistentAtom } from "@nanostores/persistent";
import { atom } from "nanostores";

import { readStorage } from "@/lib/safeStorage";

// The @ alias only reaches into src/.
// eslint-disable-next-line import-alias/import-alias
import { version } from "../../package.json";

export const APP_VERSION = version;

// The notes of each release, docs/releases/<version>.md, bundled into the
// build but only loaded when they're shown.
const NOTES = Object.fromEntries(
    Object.entries(
        import.meta.glob<string>("../../../../docs/releases/[0-9]*.md", {
            query: "?raw",
            import: "default",
        }),
    ).flatMap(([path, load]) => {
        const name = path.match(/(\d+\.\d+\.\d+)\.md$/)?.[1];
        return name ? [[name, load] as const] : [];
    }),
);

// The release whose notes this player saw last, or "" for none. It follows
// the account through the server-side preferences.
export const lastSeenRelease = persistentAtom<string>("lastSeenRelease", "");

// Whether the notes of this release are showing; the map menu reopens them.
export const releaseNotesOpen = atom(false);

// Searchlight wrote these before it tracked releases, so a player who has
// them used the app before. Read when the page loads, before this load's
// login (and its session) writes them for a brand-new player.
const USED_BEFORE_KEYS = ["taibled-authed-user", "taibled-last-session"];
const usedBefore = USED_BEFORE_KEYS.some(
    (key) => readStorage("localStorage", key) !== null,
);

function parseVersion(v: string): [number, number, number] | null {
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
    return match ? [+match[1], +match[2], +match[3]] : null;
}

/**
 * The release whose notes cover `appVersion`: its major or minor release,
 * since patch releases only fix things and have no notes of their own.
 */
export function notesVersion(appVersion: string): string | null {
    const parsed = parseVersion(appVersion);
    return parsed ? `${parsed[0]}.${parsed[1]}.0` : null;
}

/** Whether `appVersion` is a major or minor release after `seen`. */
export function isNewerRelease(appVersion: string, seen: string): boolean {
    const current = parseVersion(appVersion);
    if (!current) return false;
    const last = parseVersion(seen);
    if (!last) return true;
    return current[0] !== last[0] ? current[0] > last[0] : current[1] > last[1];
}

/**
 * The notes to show a player once, or null. A brand-new player (nothing seen,
 * never used the app) starts on the current release and gets none.
 */
export function releaseNotesToShow(
    appVersion: string,
    seen: string,
    usedBefore: boolean,
    available: Iterable<string>,
): string | null {
    if (!seen && !usedBefore) return null;
    const notes = notesVersion(appVersion);
    if (!notes || ![...available].includes(notes)) return null;
    return isNewerRelease(appVersion, seen) ? notes : null;
}

/** The current release's notes, if it has any. */
export const currentNotesVersion = (() => {
    const notes = notesVersion(APP_VERSION);
    return notes && notes in NOTES ? notes : null;
})();

/**
 * Decide, once the player's preferences have loaded, whether this release's
 * notes are new to them. A brand-new player is marked as having seen it.
 */
export function checkReleaseNotes(): boolean {
    const seen = lastSeenRelease.get();
    if (!seen && !usedBefore) {
        lastSeenRelease.set(APP_VERSION);
        return false;
    }
    return (
        releaseNotesToShow(
            APP_VERSION,
            seen,
            usedBefore,
            Object.keys(NOTES),
        ) !== null
    );
}

export function markReleaseNotesSeen(): void {
    lastSeenRelease.set(APP_VERSION);
}

export function loadReleaseNotes(notes: string): Promise<string> {
    return NOTES[notes]();
}

/** How players know a release: "2.1" for 2.1.0. */
export function releaseName(notes: string): string {
    return notes.split(".").slice(0, 2).join(".");
}
