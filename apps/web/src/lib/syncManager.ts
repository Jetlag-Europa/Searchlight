import type { StrokeFeature } from "@/annotations/types";
import {
    compiledGameAtom,
    filterSupportedQuestions,
} from "@/game-definition/store";
import {
    activeSessionId,
    offlineUserId,
    verifiedUserId,
} from "@/lib/activeSession";
import {
    gameDefinitionReady,
    pendingEventCount,
    questions,
    syncStatus,
} from "@/lib/context";
import {
    advanceBoardBase,
    baseQuestions,
    discardEvent,
    type EventType,
    getCachedSession,
    getPendingEvents,
    isReplacementEventType,
    markEventFailed,
    markEventSent,
    markEventSynced,
    type PendingEvent,
    type QuestionsBase,
    type QuestionsReplacePayload,
    rebaseQueuedQuestions,
    setCachedSession,
    updateQueuedPayload,
} from "@/lib/eventQueue";
import {
    lookUpConflictAuthors,
    questionHistory,
    reconcileQuestionConflicts,
    recordQuestionConflicts,
} from "@/lib/questionConflicts";
import {
    indexOfQuestionKey,
    mergeQuestionLists,
    mergeQuestionListsWithConflicts,
    ownVersionsOf,
    questionKey,
    sameQuestionKey,
    sameQuestionList,
    sameQuestionSubstance,
} from "@/lib/questionMerge";
import { randomUUID } from "@/lib/utils";
import type { Questions } from "@/maps/schema";

const API_BASE = import.meta.env.PUBLIC_API_BASE as string;

// Browsers reject keepalive requests once their bodies exceed 64 KiB in total.
// A larger body is sent normally: it is queued durably either way, and a
// hidden tab that is not unloaded can still deliver it.
const KEEPALIVE_BODY_LIMIT = 64 * 1024;

/** The server answered an edit with an error status. */
export class SyncRequestError extends Error {
    readonly status: number;

    constructor(type: EventType, status: number) {
        super(`${type} failed: ${status}`);
        this.status = status;
    }
}

export type SendFailure = "retry" | "unavailable" | "rejected";

/**
 * What a failed send means. A 403 or 404 means the session is gone or this
 * user lost access to it. Any other 4xx but 401, 408 and 429 refuses the edit
 * itself (too large, invalid, a conflict): resending it would fail again and
 * block the edits behind it, and incoming updates to its field, forever. A
 * network error (no status), a 5xx, 401, 408 or 429 may pass on a retry.
 */
export function classifySendFailure(status: number | undefined): SendFailure {
    if (status === undefined || status < 400 || status >= 500) return "retry";
    if (status === 401 || status === 408 || status === 429) return "retry";
    if (status === 403 || status === 404) return "unavailable";
    return "rejected";
}

/**
 * Played offline, edits wait for /me: until it verifies the account, the
 * browser's cookie may be another's. Throws a failure to retry.
 */
export function assertMaySend(): void {
    if (offlineUserId.get() && !verifiedUserId.get()) {
        throw new Error("waiting for /me before sending edits");
    }
}

function failureOf(err: unknown): { kind: SendFailure; status?: number } {
    const status = err instanceof SyncRequestError ? err.status : undefined;
    return { kind: classifySendFailure(status), status };
}

type RejectionListener = (event: PendingEvent, status: number) => void;
const rejectionListeners = new Set<RejectionListener>();

/**
 * Hear about edits the server refused for good. A rejected edit has already
 * left the queue, so the listener should show the server's state for its
 * field again. An edit to an unavailable session (403/404) stays queued.
 */
export function onEventRejected(listener: RejectionListener): () => void {
    rejectionListeners.add(listener);
    return () => {
        rejectionListeners.delete(listener);
    };
}

// The server refused a list made on an older base (see QuestionsBase).
const QUESTIONS_CHANGED = "QUESTIONS_CHANGED";
// Merges in a row before giving up for now: each one means yet another
// device saved in between.
const MAX_QUESTION_MERGES = 3;

/** A question list the server took, and what it was merged with. */
export interface QuestionsSaved {
    sessionId: string;
    // The list as queued here, and the one saved (the same unless merged).
    local: Questions;
    saved: Questions;
    // The base `local` was made from (undefined from builds before).
    madeFrom?: QuestionsBase;
    // The server's sequence after the save; undefined from an older API.
    sequence?: number;
    // When merged: the server's list it was last merged with.
    mergedWith?: QuestionsBase;
}

type QuestionsSavedListener = (saved: QuestionsSaved) => void;
const questionsSavedListeners = new Set<QuestionsSavedListener>();

/** Hear about each question list saved, to show a merged one. */
export function onQuestionsSaved(listener: QuestionsSavedListener): () => void {
    questionsSavedListeners.add(listener);
    return () => {
        questionsSavedListeners.delete(listener);
    };
}

// The server's own clientUuid for each question read from it, so a merged
// list saves the questions it keeps from there under their ids.
const serverClientUuids = new WeakMap<object, string>();

async function fetchServerQuestions(sessionId: string): Promise<QuestionsBase> {
    const res = await fetch(`${API_BASE}/sessions/${sessionId}/questions`, {
        credentials: "include",
    });
    if (!res.ok) throw new SyncRequestError("questions.replace", res.status);
    const data = (await res.json()) as {
        questions: Array<{ clientUuid?: string; payloadJson: Questions[number] }>;
        sequence?: number;
    };
    if (typeof data.sequence !== "number") {
        // An API without bases can't have refused one: don't merge.
        throw new Error("questions response has no sequence");
    }
    return {
        sequence: data.sequence,
        questions: data.questions.map((q) => {
            if (q.payloadJson && typeof q.payloadJson === "object" && q.clientUuid) {
                serverClientUuids.set(q.payloadJson, q.clientUuid);
            }
            return q.payloadJson;
        }),
    };
}

function toWire(questions: Questions): QuestionsReplacePayload["questions"] {
    const used = new Set<string>();
    return questions.map((payloadJson, ordinal) => {
        const own =
            payloadJson && typeof payloadJson === "object"
                ? serverClientUuids.get(payloadJson)
                : undefined;
        const clientUuid = own && !used.has(own) ? own : randomUUID();
        used.add(clientUuid);
        return { clientUuid, ordinal, payloadJson };
    });
}

/**
 * Merge a list made on an older base into the server's. A question both
 * sides changed differently is held for the player (see questionConflicts):
 * the merged list has the server's version of it for now. The held
 * conflicts are stored before anything is sent, so a page killed after the
 * save lands still has them. If they can't be, ours is saved, as before.
 */
async function mergeWithServer(
    event: PendingEvent,
    payload: QuestionsReplacePayload & { base: QuestionsBase },
    local: Questions,
    server: QuestionsBase,
    keepalive: boolean,
): Promise<Questions> {
    const { sessionId } = event;
    const { base } = payload;
    const own = Array.isArray(payload.own) ? payload.own : [];
    // What the list was made from, decisions taken on the board included.
    let from = baseQuestions(base);
    // A question of ours the base doesn't have, added by a list whose
    // answer never came: which of our versions of it landed (if any) is
    // what it was made from. When the server doesn't have it now, or has
    // another version and we have several, only the server's history tells
    // (see mergeQuestionListsWithConflicts for the rest), so ask it, but not
    // while the page may be going away (it can take seconds, and a pagehide
    // save waits behind it). Without an answer it stays as before.
    const hidden =
        typeof document !== "undefined" && document.visibilityState === "hidden";
    if (!keepalive && !hidden && own.length > 0) {
        const ownOf = (key: number) => ownVersionsOf(own, key);
        const asked: number[] = [];
        for (const question of [...local, ...server.questions]) {
            const key = questionKey(question);
            if (
                key === undefined ||
                asked.some((k) => sameQuestionKey(k, key)) ||
                indexOfQuestionKey(from, key) !== -1
            ) {
                continue;
            }
            const versions = ownOf(key);
            const at = indexOfQuestionKey(server.questions, key);
            const now = at === -1 ? null : server.questions[at];
            if (
                versions.length > 0 &&
                (now === null ||
                    (versions.length > 1 &&
                        !versions.some((v) => sameQuestionSubstance(v, now))))
            ) {
                asked.push(key);
            }
        }
        if (asked.length > 0) {
            // From the first base this list was made from: a list of ours
            // replaced since may have landed any time after it.
            const after = Math.min(
                base.sequence,
                base.since ?? base.sequence,
                payload.merged?.base.sequence ?? base.sequence,
            );
            const history = await questionHistory(
                sessionId,
                asked,
                after,
                server.sequence,
            );
            for (const key of asked) {
                const landed = history
                    ?.get(key)
                    ?.find(
                        (v) =>
                            v !== null &&
                            ownOf(key).some((o) => sameQuestionSubstance(o, v)),
                    );
                if (landed) from = [...from, landed];
            }
        }
    }
    // Conflicts held from earlier saves first: this list may settle them.
    reconcileQuestionConflicts(sessionId, server.questions, server.sequence);
    const { merged, conflicts } = mergeQuestionListsWithConflicts(
        from,
        local,
        server.questions,
        own,
    );
    if (conflicts.length === 0) return merged;
    try {
        recordQuestionConflicts(sessionId, conflicts, {
            baseSequence: base.since ?? base.sequence,
            theirsSequence: server.sequence,
            madeFrom: base,
        });
    } catch (err) {
        console.warn("[searchlight:sync] couldn't hold the conflicts, keeping ours:", err);
        return mergeQuestionLists(from, local, server.questions);
    }
    console.info(
        "[searchlight:sync] held",
        conflicts.length,
        "question(s) changed on both sides for the player to decide",
    );
    // Who changed them is only for showing: never in the save's way, and
    // not while the page goes away.
    if (!keepalive) void lookUpConflictAuthors(sessionId);
    return merged;
}

/**
 * Save a queued question list. Made on a base the server has moved on from,
 * it is merged with the server's list first: see mergeWithServer. Each
 * merge replaces the queued list before it is sent, keeping its
 * replacementId: if the merged save commits but its answer is lost, the
 * retry sends that same merged list, which the server recognizes as done.
 */
async function sendQuestions(
    event: PendingEvent,
    keepalive: boolean,
): Promise<QuestionsSaved> {
    const { sessionId } = event;
    let payload = event.payloadJson as QuestionsReplacePayload;
    const madeFrom = payload.merged?.base ?? payload.base;
    if (!event.sent) {
        try {
            markEventSent(sessionId, event.localId);
        } catch (err) {
            console.warn("[searchlight:sync] couldn't mark the list sent:", err);
        }
    }
    for (let merges = 0; ; merges++) {
        const baseSequence = payload.base?.sequence;
        const body = JSON.stringify({
            replacementId: payload.replacementId,
            questions: payload.questions,
            ...(baseSequence === undefined ? {} : { baseSequence }),
        });
        const res = await fetch(`${API_BASE}/sessions/${sessionId}/questions`, {
            method: "PUT",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body,
            keepalive: keepalive && new Blob([body]).size <= KEEPALIVE_BODY_LIMIT,
        });
        if (res.status === 409 && payload.base) {
            const code = await res
                .json()
                .then((data: { code?: unknown }) => data?.code)
                .catch(() => undefined);
            if (code === QUESTIONS_CHANGED) {
                // Not a refusal of the edit: retry it later if this keeps on.
                if (merges >= MAX_QUESTION_MERGES) {
                    throw new Error("questions kept changing, merging later");
                }
                const server = await fetchServerQuestions(sessionId);
                const list = payload.questions.map((q) => q.payloadJson);
                const merged = await mergeWithServer(
                    event,
                    { ...payload, base: payload.base },
                    list,
                    server,
                    keepalive,
                );
                console.info(
                    "[searchlight:sync] questions changed elsewhere, merged",
                    list.length,
                    "+",
                    server.questions.length,
                    "→",
                    merged.length,
                );
                payload = {
                    ...payload,
                    questions: toWire(merged),
                    base: server,
                    merged: payload.merged ?? { local: list, base: payload.base },
                };
                try {
                    updateQueuedPayload(sessionId, event.localId, payload);
                } catch (err) {
                    // Storage is full: send the merged list anyway. Only a
                    // lost answer to it can't be told apart from a new save.
                    console.warn("[searchlight:sync] couldn't queue the merged list:", err);
                }
                continue;
            }
        }
        if (!res.ok) throw new SyncRequestError("questions.replace", res.status);
        const sequence =
            res.status === 200
                ? await res
                      .json()
                      .then((data: { sequence?: unknown }) =>
                          typeof data?.sequence === "number"
                              ? data.sequence
                              : undefined,
                      )
                      .catch(() => undefined)
                : undefined;
        const saved = payload.questions.map((q) => q.payloadJson);
        return {
            sessionId,
            local: payload.merged?.local ?? saved,
            saved,
            madeFrom,
            sequence,
            mergedWith: payload.merged ? payload.base : undefined,
        };
    }
}

async function sendEvent(
    event: PendingEvent,
    keepalive: boolean,
): Promise<QuestionsSaved | undefined> {
    const { sessionId } = event;

    if (event.type === "stroke.create") {
        const stroke = event.payloadJson as StrokeFeature;
        const res = await fetch(`${API_BASE}/sessions/${sessionId}/strokes`, {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                clientUuid: stroke.properties.clientUuid,
                payloadJson: stroke,
            }),
        });
        if (!res.ok) throw new SyncRequestError("stroke.create", res.status);
    } else if (event.type === "stroke.delete") {
        const { clientUuid } = event.payloadJson as { clientUuid: string };
        const res = await fetch(`${API_BASE}/sessions/${sessionId}/strokes/${clientUuid}`, {
            method: "DELETE",
            credentials: "include",
        });
        if (!res.ok && res.status !== 404)
            throw new SyncRequestError("stroke.delete", res.status);
    } else if (event.type === "questions.replace") {
        return sendQuestions(event, keepalive);
    } else if (event.type === "hider.update") {
        const res = await fetch(`${API_BASE}/sessions/${sessionId}`, {
            method: "PATCH",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(event.payloadJson),
            keepalive,
        });
        if (!res.ok) throw new SyncRequestError("hider.update", res.status);
    } else if (event.type === "planning.toggle") {
        const res = await fetch(`${API_BASE}/sessions/${sessionId}`, {
            method: "PATCH",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(event.payloadJson),
            keepalive,
        });
        if (!res.ok) throw new SyncRequestError("planning.toggle", res.status);
    }
}

// Live saves and reconnect/unload replay share one dispatcher. A second caller
// must never resend an in-flight snapshot or overtake its acknowledgement.
const dispatches = new Map<string, Promise<void>>();

// A failed event keeps blocking incoming updates to its field until it syncs,
// so retry with capped backoff while its session stays active instead of
// waiting for the next `online` event. Other sessions flush when next loaded.
const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 30_000;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let retryDelay = RETRY_MIN_MS;

function hasUnsyncedEvents(sessionId: string): boolean {
    return getPendingEvents(sessionId).some((event) => event.status !== "synced");
}

/**
 * Record a failed send of `event`: keep it queued for a retry, or drop it if
 * the server rejected it. Returns whether it was dropped.
 */
export function recordSendFailure(event: PendingEvent, err: unknown): boolean {
    const { sessionId, localId } = event;
    const { kind, status } = failureOf(err);
    // A newer snapshot may have replaced it meanwhile; that one is sent next.
    const queued = getPendingEvents(sessionId).some(
        (candidate) => candidate.localId === localId,
    );
    if (kind === "rejected") {
        if (queued) discardEvent(sessionId, localId);
    } else {
        markEventFailed(sessionId, localId);
        scheduleRetry(sessionId);
    }
    if (kind !== "retry" && queued && status !== undefined) {
        for (const listener of rejectionListeners) listener(event, status);
    }
    return kind === "rejected";
}

function cancelRetry(): void {
    clearTimeout(retryTimer);
    retryTimer = undefined;
    retryDelay = RETRY_MIN_MS;
}

export function scheduleRetry(sessionId: string): void {
    if (retryTimer !== undefined || sessionId !== activeSessionId.get()) return;
    const delay = retryDelay;
    retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
    retryTimer = setTimeout(() => {
        retryTimer = undefined;
        if (sessionId !== activeSessionId.get()) return;
        console.info("[searchlight:sync] retrying unsynced events for", sessionId);
        flushPendingEvents(sessionId).catch((e) => {
            console.warn("[searchlight:sync] retry error:", e);
        });
    }, delay);
}

/** Flush now instead of waiting out the backoff, e.g. after a reconnect. */
export function retryPendingEvents(sessionId: string): void {
    cancelRetry();
    if (!hasUnsyncedEvents(sessionId)) return;
    flushPendingEvents(sessionId).catch((e) => {
        console.warn("[searchlight:sync] flush error:", e);
    });
}

function refreshSyncCounts(sessionId: string): void {
    const remaining = getPendingEvents(sessionId).filter(
        (event) => event.status !== "synced",
    ).length;
    pendingEventCount.set(remaining);
    if (remaining === 0) {
        syncStatus.set("synced");
        if (sessionId === activeSessionId.get()) cancelRetry();
    }
}

// A question list landed: what followed on from it moves on.
function settleQuestionsSaved(saved: QuestionsSaved, localId?: string): void {
    const { sessionId, local, madeFrom, sequence, mergedWith } = saved;
    if (sequence !== undefined) {
        // The board, and the lists queued after this one made from the
        // same base, followed on from it. Saved as it was, it's the
        // server's list now. Merged, it isn't: they still lack the other
        // side's changes, so they merge too (the board, until a merged
        // list is shown: see onQuestionsSaved).
        // Our own list as of the merge: its versions go back as far as
        // what it was made from.
        const next: QuestionsBase = mergedWith
            ? {
                  sequence: mergedWith.sequence,
                  questions: local,
                  since: madeFrom ? (madeFrom.since ?? madeFrom.sequence) : undefined,
              }
            : { sequence, questions: saved.saved };
        if (next.since === undefined) delete next.since;
        rebaseQueuedQuestions(sessionId, madeFrom, next, localId);
        advanceBoardBase(sessionId, madeFrom, next);
        // A board reopened from the snapshot shows the merged list as
        // queued, made from the server's list it was merged with: it shows
        // the saved list now, and it and the lists made on it move on from
        // there (its answer isn't shown over it: see showMergedSave).
        if (mergedWith && sessionId === activeSessionId.get()) {
            const game = gameDefinitionReady.get() ? compiledGameAtom.get() : null;
            const board = questions.get();
            if (sameQuestionList(board, filterSupportedQuestions(saved.saved, game))) {
                const to = { sequence, questions: saved.saved };
                rebaseQueuedQuestions(sessionId, mergedWith, to, localId);
                advanceBoardBase(sessionId, mergedWith, to);
            }
        }
        answered.set(sessionId, Math.max(answered.get(sessionId) ?? -1, sequence));
    }
}

// The latest sequence a question list of ours was saved at, by session, in
// this page.
const answered = new Map<string, number>();

/** The latest sequence a question list of ours was saved at in this page. */
export function latestSavedQuestionsSequence(sessionId: string): number | undefined {
    return answered.get(sessionId);
}

function notifyQuestionsSaved(saved: QuestionsSaved): void {
    for (const listener of questionsSavedListeners) listener(saved);
}

/**
 * Our own queued list came back from the server's event stream before
 * (or instead of: it was lost) its answer: it was saved, at `sequence`.
 * The stream has taken it off the queue. Handled as its answer would be,
 * so a merged list is shown and the board moves on from it; the answer,
 * if it still comes, then changes nothing.
 */
export function questionsSavedByEcho(
    sessionId: string,
    payload: QuestionsReplacePayload,
    saved: Questions,
    sequence: number,
): void {
    const settled: QuestionsSaved = {
        sessionId,
        local: payload.merged?.local ?? saved,
        saved,
        madeFrom: payload.merged?.base ?? payload.base,
        sequence,
        mergedWith: payload.merged ? payload.base : undefined,
    };
    settleQuestionsSaved(settled);
    notifyQuestionsSaved(settled);
}

async function dispatchQueuedEvent(
    requested: PendingEvent,
    keepalive: boolean,
): Promise<void> {
    const { sessionId } = requested;
    const queued = getPendingEvents(sessionId);
    const event = isReplacementEventType(requested.type)
        ? queued.findLast((candidate) => candidate.type === requested.type)
        : queued.find((candidate) => candidate.localId === requested.localId);
    if (!event) return;

    syncStatus.set("syncing");
    try {
        assertMaySend();
        const savedQuestions = await sendEvent(event, keepalive);
        // Its SSE echo can arrive first, and later replaces may already be
        // cached on top of it: only a still-queued replace updates the cache.
        const stillQueued = getPendingEvents(sessionId).some(
            (candidate) => candidate.localId === event.localId,
        );
        if (savedQuestions) settleQuestionsSaved(savedQuestions, event.localId);
        if (savedQuestions && stillQueued) {
            // The board as it stands with its base: the saved list once the
            // base is it; a merged one not shown yet (see showMergedSave,
            // which is skipped while a session loads) still shows ours as
            // queued, made from our list as of the merge. A board reopened
            // from the snapshot then shows the two together.
            const cached = getCachedSession(sessionId);
            const { local, saved, sequence, mergedWith } = savedQuestions;
            const shows =
                !mergedWith ||
                (sequence !== undefined && cached?.serverQuestions?.sequence === sequence)
                    ? saved
                    : local;
            setCachedSession({
                ...cached,
                sessionId,
                strokes: cached?.strokes ?? [],
                questions: shows,
                lastSyncedAt: Date.now(),
                lastSequence: cached?.lastSequence ?? 0,
            });
        }
        markEventSynced(sessionId, event.localId);
        if (savedQuestions) notifyQuestionsSaved(savedQuestions);
    } catch (err) {
        if (!recordSendFailure(event, err)) syncStatus.set("offline");
        throw err;
    } finally {
        refreshSyncCounts(sessionId);
    }
}

export function sendPendingEvent(
    event: PendingEvent,
    keepalive = false,
): Promise<void> {
    const previous = dispatches.get(event.sessionId);
    const run = () => dispatchQueuedEvent(event, keepalive);
    const result = previous ? previous.catch(() => {}).then(run) : run();
    dispatches.set(event.sessionId, result);
    const cleanup = () => {
        if (dispatches.get(event.sessionId) === result) {
            dispatches.delete(event.sessionId);
        }
    };
    void result.then(cleanup, cleanup);
    return result;
}

export async function flushPendingEvents(sessionId: string): Promise<void> {
    const pending = getPendingEvents(sessionId).filter(
        (event) => event.status !== "synced",
    );
    for (const event of pending) {
        try {
            await sendPendingEvent(event);
        } catch (err) {
            // A rejected edit has left the queue: the ones after it can sync.
            if (failureOf(err).kind === "rejected") continue;
            console.warn("[searchlight:sync] event send failed, stopping flush:", err);
            return;
        }
    }
    refreshSyncCounts(sessionId);
}
function handleOnline() {
    const sessionId = activeSessionId.get();
    if (!sessionId) return;
    console.info("[searchlight:sync] online — flushing pending events for", sessionId);
    cancelRetry();
    flushPendingEvents(sessionId).catch((e) => {
        console.warn("[searchlight:sync] flush error:", e);
    });
}

function handleOffline() {
    syncStatus.set("offline");
}

function handleVisibilityChange() {
    const sessionId = activeSessionId.get();
    if (document.visibilityState === "visible" && sessionId) {
        retryPendingEvents(sessionId);
    }
}

function handleActiveSessionChange(sessionId: string) {
    // Retries follow the active session, including a load whose flush failed
    // before the session was published.
    cancelRetry();
    if (sessionId && hasUnsyncedEvents(sessionId)) scheduleRetry(sessionId);
}

let started = false;
let unlistenActiveSession: (() => void) | undefined;

export function startSyncManager(): void {
    if (started) return;
    started = true;
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    unlistenActiveSession = activeSessionId.listen(handleActiveSessionChange);
    if (!navigator.onLine) syncStatus.set("offline");
}

export function stopSyncManager(): void {
    window.removeEventListener("online", handleOnline);
    window.removeEventListener("offline", handleOffline);
    document.removeEventListener("visibilitychange", handleVisibilityChange);
    unlistenActiveSession?.();
    unlistenActiveSession = undefined;
    cancelRetry();
    started = false;
}
