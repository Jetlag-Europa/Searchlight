import type {
    GameSessionSummary,
    SessionVisibility,
} from "@searchlight/shared";

import type { StrokeFeature } from "@/annotations/types";
import { offlineUserId, verifiedUserId } from "@/lib/activeSession";
import { forgetDisabledZones } from "@/lib/disabledZones";
import {
    findQuestionByKey,
    placeVersion,
    questionKey,
    sameQuestionKey,
    sameQuestionList,
    sameQuestionSubstance,
} from "@/lib/questionMerge";
import type { Questions } from "@/maps/schema";

export type EventType =
    | "stroke.create"
    | "stroke.delete"
    | "questions.replace"
    | "hider.update"
    | "planning.toggle";

export function isReplacementEventType(type: EventType): boolean {
    return (
        type === "questions.replace" ||
        type === "hider.update" ||
        type === "planning.toggle"
    );
}

export interface PendingEvent {
    localId: string;
    sessionId: string;
    type: EventType;
    payloadJson: unknown;
    clientUuid: string;
    clientCreatedAt: number;
    status: "pending" | "synced" | "failed";
    createdAt: number;
    // A question list once sent: it may be on the server even without an
    // answer (see QuestionsReplacePayload.own).
    sent?: boolean;
}

/**
 * The server's question list a queued list was made from, and the event
 * sequence it was at. A save sends the sequence: if the server's list has
 * changed since, it refuses, and the two are merged (see questionMerge.ts).
 */
export interface QuestionsBase {
    sequence: number;
    questions: Questions;
    // Versions the board has seen since, by the player's decision over a
    // question held for one (see questionConflicts): the server's version
    // as decided on. The list keeps its sequence; a list made from this base
    // is made from them on top (see baseQuestions).
    decided?: BaseDecision[];
    // A base that is our own list as of a merge (see settleQuestionsSaved
    // in syncManager): the server's sequence its versions go back to, for
    // telling who changed a question since.
    since?: number;
}

export interface BaseDecision {
    key: number;
    question: Questions[number] | null;
    afterKey?: number | null;
}

/** A base's questions, with the versions decided on since (see decided). */
export function baseQuestions(base: QuestionsBase): Questions {
    let list = base.questions;
    for (const decision of Array.isArray(base.decided) ? base.decided : []) {
        list = withDecision(list, decision);
    }
    return list;
}

// The list with a decided version in place, shown as the list shows it
// (folded, locked).
function withDecision(list: Questions, decision: BaseDecision): Questions {
    return placeVersion(list, decision.key, decision.question, [decision.afterKey]);
}

const sameDecision = (a: BaseDecision, b: BaseDecision) =>
    sameQuestionKey(a.key, b.key) && sameQuestionSubstance(a.question, b.question);

/**
 * `to`, with what `current` decided since `madeFrom` on top: decisions the
 * list made from `madeFrom` didn't know, so `to` (the result of saving that
 * list) doesn't reflect them.
 */
function carryDecisions(
    current: QuestionsBase | undefined,
    madeFrom: QuestionsBase | undefined,
    to: QuestionsBase,
): QuestionsBase {
    const known = madeFrom?.decided ?? [];
    const decided = (current?.decided ?? []).filter(
        (d) => !known.some((k) => sameDecision(k, d)),
    );
    const next: QuestionsBase = { sequence: to.sequence, questions: to.questions };
    if (to.since !== undefined) next.since = to.since;
    if (decided.length > 0) next.decided = decided;
    return next;
}

export interface QuestionsReplacePayload {
    replacementId: string;
    questions: Array<{
        clientUuid: string;
        ordinal: number;
        payloadJson: Questions[number];
    }>;
    // Missing in events queued by builds from before.
    base?: QuestionsBase;
    // Once merged with the server's list (and `questions` replaced by the
    // merge, `base` by that list): the list and base as first queued. A
    // retry of a merged save whose answer was lost sends the merged list,
    // and its answer is still read as a merge.
    merged?: { local: Questions; base: QuestionsBase };
    // Versions of questions that lists this one replaced in the queue had
    // changed, lists that were sent and not answered: one may be on the
    // server. Only for telling, when merging, our own earlier edit there
    // from another's (see mergeQuestionListsWithConflicts); never sent, and
    // forgotten once a save is answered, which settles them.
    own?: Questions;
}

// Kept at most, the latest; and no version larger than this (a custom
// zone can be megabytes): one too large to keep is only ever ours to add
// again, as before.
const MAX_OWN_VERSIONS = 100;
const MAX_OWN_VERSION_CHARS = 64 * 1024;

// The versions of questions the replaced lists that were sent changed
// against their base (for a merged one: the server's list it was merged
// with, so the other side's versions it holds aren't counted as ours), and
// what they carried. A list never sent can't be on the server.
function ownVersions(replaced: PendingEvent[]): Questions {
    const own: Questions = [];
    const add = (question: Questions[number]) => {
        const key = questionKey(question);
        if (key === undefined) return;
        if (JSON.stringify(question).length > MAX_OWN_VERSION_CHARS) return;
        const known = own.some(
            (q) =>
                sameQuestionKey(questionKey(q)!, key) &&
                sameQuestionSubstance(q, question),
        );
        if (!known) own.push(question);
    };
    for (const event of replaced) {
        const payload = event.payloadJson as Partial<QuestionsReplacePayload> | null;
        for (const question of Array.isArray(payload?.own) ? payload.own : []) add(question);
        // Queued by a build from before, which didn't mark it: it may have
        // been on its way when that page went away.
        const legacy = !("sent" in event) && isQuestionsBase(payload?.base);
        const sent =
            event.sent ||
            legacy ||
            event.status === "failed" ||
            Boolean(payload?.merged);
        if (!sent || !Array.isArray(payload?.questions)) continue;
        // Against what it was made from, decisions included.
        const base = isQuestionsBase(payload.base) ? baseQuestions(payload.base) : [];
        for (const entry of payload.questions) {
            const question = entry?.payloadJson;
            const key = questionKey(question);
            if (key === undefined) continue;
            const was = findQuestionByKey(base, key);
            if (was !== null && sameQuestionSubstance(was, question)) continue;
            add(question);
        }
    }
    return own.slice(-MAX_OWN_VERSIONS);
}

export interface CachedSessionState {
    sessionId: string;
    userId?: string;
    visibility?: SessionVisibility;
    // The session's details as last shown, its hider and planning mode
    // included: an offline restore has nothing else to load its game from.
    session?: GameSessionSummary;
    strokes: StrokeFeature[];
    // What the board showed, edits not yet synced included.
    questions: Questions;
    // The server's list the board's questions were made from (its "board
    // base"): the base of the next list queued. Moves on only when the board
    // does: a load, another player's list shown, a save of ours answered, or
    // a merged list shown.
    serverQuestions?: QuestionsBase;
    lastSyncedAt: number;
    lastSequence: number;
}

export function isQuestionsBase(value: unknown): value is QuestionsBase {
    if (!value || typeof value !== "object") return false;
    const base = value as Partial<QuestionsBase>;
    return (
        typeof base.sequence === "number" &&
        Number.isSafeInteger(base.sequence) &&
        base.sequence >= 0 &&
        Array.isArray(base.questions)
    );
}

function isSessionSummary(
    value: unknown,
    sessionId: string,
): value is GameSessionSummary {
    if (!value || typeof value !== "object") return false;
    const session = value as Partial<GameSessionSummary>;
    return (
        session.id === sessionId &&
        typeof session.gameId === "string" &&
        typeof session.gameRevisionId === "string" &&
        typeof session.name === "string"
    );
}

export const CACHE_PREFIX = "taibled-cache-";
export const PENDING_PREFIX = "taibled-pending-";
// Questions held for the player to decide (see questionConflicts.ts), kept
// next to the queue and per account like it, but out of it: they aren't
// edits to send.
export const CONFLICTS_PREFIX = "taibled-conflicts-";
export const MAX_CACHED_SESSIONS = 10;

// Each account has its own queue for a session, so edits queued by one are
// never shown to, or sent with the cookie of, another on the same browser.
// Before /me names an account (and in tests) the unowned queue is used.
function queueOwner(): string | null {
    return verifiedUserId.get() ?? offlineUserId.get();
}

function legacyPendingKey(sessionId: string) {
    return `${PENDING_PREFIX}${sessionId}`;
}

// Unowned queues found to be another account's, so they aren't checked on
// every read: session → the queue as last read.
const othersLegacyQueues = new Map<string, string>();

function pendingKey(sessionId: string) {
    const owner = queueOwner();
    if (!owner) return legacyPendingKey(sessionId);
    const key = `${PENDING_PREFIX}${sessionId}~${owner}`;
    // Builds from before queued without an owner: the snapshot's owner made
    // those edits. Anyone else's stay where they are.
    try {
        const legacy = localStorage.getItem(legacyPendingKey(sessionId));
        if (!legacy || othersLegacyQueues.get(`${sessionId}~${owner}`) === legacy) {
            return key;
        }
        if (getCachedSession(sessionId)?.userId !== owner) {
            othersLegacyQueues.set(`${sessionId}~${owner}`, legacy);
        } else {
            const own = localStorage.getItem(key);
            const events = [
                ...(JSON.parse(legacy) as PendingEvent[]),
                ...(own ? (JSON.parse(own) as PendingEvent[]) : []),
            ];
            localStorage.setItem(key, JSON.stringify(events));
            localStorage.removeItem(legacyPendingKey(sessionId));
        }
    } catch {
        // Storage is best-effort; the legacy queue stays put.
    }
    return key;
}

/**
 * Where this account's held question conflicts for a session are kept. The
 * unowned key only before /me names an account (and in tests), as for the
 * queue.
 */
export function conflictsKey(sessionId: string): string {
    const owner = queueOwner();
    return owner
        ? `${CONFLICTS_PREFIX}${sessionId}~${owner}`
        : `${CONFLICTS_PREFIX}${sessionId}`;
}

function cacheKey(sessionId: string) {
    return `${CACHE_PREFIX}${sessionId}`;
}

export function evictOldCachedSessions(
    maxEntries = MAX_CACHED_SESSIONS,
    protectedSessionId?: string,
): void {
    try {
        const matchingKeys: string[] = [];
        if (
            typeof localStorage.length === "number" &&
            typeof localStorage.key === "function"
        ) {
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (key && key.startsWith(CACHE_PREFIX)) {
                    matchingKeys.push(key);
                }
            }
        } else {
            for (const key of Object.keys(localStorage)) {
                if (key.startsWith(CACHE_PREFIX)) {
                    matchingKeys.push(key);
                }
            }
        }

        if (matchingKeys.length <= maxEntries) {
            return;
        }

        // Only read and parse timestamps when the count actually exceeds the cap
        const cacheEntries: Array<{
            key: string;
            lastSyncedAt: number;
            hasPending: boolean;
        }> = [];
        for (const key of matchingKeys) {
            try {
                const raw = localStorage.getItem(key);
                const parsed = raw
                    ? (JSON.parse(raw) as Partial<CachedSessionState>)
                    : null;
                cacheEntries.push({
                    key,
                    lastSyncedAt:
                        typeof parsed?.lastSyncedAt === "number"
                            ? parsed.lastSyncedAt
                            : 0,
                    hasPending:
                        key ===
                            (protectedSessionId
                                ? cacheKey(protectedSessionId)
                                : undefined) ||
                        getPendingEvents(key.slice(CACHE_PREFIX.length)).some(
                            (event) => event.status !== "synced",
                        ),
                });
            } catch {
                cacheEntries.push({ key, lastSyncedAt: 0, hasPending: true });
            }
        }

        // Pending edits need their base snapshot for offline reconciliation.
        const disposable = cacheEntries
            .filter((entry) => !entry.hasPending)
            .sort((a, b) => a.lastSyncedAt - b.lastSyncedAt);
        const toRemove = Math.min(
            cacheEntries.length - maxEntries,
            disposable.length,
        );
        for (let i = 0; i < toRemove; i++) {
            localStorage.removeItem(disposable[i].key);
        }
    } catch (e) {
        console.warn("[eventQueue] evictOldCachedSessions failed:", e);
    }
}

function writePendingQueue(sessionId: string, events: PendingEvent[]): void {
    const key = pendingKey(sessionId);
    const serialized = JSON.stringify(events);
    try {
        localStorage.setItem(key, serialized);
    } catch (firstErr) {
        console.warn(
            "[eventQueue] localStorage write failed for pending events, evicting disposable cache entries:",
            firstErr,
        );
        evictOldCachedSessions(0, sessionId);
        try {
            localStorage.setItem(key, serialized);
        } catch (secondErr) {
            console.error(
                "[eventQueue] localStorage write failed after evicting snapshots:",
                secondErr,
            );
            throw new Error(
                `Failed to persist pending event to storage: ${String(secondErr)}`,
            );
        }
    }
}

export function enqueueEvent(
    event: Omit<PendingEvent, "localId" | "status" | "createdAt">,
): PendingEvent {
    // These events contain complete field snapshots. Persist the new snapshot
    // atomically in place of older intent, including requests with a lost ACK.
    const queued = getPendingEvents(event.sessionId);
    const replaces = (q: PendingEvent) =>
        isReplacementEventType(event.type) && q.type === event.type;
    const events = queued.filter((q) => !replaces(q));
    let payloadJson = event.payloadJson;
    if (event.type === "questions.replace") {
        const own = ownVersions(queued.filter(replaces));
        if (own.length > 0) {
            payloadJson = { ...(event.payloadJson as QuestionsReplacePayload), own };
        }
    }
    const newEvent: PendingEvent = {
        ...event,
        payloadJson,
        localId: crypto.randomUUID(),
        status: "pending",
        createdAt: Date.now(),
        // Not sent yet (one without the mark is from a build before).
        ...(event.type === "questions.replace" ? { sent: false } : {}),
    };
    events.push(newEvent);
    try {
        writePendingQueue(event.sessionId, events);
    } catch (err) {
        // No room: the edit matters more than telling our own earlier
        // versions on the server from another's.
        const payload = newEvent.payloadJson as Partial<QuestionsReplacePayload> | null;
        if (event.type !== "questions.replace" || !payload?.own) throw err;
        const rest = { ...payload };
        delete rest.own;
        newEvent.payloadJson = rest;
        writePendingQueue(event.sessionId, events);
    }
    return newEvent;
}

export function getPendingEvents(sessionId: string): PendingEvent[] {
    try {
        const raw = localStorage.getItem(pendingKey(sessionId));
        if (!raw) return [];
        return JSON.parse(raw) as PendingEvent[];
    } catch {
        return [];
    }
}

function savePendingEvents(sessionId: string, events: PendingEvent[]): void {
    writePendingQueue(sessionId, events);
}

export function markEventSynced(sessionId: string, localId: string): void {
    const events = getPendingEvents(sessionId);
    const index = events.findIndex((event) => event.localId === localId);
    if (index === -1) return;
    const synced = events[index];
    // Also retire older snapshots from queues written before coalescing.
    savePendingEvents(
        sessionId,
        events.filter(
            (event, i) =>
                event.localId !== localId &&
                !(i < index && event.type === synced.type && isReplacementEventType(synced.type)),
        ),
    );
}

/** Drop an event the server rejected: resending it can never succeed. */
export function discardEvent(sessionId: string, localId: string): void {
    savePendingEvents(
        sessionId,
        getPendingEvents(sessionId).filter(
            (event) => event.localId !== localId,
        ),
    );
}

export function markEventFailed(sessionId: string, localId: string): void {
    const events = getPendingEvents(sessionId).map((e) =>
        e.localId === localId ? { ...e, status: "failed" as const } : e,
    );
    savePendingEvents(sessionId, events);
}

export function resetFailedEvents(sessionId: string): void {
    const events = getPendingEvents(sessionId).map((e) =>
        e.status === "failed" ? { ...e, status: "pending" as const } : e,
    );
    savePendingEvents(sessionId, events);
}

export function getCachedSession(sessionId: string): CachedSessionState | null {
    try {
        const raw = localStorage.getItem(cacheKey(sessionId));
        if (!raw) return null;
        const parsed = JSON.parse(raw) as Partial<CachedSessionState>;
        if (!parsed || typeof parsed !== "object") return null;
        // Migrate cached cursor to numeric 0 on old snapshots
        const lastSequence =
            typeof parsed.lastSequence === "number" ? parsed.lastSequence : 0;
        return {
            sessionId: parsed.sessionId ?? sessionId,
            userId: parsed.userId,
            serverQuestions: isQuestionsBase(parsed.serverQuestions)
                ? parsed.serverQuestions
                : undefined,
            visibility: parsed.visibility,
            session: isSessionSummary(parsed.session, sessionId)
                ? parsed.session
                : undefined,
            strokes: Array.isArray(parsed.strokes) ? parsed.strokes : [],
            questions: Array.isArray(parsed.questions) ? parsed.questions : [],
            lastSyncedAt:
                typeof parsed.lastSyncedAt === "number"
                    ? parsed.lastSyncedAt
                    : 0,
            lastSequence,
        };
    } catch {
        return null;
    }
}

export function setCachedSession(state: CachedSessionState): void {
    try {
        localStorage.setItem(cacheKey(state.sessionId), JSON.stringify(state));
        evictOldCachedSessions();
    } catch (e) {
        console.warn("[eventQueue] localStorage write failed (cache):", e);
        try {
            evictOldCachedSessions(Math.max(1, MAX_CACHED_SESSIONS - 2));
            localStorage.setItem(
                cacheKey(state.sessionId),
                JSON.stringify(state),
            );
        } catch {
            // Ignore if still failing
        }
    }
}

// The same server list (whatever was decided on top of it since).
function sameBase(a: QuestionsBase | undefined, b: QuestionsBase): boolean {
    return (
        a !== undefined &&
        a.sequence === b.sequence &&
        sameQuestionList(a.questions, b.questions)
    );
}

function latestQueuedQuestions(sessionId: string): PendingEvent | undefined {
    return getPendingEvents(sessionId).findLast(
        (event) =>
            event.type === "questions.replace" && event.status !== "synced",
    );
}

/** The base of the latest list still queued, if it has one. */
export function queuedQuestionsBase(
    sessionId: string,
): QuestionsBase | undefined {
    const base = (
        latestQueuedQuestions(sessionId)?.payloadJson as
            | Partial<QuestionsReplacePayload>
            | undefined
    )?.base;
    return isQuestionsBase(base) ? base : undefined;
}

/**
 * The base for a new question list: the server list the board's questions
 * were made from, as the snapshot tracks it (see serverQuestions). Undefined
 * when this browser knows none; the list is then saved as before, over
 * whatever the server has.
 */
export function questionsBase(sessionId: string): QuestionsBase | undefined {
    const cached = getCachedSession(sessionId);
    if (cached?.serverQuestions) return cached.serverQuestions;
    // No board base kept (a snapshot from before): a board that is live
    // shows the queued list as first made, not as merged.
    const queued = latestQueuedQuestions(sessionId)?.payloadJson as
        | Partial<QuestionsReplacePayload>
        | undefined;
    if (queued) {
        const base = queued.merged?.base ?? queued.base;
        return isQuestionsBase(base) ? base : undefined;
    }
    if (!cached) return undefined;
    // A snapshot from before: its list as of its last event is the best
    // there is.
    return { sequence: cached.lastSequence, questions: cached.questions };
}

/** The board's questions are now made from `base`. */
export function setBoardBase(sessionId: string, base: QuestionsBase): void {
    const cached = getCachedSession(sessionId);
    if (!cached) return;
    setCachedSession({ ...cached, serverQuestions: base });
}

/**
 * The board has seen `question` (null: its removal) as the server's version
 * of the question with `key`, by the player's decision over it: the next
 * list queued is made from that (see QuestionsBase.decided). Nothing to
 * record if the board's base has that version already.
 */
export function decideBoardBaseQuestion(
    sessionId: string,
    key: number,
    question: Questions[number] | null,
    afterKey?: number | null,
): void {
    const cached = getCachedSession(sessionId);
    if (!cached) return;
    const base = cached.serverQuestions ?? questionsBase(sessionId);
    if (!base) return;
    if (sameQuestionSubstance(findQuestionByKey(baseQuestions(base), key), question)) return;
    const decision: BaseDecision = { key, question };
    if (afterKey !== undefined) decision.afterKey = afterKey;
    setCachedSession({
        ...cached,
        serverQuestions: {
            ...base,
            decided: [
                ...(base.decided ?? []).filter((d) => !sameQuestionKey(d.key, key)),
                decision,
            ],
        },
    });
}

/**
 * The board moved from `from` to `to`, e.g. our list made from `from` was
 * saved as is. A board made from anything else stays as it is.
 */
export function advanceBoardBase(
    sessionId: string,
    from: QuestionsBase | undefined,
    to: QuestionsBase,
): void {
    const cached = getCachedSession(sessionId);
    if (!cached) return;
    const current = cached.serverQuestions ?? queuedQuestionsBase(sessionId);
    if (!from || !sameBase(current, from)) return;
    setCachedSession({ ...cached, serverQuestions: carryDecisions(current, from, to) });
}

/**
 * Give the queued question lists made from `from` the base `to`, e.g. once
 * the list they followed on from is saved. Every list sent before that one
 * has landed or never will by then, so they no longer count versions of
 * those as possibly ours (see QuestionsReplacePayload.own).
 */
export function rebaseQueuedQuestions(
    sessionId: string,
    from: QuestionsBase | undefined,
    to: QuestionsBase,
    exceptLocalId?: string,
): void {
    if (!from) return;
    const events = getPendingEvents(sessionId);
    let changed = false;
    const rebased = events.map((event) => {
        const payload = event.payloadJson as Partial<QuestionsReplacePayload>;
        if (
            event.type !== "questions.replace" ||
            event.status === "synced" ||
            event.localId === exceptLocalId ||
            !isQuestionsBase(payload?.base) ||
            !sameBase(payload.base, from)
        ) {
            return event;
        }
        changed = true;
        const next = { ...payload, base: carryDecisions(payload.base, from, to) };
        delete next.own;
        return { ...event, payloadJson: next };
    });
    if (changed) writePendingQueue(sessionId, rebased);
}

/** The queued event is being sent: it may land from now on. */
export function markEventSent(sessionId: string, localId: string): void {
    const events = getPendingEvents(sessionId);
    const index = events.findIndex((event) => event.localId === localId);
    if (index === -1 || events[index].sent) return;
    events[index] = { ...events[index], sent: true };
    writePendingQueue(sessionId, events);
}

/** Replace a queued event's payload, if it's still queued. */
export function updateQueuedPayload(
    sessionId: string,
    localId: string,
    payloadJson: unknown,
): boolean {
    const events = getPendingEvents(sessionId);
    const index = events.findIndex((event) => event.localId === localId);
    if (index === -1) return false;
    events[index] = { ...events[index], payloadJson };
    writePendingQueue(sessionId, events);
    return true;
}

export function clearCachedSession(sessionId: string): void {
    localStorage.removeItem(cacheKey(sessionId));
    // Do NOT remove pendingKey(sessionId) — avoid losing pending queue on cache eviction
}

// For a session that can never sync again (deleted, or this user removed):
// unlike cache eviction, also drop its queue, which would otherwise pin the
// snapshot in storage forever, and its disabled zones. A deleted session
// takes every account's queue with it (`allAccounts`); one this account
// lost access to only takes this account's and the unowned one, since
// another account may still have access. Questions held for a decision go
// the same way.
export function discardSessionData(
    sessionId: string,
    { allAccounts = false }: { allAccounts?: boolean } = {},
): void {
    forgetDisabledZones(sessionId);
    try {
        if (allAccounts) {
            const prefixes = [
                `${PENDING_PREFIX}${sessionId}~`,
                `${CONFLICTS_PREFIX}${sessionId}~`,
            ];
            const keys: string[] = [];
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (key && prefixes.some((p) => key.startsWith(p))) keys.push(key);
            }
            for (const key of keys) localStorage.removeItem(key);
        }
        localStorage.removeItem(pendingKey(sessionId));
        localStorage.removeItem(legacyPendingKey(sessionId));
        localStorage.removeItem(conflictsKey(sessionId));
        localStorage.removeItem(`${CONFLICTS_PREFIX}${sessionId}`);
        localStorage.removeItem(cacheKey(sessionId));
    } catch (e) {
        console.warn("[eventQueue] failed to discard session data:", e);
    }
    for (const listener of discardListeners) listener(sessionId);
}

type DiscardListener = (sessionId: string) => void;
const discardListeners = new Set<DiscardListener>();

/** Hear about a session's data being discarded. */
export function onSessionDataDiscarded(listener: DiscardListener): () => void {
    discardListeners.add(listener);
    return () => {
        discardListeners.delete(listener);
    };
}

// Derive current local state by replaying pending events on top of a cached snapshot.
// Call this on session load when a cache hit exists to get the full offline-safe state.
export function applyPendingEventsToState(
    base: { strokes: StrokeFeature[]; questions: Questions },
    events: PendingEvent[],
): { strokes: StrokeFeature[]; questions: Questions } {
    let { strokes, questions } = base;
    for (const event of events) {
        if (event.type === "stroke.create") {
            const stroke = event.payloadJson as StrokeFeature;
            if (
                !strokes.find(
                    (s) =>
                        s.properties.clientUuid ===
                        stroke.properties.clientUuid,
                )
            ) {
                strokes = [...strokes, stroke];
            }
        } else if (event.type === "stroke.delete") {
            const { clientUuid } = event.payloadJson as { clientUuid: string };
            strokes = strokes.filter(
                (s) => s.properties.clientUuid !== clientUuid,
            );
        } else if (event.type === "questions.replace") {
            const payload = event.payloadJson;
            if (
                payload &&
                typeof payload === "object" &&
                "questions" in payload &&
                Array.isArray(payload.questions)
            ) {
                questions = payload.questions.map((q) =>
                    q && typeof q === "object" && "payloadJson" in q
                        ? q.payloadJson
                        : q,
                ) as Questions;
            } else if (Array.isArray(payload)) {
                questions = payload.map((q) =>
                    q && typeof q === "object" && "payloadJson" in q
                        ? q.payloadJson
                        : q,
                ) as Questions;
            }
        }
    }
    return { strokes, questions };
}

type HiderModeValue = false | { latitude: number; longitude: number };

/**
 * A session's hider and planning mode: the latest of `events` that set them
 * (edits not yet synced), else the session's own.
 */
export function applyPendingModes(
    session: Pick<
        GameSessionSummary,
        "hiderLat" | "hiderLng" | "planningModeEnabled"
    >,
    events: PendingEvent[],
): { hiderMode: HiderModeValue; planningModeEnabled: boolean } {
    let hiderLat = session.hiderLat;
    let hiderLng = session.hiderLng;
    let planningModeEnabled = session.planningModeEnabled ?? false;
    for (const event of events) {
        const payload = event.payloadJson as Record<string, unknown> | null;
        if (!payload || typeof payload !== "object") continue;
        if (event.type === "hider.update") {
            hiderLat = typeof payload.hiderLat === "number" ? payload.hiderLat : null;
            hiderLng = typeof payload.hiderLng === "number" ? payload.hiderLng : null;
        } else if (
            event.type === "planning.toggle" &&
            typeof payload.planningModeEnabled === "boolean"
        ) {
            planningModeEnabled = payload.planningModeEnabled;
        }
    }
    return {
        hiderMode:
            hiderLat != null && hiderLng != null
                ? { latitude: hiderLat, longitude: hiderLng }
                : false,
        planningModeEnabled,
    };
}

// Replay the edits the server hasn't acknowledged (pending or failed) on top of
// a snapshot, so loading server or cached state never hides unsynced work.
export function applyUnsyncedEvents(
    sessionId: string,
    base: { strokes: StrokeFeature[]; questions: Questions },
): { strokes: StrokeFeature[]; questions: Questions } {
    return applyPendingEventsToState(
        base,
        getPendingEvents(sessionId).filter((event) => event.status !== "synced"),
    );
}
