// A question this device and another changed differently since both saw it
// is the player's to decide, not the merge's (see
// mergeQuestionListsWithConflicts). Nothing waits for the decision: the
// merged list is saved at once with the server's version, and the conflict
// is held here, in storage next to the queue and per account like it, until
// the player picks a side, edits the question, or the server's version comes
// round to theirs. Held conflicts aren't edits: they stay out of the queue,
// so sending, retrying and counting never see them.

import { atom, type ReadableAtom } from "nanostores";

import {
    compiledGameAtom,
    filterSupportedQuestions,
    isQuestionSupported,
} from "@/game-definition/store";
import {
    activeSessionId,
    offlineUserId,
    verifiedUserId,
} from "@/lib/activeSession";
import { gameDefinitionReady, questions } from "@/lib/context";
import {
    CONFLICTS_PREFIX,
    conflictsKey,
    evictOldCachedSessions,
    getCachedSession,
    onSessionDataDiscarded,
    patchBoardBaseQuestion,
    setCachedSession,
} from "@/lib/eventQueue";
import {
    type DetectedQuestionConflict,
    indexOfQuestionKey,
    keyBefore,
    mergeQuestionLists,
    mergeQuestionListsWithConflicts,
    placeQuestion,
    sameQuestionKey,
    sameQuestionList,
    sameQuestionSubstance,
    withDeviceFieldsOf,
} from "@/lib/questionMerge";
import { suppressQuestionSave } from "@/lib/questionSaveSuppress";
import type { QuestionsSaved } from "@/lib/syncManager";
import type { Questions } from "@/maps/schema";

const API_BASE = import.meta.env.PUBLIC_API_BASE as string;

type Question = Questions[number];

export type QuestionConflictKind =
    | "both-changed"
    | "they-deleted"
    | "we-deleted";

export interface QuestionConflictAuthor {
    userId: string;
    displayName: string;
    // This account, on another device.
    self: boolean;
}

export interface QuestionConflict {
    key: number;
    kind: QuestionConflictKind;
    // Null: we removed it.
    mine: Question | null;
    // Null: removed on the server.
    theirs: Question | null;
    // The version both sides started from.
    base: Question;
    // The key of the question before it in that side's list (null: it was
    // first), to put it back where it was. Undefined when that side doesn't
    // have it.
    mineAfterKey?: number | null;
    theirsAfterKey?: number | null;
    // The server's sequence both sides started from, and the one `theirs`
    // is as of.
    baseSequence: number;
    theirsSequence: number;
    // Who last changed it on the server since baseSequence. Undefined: not
    // looked up yet; null: couldn't tell (an older API).
    author?: QuestionConflictAuthor | null;
    // `theirs` changed again after it was first held.
    changedAgain?: boolean;
    detectedAt: number;
    // The save (its replacementId) whose merge held it.
    replacementId?: string;
}

const KINDS = new Set<unknown>(["both-changed", "they-deleted", "we-deleted"]);

function isConflict(value: unknown): value is QuestionConflict {
    if (!value || typeof value !== "object") return false;
    const c = value as Partial<QuestionConflict>;
    return (
        typeof c.key === "number" &&
        KINDS.has(c.kind) &&
        c.base !== undefined &&
        c.mine !== undefined &&
        c.theirs !== undefined &&
        typeof c.baseSequence === "number" &&
        typeof c.theirsSequence === "number" &&
        typeof c.detectedAt === "number"
    );
}

function readHeld(storageKey: string): QuestionConflict[] {
    try {
        const raw = localStorage.getItem(storageKey);
        if (!raw) return [];
        const parsed: unknown = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter(isConflict) : [];
    } catch {
        return [];
    }
}

// Throws when storage has no room even after dropping snapshots that can go.
function writeHeld(storageKey: string, held: QuestionConflict[]): void {
    if (held.length === 0) {
        localStorage.removeItem(storageKey);
        return;
    }
    const serialized = JSON.stringify(held);
    try {
        localStorage.setItem(storageKey, serialized);
    } catch {
        evictOldCachedSessions(0, activeSessionId.get() || undefined);
        localStorage.setItem(storageKey, serialized);
    }
}

function findByKey(list: readonly unknown[], key: number): Question | null {
    const at = indexOfQuestionKey(list, key);
    return at === -1 ? null : (list[at] as Question);
}

function boardGame() {
    return gameDefinitionReady.get() ? compiledGameAtom.get() : null;
}

// A question neither version of which the session's game supports any more
// (its revision was upgraded meanwhile) can't be shown on the board either
// way, so it isn't asked about. It stays held: deciding is moot, and it goes
// with the session's data, or when the server's list settles it.
function isShown(
    conflict: QuestionConflict,
    game: ReturnType<typeof boardGame>,
): boolean {
    if (!game) return true;
    return [conflict.mine, conflict.theirs].some(
        (q) => q !== null && isQuestionSupported(q, game),
    );
}

const $conflicts = atom<QuestionConflict[]>([]);
const $arrivals = atom(0);

/** The active session's conflicts for the current account, in board order. */
export const questionConflicts: ReadableAtom<QuestionConflict[]> = $conflicts;

/**
 * Bumped each time conflicts over questions not already held are recorded
 * for the active session in this page, or when the player gets to a session
 * that had them recorded in this page meanwhile (not for ones loaded from
 * storage).
 */
export const questionConflictArrivals: ReadableAtom<number> = $arrivals;

const $decisionsPossible = atom(false);

/**
 * Whether a decision can be taken now: the board shows the active session
 * and its edits are saved (not while a session loads, which replaces the
 * board, nor offline on a board not kept for this account). Deciding
 * otherwise does nothing. SessionManager sets it.
 */
export const questionDecisionsPossible: ReadableAtom<boolean> =
    $decisionsPossible;

export function setQuestionDecisionsPossible(possible: boolean): void {
    if ($decisionsPossible.get() !== possible) $decisionsPossible.set(possible);
}

/**
 * Whether that side's version can be kept: it's a removal, or the game the
 * board shows supports it. One it doesn't support can't be put on the board,
 * and keeping it would read as removing the question for everyone.
 */
export function isConflictVersionSupported(
    conflict: QuestionConflict,
    side: "mine" | "theirs",
): boolean {
    const version = side === "mine" ? conflict.mine : conflict.theirs;
    return version === null || isQuestionSupported(version, boardGame());
}

// New conflicts recorded in this page for a session while it wasn't the
// active one (by the flush of a session being opened, say), by storage key:
// they count as arriving once the player gets to it.
const unseen = new Map<string, number[]>();

function arriveUnseen(): void {
    const sessionId = activeSessionId.get();
    if (!sessionId) return;
    const storageKey = conflictsKey(sessionId);
    const keys = unseen.get(storageKey);
    if (!keys) return;
    unseen.delete(storageKey);
    const held = readHeld(storageKey);
    if (held.some((c) => keys.some((key) => sameQuestionKey(key, c.key)))) {
        $arrivals.set($arrivals.get() + 1);
    }
}

// Where it is on the board, or next to its neighbour there, else last.
function boardPosition(
    conflict: QuestionConflict,
    board: readonly unknown[],
): number {
    const at = indexOfQuestionKey(board, conflict.key);
    if (at !== -1) return at;
    for (const after of [conflict.mineAfterKey, conflict.theirsAfterKey]) {
        if (after === null) return -0.5;
        if (after === undefined) continue;
        const neighbour = indexOfQuestionKey(board, after);
        if (neighbour !== -1) return neighbour + 0.5;
    }
    return Number.MAX_SAFE_INTEGER;
}

let followingOtherTabs = false;

function refresh(): void {
    // Other tabs' changes to what is held show here too.
    if (
        !followingOtherTabs &&
        typeof window !== "undefined" &&
        typeof window.addEventListener === "function"
    ) {
        followingOtherTabs = true;
        window.addEventListener("storage", (event) => {
            const key = (event as StorageEvent).key;
            if (typeof key !== "string" || key.startsWith(CONFLICTS_PREFIX))
                refresh();
        });
    }
    const sessionId = activeSessionId.get();
    let shown: QuestionConflict[] = [];
    if (sessionId && typeof localStorage !== "undefined") {
        const game = boardGame();
        const board = questions.get();
        shown = readHeld(conflictsKey(sessionId))
            .filter((c) => isShown(c, game))
            .map((c) => ({ c, at: boardPosition(c, board) }))
            .sort(
                (a, b) =>
                    a.at - b.at ||
                    a.c.detectedAt - b.c.detectedAt ||
                    a.c.key - b.c.key,
            )
            .map(({ c }) => c);
    }
    if (JSON.stringify(shown) !== JSON.stringify($conflicts.get()))
        $conflicts.set(shown);
}

function refreshIfActive(sessionId: string): void {
    if (sessionId === activeSessionId.get()) refresh();
}

// Conflicts decided in this page, by session and account: see
// withResolvedConflictsSeen.
const resolutions = new Map<string, QuestionConflict[]>();
const MAX_RESOLUTIONS = 50;

function resolutionsKey(sessionId: string): string {
    return `${sessionId}\u0000${conflictsKey(sessionId)}`;
}

// What the atom shows follows the active session, the account and the game.
const followSession = () => {
    refresh();
    arriveUnseen();
};
activeSessionId.listen(followSession);
verifiedUserId.listen(followSession);
offlineUserId.listen(followSession);
gameDefinitionReady.listen(refresh);
compiledGameAtom.listen(refresh);

onSessionDataDiscarded((sessionId) => {
    for (const key of [...resolutions.keys()]) {
        if (key.startsWith(`${sessionId}\u0000`)) resolutions.delete(key);
    }
    refreshIfActive(sessionId);
});
refresh();

/**
 * Hold the conflicts a merge found (see mergeQuestionListsWithConflicts),
 * replacing any held for the same question. Called before the merged list
 * is sent, so they outlast the page however its save ends. Throws if they
 * can't be stored: the caller then saves our side instead, as before.
 */
export function recordQuestionConflicts(
    sessionId: string,
    detected: readonly DetectedQuestionConflict<Question>[],
    {
        baseSequence,
        theirsSequence,
        replacementId,
    }: { baseSequence: number; theirsSequence: number; replacementId?: string },
): void {
    if (detected.length === 0) return;
    const storageKey = conflictsKey(sessionId);
    const held = readHeld(storageKey);
    const detectedAt = Date.now();
    const arrived: number[] = [];
    for (const merged of detected) {
        const found = asEditedSince(sessionId, merged);
        const at = held.findIndex((c) => sameQuestionKey(c.key, merged.key));
        const before = at === -1 ? undefined : held[at];
        if (!found) {
            // The player's edit since agrees with theirs, or undid ours.
            if (before) held.splice(at, 1);
            continue;
        }
        const record: QuestionConflict = {
            key: found.key,
            kind: found.kind,
            mine: found.mine,
            theirs: found.theirs,
            base: found.base,
            ...(found.mineAfterKey === undefined
                ? {}
                : { mineAfterKey: found.mineAfterKey }),
            ...(found.theirsAfterKey === undefined
                ? {}
                : { theirsAfterKey: found.theirsAfterKey }),
            baseSequence,
            theirsSequence,
            detectedAt,
            ...(replacementId === undefined ? {} : { replacementId }),
        };
        if (
            before &&
            (before.changedAgain ||
                !sameQuestionSubstance(before.theirs, found.theirs))
        ) {
            record.changedAgain = true;
        }
        if (before) {
            held[at] = record;
        } else {
            held.push(record);
            arrived.push(record.key);
        }
    }
    writeHeld(storageKey, held);
    if (sessionId === activeSessionId.get()) {
        refresh();
        if (arrived.length > 0) $arrivals.set($arrivals.get() + 1);
    } else if (arrived.length > 0) {
        unseen.set(storageKey, [...(unseen.get(storageKey) ?? []), ...arrived]);
    }
}

/**
 * A conflict the merge of a list found, as of the board now: if the player
 * edited that question on the board since the list was made (it was on its
 * way), the edit is ours, not the list's version. Null when that leaves no
 * conflict: the edit agrees with theirs, or takes ours back to what both
 * started from.
 */
function asEditedSince(
    sessionId: string,
    found: DetectedQuestionConflict<Question>,
): DetectedQuestionConflict<Question> | null {
    if (
        sessionId !== activeSessionId.get() ||
        lastBoard?.sessionId !== sessionId ||
        !touched.some((key) => sameQuestionKey(key, found.key))
    ) {
        return found;
    }
    const board = lastBoard.questions;
    const at = indexOfQuestionKey(board, found.key);
    const mine = at === -1 ? null : board[at];
    if (sameQuestionSubstance(mine, found.mine)) return found;
    if (
        sameQuestionSubstance(mine, found.theirs) ||
        sameQuestionSubstance(mine, found.base)
    ) {
        return null;
    }
    const edited: DetectedQuestionConflict<Question> = {
        ...found,
        kind:
            mine === null
                ? "we-deleted"
                : found.theirs === null
                  ? "they-deleted"
                  : "both-changed",
        mine,
    };
    delete edited.mineAfterKey;
    if (at !== -1) edited.mineAfterKey = keyBefore(board, at);
    return edited;
}

/**
 * The board has taken `serverList`, the server's list as of `sequence`, as
 * its base. Each conflict held as of an earlier list: if the server's
 * version now is ours, the sides agree and it goes; if it changed from the
 * `theirs` held, theirs is updated (and asked about anew).
 */
export function reconcileQuestionConflicts(
    sessionId: string,
    serverList: readonly unknown[],
    sequence: number,
): void {
    try {
        const storageKey = conflictsKey(sessionId);
        const held = readHeld(storageKey);
        let changed = false;
        const next: QuestionConflict[] = [];
        for (const conflict of held) {
            if (!(sequence > conflict.theirsSequence)) {
                next.push(conflict);
                continue;
            }
            const at = indexOfQuestionKey(serverList, conflict.key);
            const now = at === -1 ? null : (serverList[at] as Question);
            if (sameQuestionSubstance(now, conflict.mine)) {
                changed = true;
                continue;
            }
            if (sameQuestionSubstance(now, conflict.theirs)) {
                next.push(conflict);
                continue;
            }
            changed = true;
            const updated: QuestionConflict = {
                ...conflict,
                kind:
                    conflict.mine === null
                        ? "we-deleted"
                        : now === null
                          ? "they-deleted"
                          : "both-changed",
                theirs: now,
                theirsSequence: sequence,
                changedAgain: true,
            };
            // Someone else changed it since: look them up again.
            delete updated.author;
            delete updated.theirsAfterKey;
            if (now !== null)
                updated.theirsAfterKey = keyBefore(serverList, at);
            next.push(updated);
        }
        if (!changed) return;
        writeHeld(storageKey, next);
        refreshIfActive(sessionId);
    } catch (err) {
        console.warn(
            "[searchlight:conflicts] couldn't reconcile held conflicts:",
            err,
        );
    }
}

// The board as last seen by trackBoardQuestions, to tell what an edit
// changed. A copy: cards edit questions in place before publishing.
let lastBoard: { sessionId: string; questions: Question[] } | undefined;
// Keys of the questions on that board as the player last edited them (not
// as the server, a load or a decision last set them).
let touched: number[] = [];

// Keys whose question is added, removed or changed in substance between
// the two lists.
function changedKeys(
    before: readonly Question[],
    after: readonly Question[],
): number[] {
    const keys: number[] = [];
    for (const question of [...before, ...after]) {
        const key = (question as { key?: unknown } | null)?.key;
        if (
            typeof key !== "number" ||
            keys.some((k) => sameQuestionKey(k, key))
        )
            continue;
        if (
            !sameQuestionSubstance(
                findByKey(before, key),
                findByKey(after, key),
            )
        ) {
            keys.push(key);
        }
    }
    return keys;
}

/**
 * Follow the board. `edited`: the player changed it (a set that schedules a
 * save, not one from the server or a load). Any held question whose
 * substance that edit changed, or that it added or removed, is decided by
 * it, so its conflict goes. Folding or locking one decides nothing.
 */
export function trackBoardQuestions(
    sessionId: string,
    board: readonly Question[],
    edited: boolean,
): void {
    const before =
        lastBoard?.sessionId === sessionId ? lastBoard.questions : undefined;
    lastBoard = sessionId
        ? {
              sessionId,
              questions: JSON.parse(JSON.stringify(board)) as Question[],
          }
        : undefined;
    if (!before) {
        touched = [];
        return;
    }
    const changed = changedKeys(before, board);
    if (changed.length === 0) return;
    touched = edited
        ? [
              ...touched.filter(
                  (k) => !changed.some((c) => sameQuestionKey(c, k)),
              ),
              ...changed,
          ]
        : touched.filter((k) => !changed.some((c) => sameQuestionKey(c, k)));
    if (!edited) return;
    try {
        const storageKey = conflictsKey(sessionId);
        const held = readHeld(storageKey);
        const kept = held.filter((c) =>
            sameQuestionSubstance(
                findByKey(before, c.key),
                findByKey(board, c.key),
            ),
        );
        if (kept.length === held.length) return;
        writeHeld(storageKey, kept);
        refreshIfActive(sessionId);
    } catch (err) {
        console.warn(
            "[searchlight:conflicts] couldn't drop edited conflicts:",
            err,
        );
    }
}

/**
 * The list a save was made from (`local`), as the board stands once the
 * player has decided conflicts that save's merge held: having seen theirs.
 * Its answer may come after the decision (it was on its way, or queued),
 * and shows the merged list on top of the board three-way from `local`
 * (see SessionManager): without this, a board still showing ours, kept by
 * the decision, would read as unchanged and take theirs from the saved
 * list. Only that save's answer: any other is made from what the board
 * showed when it was queued.
 */
export function withResolvedConflictsSeen<Q>(
    sessionId: string,
    {
        local,
        saved,
        replacementId,
    }: { local: readonly Q[]; saved: readonly Q[]; replacementId?: string },
): Q[] {
    let seen = [...local];
    if (replacementId === undefined) return seen;
    for (const conflict of resolutions.get(resolutionsKey(sessionId)) ?? []) {
        if (conflict.replacementId !== replacementId) continue;
        const ours = findByKey(seen, conflict.key);
        if (
            sameQuestionSubstance(ours, conflict.mine) &&
            sameQuestionSubstance(
                findByKey(saved, conflict.key),
                conflict.theirs,
            ) &&
            !sameQuestionSubstance(conflict.mine, conflict.theirs)
        ) {
            const theirs =
                conflict.theirs && ours
                    ? withDeviceFieldsOf(conflict.theirs, ours)
                    : conflict.theirs;
            seen = placeQuestion(
                seen,
                conflict.key,
                theirs as Q | null,
                conflict.theirsAfterKey,
            );
        }
    }
    return seen;
}

/**
 * A question list saved here was merged with changes made elsewhere: show
 * them on the board, on top of anything edited since (SessionManager calls
 * this). A question the player changed on the board since the list was
 * queued, that the other side changed too, is held like any conflict: the
 * board shows theirs, and the player's edit is what "mine" keeps.
 * `saveScheduled`: an edit is waiting to be queued, holding the board as it
 * was, so the list shown must replace it.
 */
export function showMergedSave(
    {
        sessionId,
        local,
        saved,
        madeFrom,
        sequence,
        mergedWith,
        replacementId,
    }: QuestionsSaved,
    { saveScheduled }: { saveScheduled: boolean },
): void {
    if (!mergedWith || sequence === undefined) return;
    const cached = getCachedSession(sessionId);
    // A later list (another player's, after ours) already shows on the
    // board, our save in it: nothing to add.
    if ((cached?.serverQuestions?.sequence ?? -1) >= sequence) return;
    // The saved list has the server's version of each question held for a
    // decision, which may settle some.
    reconcileQuestionConflicts(sessionId, saved, sequence);
    // One the player has decided since counts as seen on the board.
    const shown = withResolvedConflictsSeen(sessionId, {
        local,
        saved,
        replacementId,
    });
    const current = questions.get();
    const result = mergeQuestionListsWithConflicts(shown, current, saved);
    const { conflicts } = result;
    let { merged } = result;
    if (conflicts.length > 0) {
        try {
            recordQuestionConflicts(
                sessionId,
                conflicts.map((c) => ({
                    ...c,
                    base: findByKey(madeFrom?.questions ?? [], c.key) ?? c.base,
                })),
                {
                    baseSequence: madeFrom?.sequence ?? mergedWith.sequence,
                    theirsSequence: sequence,
                },
            );
        } catch (err) {
            console.warn(
                "[searchlight:conflicts] couldn't hold the conflicts, keeping ours:",
                err,
            );
            merged = mergeQuestionLists(shown, current, saved);
        }
    }
    const visible = filterSupportedQuestions(merged, boardGame()) as Questions;
    // The board is made from the saved list now: the next list queued has
    // it as its base. The snapshot keeps the two together, for an offline
    // restore.
    if (cached) {
        setCachedSession({
            ...cached,
            questions: visible,
            serverQuestions: { sequence, questions: saved },
        });
    }
    if (sameQuestionList(visible, current)) return;
    // Showing it isn't the player's edit.
    trackBoardQuestions(sessionId, visible, false);
    // Edited since, or an edit waiting to be queued: save the list shown.
    // Else the server has it.
    questions.set(
        sameQuestionList(current, shown) && !saveScheduled
            ? suppressQuestionSave(visible)
            : visible,
    );
}

// Where the chosen version goes when the board lacks it: after its
// neighbour on that side, else after the other side's, else first.
function neighbourOnBoard(
    board: readonly unknown[],
    ...candidates: Array<number | null | undefined>
): number | null {
    for (const after of candidates) {
        if (after === null) return null;
        if (after !== undefined && indexOfQuestionKey(board, after) !== -1)
            return after;
    }
    return null;
}

function resolve(
    sessionId: string,
    pick: (conflict: QuestionConflict) => boolean,
    choice: "mine" | "theirs",
): void {
    // Another tab may have decided some already.
    refresh();
    // The board is the active session's: only its conflicts are decided,
    // and only while the board's edits are saved.
    if (
        !sessionId ||
        sessionId !== activeSessionId.get() ||
        !$decisionsPossible.get()
    ) {
        return;
    }
    const storageKey = conflictsKey(sessionId);
    const held = readHeld(storageKey);
    const game = boardGame();
    const chosen = held.filter(
        (c) =>
            pick(c) &&
            isShown(c, game) &&
            isConflictVersionSupported(c, choice),
    );
    if (chosen.length === 0) return;
    try {
        writeHeld(
            storageKey,
            held.filter((c) => !chosen.includes(c)),
        );
    } catch (err) {
        // Nothing is decided then: they stay, to be decided again.
        console.warn(
            "[searchlight:conflicts] couldn't store the decision:",
            err,
        );
        return;
    }

    const current = questions.get();
    let board: Question[] = [...current];
    for (const conflict of chosen) {
        // The board has now seen their version: the next list queued is
        // made from it. Keeping ours is then our change, which the next
        // merge keeps, unless theirs changed yet again, which it holds again
        // and asks about. Keeping theirs changes nothing against it.
        patchBoardBaseQuestion(
            sessionId,
            conflict.key,
            conflict.theirs,
            conflict.theirsAfterKey,
        );
        const version = choice === "mine" ? conflict.mine : conflict.theirs;
        const at = indexOfQuestionKey(board, conflict.key);
        // Folded or locked here stays so.
        const shownVersion =
            version && at !== -1
                ? withDeviceFieldsOf(version, board[at])
                : version;
        const after =
            choice === "mine"
                ? neighbourOnBoard(
                      board,
                      conflict.mineAfterKey,
                      conflict.theirsAfterKey,
                  )
                : neighbourOnBoard(
                      board,
                      conflict.theirsAfterKey,
                      conflict.mineAfterKey,
                  );
        board = placeQuestion(board, conflict.key, shownVersion, after);
    }
    const key = resolutionsKey(sessionId);
    resolutions.set(
        key,
        [
            ...(resolutions.get(key) ?? []),
            ...chosen.filter((c) => c.replacementId),
        ].slice(-MAX_RESOLUTIONS),
    );
    refresh();

    const visible = filterSupportedQuestions(board, game) as Questions;
    // A board that already shows ours (the merged save isn't shown yet: its
    // list, queued or on its way, has theirs) is saved again all the same,
    // so ours replaces it. Set unsuppressed, the board saves as any edit.
    if (choice === "mine" || !sameQuestionList(visible, current)) {
        trackBoardQuestions(sessionId, visible, false);
        questions.set(visible);
    }
}

/** Decide one held conflict: keep our version, or theirs. */
export function resolveQuestionConflict(
    sessionId: string,
    key: number,
    choice: "mine" | "theirs",
): void {
    resolve(sessionId, (c) => sameQuestionKey(c.key, key), choice);
}

/** Decide every held conflict shown for the session the same way. */
export function resolveAllQuestionConflicts(
    sessionId: string,
    choice: "mine" | "theirs",
): void {
    resolve(sessionId, () => true, choice);
}

interface QuestionChange {
    sequence: number;
    userId: string;
    displayName: string;
    questions: unknown[];
}

function isChange(value: unknown): value is QuestionChange {
    if (!value || typeof value !== "object") return false;
    const c = value as Partial<QuestionChange>;
    return (
        typeof c.sequence === "number" &&
        typeof c.userId === "string" &&
        typeof c.displayName === "string" &&
        Array.isArray(c.questions)
    );
}

// Asked about at most at once, as the API takes.
const MAX_KEYS = 50;

// The session's question saves after `after` up to `until`, with only the
// given questions in them. Null: the API can't tell (an older one without
// the lookup, or it refused the request); throws when it may answer on
// another try (no connection, a server error, signed out for now).
async function fetchChanges(
    sessionId: string,
    keys: number[],
    after: number,
    until: number,
): Promise<QuestionChange[] | null> {
    const changes: QuestionChange[] = [];
    // A raw "+" (as in 1e+21) would read as a space.
    const keyList = encodeURIComponent(keys.map(String).join(","));
    let cursor = after;
    for (;;) {
        const res = await fetch(
            `${API_BASE}/sessions/${sessionId}/questions/changes?after=${cursor}&until=${until}&keys=${keyList}`,
            { credentials: "include" },
        );
        if (res.status === 404 || res.status === 400) return null;
        if (!res.ok) throw new Error(`questions/changes: ${res.status}`);
        const data = (await res.json().catch(() => null)) as {
            changes?: unknown;
            truncated?: unknown;
        } | null;
        if (!data || !Array.isArray(data.changes)) return null;
        const page = data.changes.filter(isChange);
        changes.push(...page);
        // Capped: the rest follows on from the last one returned.
        const last = page.at(-1)?.sequence;
        if (
            data.truncated !== true ||
            last === undefined ||
            last <= cursor ||
            last >= until
        ) {
            return changes;
        }
        cursor = last;
    }
}

// The last save between the two sides' sequences that changed the
// question's substance (or removed it), from what both started from.
function authorOf(
    conflict: QuestionConflict,
    changes: readonly QuestionChange[],
    self: string | null,
): QuestionConflictAuthor | null {
    let version: Question | null = conflict.base;
    let author: QuestionChange | undefined;
    for (const change of changes) {
        if (change.sequence <= conflict.baseSequence) continue;
        if (change.sequence > conflict.theirsSequence) break;
        const now = findByKey(change.questions, conflict.key);
        if (!sameQuestionSubstance(now, version)) {
            author = change;
            version = now;
        }
    }
    if (!author) return null;
    return {
        userId: author.userId,
        displayName: author.displayName,
        self: author.userId === self,
    };
}

// The lookup running for each storage key, and the one to run after it for
// conflicts held or changed meanwhile.
const lookups = new Map<
    string,
    { run: Promise<void>; again?: Promise<void> }
>();

async function lookUp(sessionId: string, storageKey: string): Promise<void> {
    const wanted = readHeld(storageKey).filter((c) => c.author === undefined);
    if (wanted.length === 0) return;
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;
    const self = verifiedUserId.get() ?? offlineUserId.get();
    const found = new Map<QuestionConflict, QuestionConflictAuthor | null>();
    for (let i = 0; i < wanted.length; i += MAX_KEYS) {
        const group = wanted.slice(i, i + MAX_KEYS);
        let changes: QuestionChange[] | null;
        try {
            changes = await fetchChanges(
                sessionId,
                group.map((c) => c.key),
                Math.min(...group.map((c) => c.baseSequence)),
                Math.max(...group.map((c) => c.theirsSequence)),
            );
        } catch {
            // Ask again next time.
            continue;
        }
        changes?.sort((a, b) => a.sequence - b.sequence);
        for (const conflict of group) {
            found.set(
                conflict,
                changes ? authorOf(conflict, changes, self) : null,
            );
        }
    }
    if (found.size === 0) return;
    // Held conflicts may have changed meanwhile: fill in only those still
    // as they were when looked up.
    const held = readHeld(storageKey);
    let changed = false;
    const next = held.map((conflict) => {
        if (conflict.author !== undefined) return conflict;
        for (const [asked, author] of found) {
            if (
                sameQuestionKey(asked.key, conflict.key) &&
                asked.theirsSequence === conflict.theirsSequence &&
                asked.detectedAt === conflict.detectedAt
            ) {
                changed = true;
                return { ...conflict, author };
            }
        }
        return conflict;
    });
    if (!changed) return;
    writeHeld(storageKey, next);
    if (conflictsKey(sessionId) === storageKey) refreshIfActive(sessionId);
}

/**
 * Fill in who changed each held question on the server, where not known
 * yet. Never throws; does nothing offline, and an API without the lookup
 * leaves it unknown (null). Other failures leave it to the next call.
 */
export function lookUpConflictAuthors(sessionId: string): Promise<void> {
    if (!sessionId || typeof localStorage === "undefined")
        return Promise.resolve();
    let storageKey: string;
    try {
        storageKey = conflictsKey(sessionId);
    } catch {
        return Promise.resolve();
    }
    const running = lookups.get(storageKey);
    if (running) {
        // It may have read them before they changed: once more after it.
        running.again ??= running.run.then(() =>
            lookUpConflictAuthors(sessionId),
        );
        return running.again;
    }
    const entry: { run: Promise<void>; again?: Promise<void> } = {
        run: lookUp(sessionId, storageKey)
            .catch((err) => {
                console.warn(
                    "[searchlight:conflicts] couldn't look up who changed them:",
                    err,
                );
            })
            .finally(() => {
                if (lookups.get(storageKey) === entry)
                    lookups.delete(storageKey);
            }),
    };
    lookups.set(storageKey, entry);
    return entry.run;
}
