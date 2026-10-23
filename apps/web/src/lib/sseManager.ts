import type { EventRecord } from "@searchlight/shared";

import { strokes } from "@/annotations/hooks/useAnnotationStore";
import {
    isStrokeTombstoned,
    recordStrokeTombstone,
} from "@/annotations/storage/serverStore";
import type { StrokeFeature } from "@/annotations/types";
import {
    compiledGameAtom,
    filterSupportedQuestions,
} from "@/game-definition/store";
import type { PresenceUser } from "@/lib/context";
import {
    connectedUsers,
    hiderMode,
    planningModeEnabled,
    questions,
    syncStatus,
} from "@/lib/context";
import {
    advanceBoardBase,
    getCachedSession,
    getPendingEvents,
    markEventSynced,
    type QuestionsReplacePayload,
    setBoardBase,
    setCachedSession,
} from "@/lib/eventQueue";
import { suppressNextHiderSave } from "@/lib/hiderSaveSuppress";
import { suppressNextPlanningModeSave } from "@/lib/planningModeSaveSuppress";
import { reconcileQuestionConflicts } from "@/lib/questionConflicts";
import { sameQuestionList } from "@/lib/questionMerge";
import { suppressQuestionSave } from "@/lib/questionSaveSuppress";
import {
    hasPendingHiderSave,
    hasPendingPlanningModeSave,
    hasScheduledQuestionSave,
} from "@/lib/sessionState";
import {
    onQuestionsSaved,
    questionsSavedByEcho,
    retryPendingEvents,
} from "@/lib/syncManager";
import type { Questions } from "@/maps/schema";

const API_BASE = import.meta.env.PUBLIC_API_BASE as string;

let eventSource: EventSource | null = null;
let currentSessionId: string | null = null;
let currentGeneration = 0;
let lastAppliedSequence = 0;
let isGapFilling = false;
let liveEventBuffer: EventRecord[] = [];
let replayAttempt = 0;
let replayRetry: NodeJS.Timeout | undefined;
let reconnectTimer: NodeJS.Timeout | undefined;
let onSessionUnavailable: ((status: number) => void) | undefined;
const MAX_BUFFERED_EVENTS = 500;

// Failed replays and closed streams retry with a doubling, capped delay.
const RETRY_MIN_MS = 3_000;
const RETRY_MAX_MS = 30_000;
let replayRetryDelay = RETRY_MIN_MS;
let reconnectDelay = RETRY_MIN_MS;

function isUnavailableStatus(status: number): boolean {
    return status === 403 || status === 404;
}

// The session was deleted or this user lost access: retrying cannot help.
function sessionUnavailable(sessionId: string, status: number): void {
    console.warn(
        "[searchlight:sse] session",
        sessionId,
        "is unavailable (" + status + "), stopping",
    );
    const notify = onSessionUnavailable;
    stopSSE();
    notify?.(status);
}

function persistSessionCache(): void {
    if (!currentSessionId) return;
    const cached = getCachedSession(currentSessionId);
    if (!cached) return;
    setCachedSession({
        ...cached,
        strokes: strokes.get(),
        questions: questions.get(),
        lastSequence: lastAppliedSequence,
        lastSyncedAt: Date.now(),
    });
}

/**
 * Show the server's question list as of `sequence` on the board (another
 * player's), unless an edit of ours is still to be saved, in which case it
 * is merged when that is (returns false), or the board is made from it or
 * a later one already.
 */
function showServerQuestions(
    sessionId: string,
    serverList: Questions,
    sequence: number,
): boolean {
    const unsynced = getPendingEvents(sessionId).filter(
        (e) => e.type === "questions.replace" && e.status !== "synced",
    );
    if (unsynced.length > 0 || hasScheduledQuestionSave(sessionId)) {
        console.info(
            "[searchlight:sse] questions.replace skipped — local edit not yet saved",
            unsynced.length,
            "pending",
        );
        return false;
    }
    if ((getCachedSession(sessionId)?.serverQuestions?.sequence ?? -1) >= sequence) {
        // The board is made from this list or a later one already (a late
        // echo of a save of ours that was answered).
        console.info("[searchlight:sse] questions.replace skipped — the board has it");
        return true;
    }
    setBoardBase(sessionId, { sequence, questions: serverList });
    // Questions held for a decision may be settled by it, or changed again.
    reconcileQuestionConflicts(sessionId, serverList, sequence);
    const newQs = filterSupportedQuestions(
        serverList,
        compiledGameAtom.get(),
    ) as Questions;
    console.info(
        "[searchlight:sse] applying questions.replace",
        newQs.length,
        "question(s)",
    );
    questions.set(suppressQuestionSave(newQs));
    return true;
}

// A save of ours was answered at a sequence the stream has gone past: lists
// the stream passed over meanwhile (ours was still to be saved, or a load
// started the stream from a later cursor) may not show on the board. Read
// the server's list then, and show it as one from the stream.
onQuestionsSaved(({ sessionId, sequence }) => {
    if (sequence === undefined || sessionId !== currentSessionId) return;
    if (sequence >= lastAppliedSequence) return;
    const generation = currentGeneration;
    void fetch(`${API_BASE}/sessions/${sessionId}/questions`, {
        credentials: "include",
    })
        .then(async (res) => {
            if (!res.ok) return;
            const data = (await res.json()) as {
                questions: Array<{ payloadJson: Questions[number] }>;
                sequence?: unknown;
            };
            if (generation !== currentGeneration || sessionId !== currentSessionId) return;
            if (typeof data.sequence !== "number") return;
            showServerQuestions(
                sessionId,
                data.questions.map((q) => q.payloadJson),
                data.sequence,
            );
        })
        .catch((err) => {
            console.warn("[searchlight:sse] couldn't read the questions to catch up:", err);
        });
});

function handleServerEvent(
    event: EventRecord,
    expectedSessionId?: string,
    persist = true,
): void {
    const targetSessionId = expectedSessionId ?? currentSessionId;
    if (
        !targetSessionId ||
        !currentSessionId ||
        currentSessionId !== targetSessionId
    ) {
        console.info(
            "[searchlight:sse] discarding event for mismatched session:",
            event.sessionId,
            "active:",
            currentSessionId,
        );
        return;
    }
    if (event.sessionId !== targetSessionId) {
        console.warn(
            "[searchlight:sse] discarding event from another session",
            event.sessionId,
        );
        return;
    }
    if (
        !Number.isSafeInteger(event.sequence) ||
        event.sequence <= lastAppliedSequence
    ) {
        return;
    }
    lastAppliedSequence = event.sequence;
    const eventSeq = event.sequence;

    console.info("[searchlight:sse] received event", {
        id: event.id,
        type: event.type,
        sequence: eventSeq,
        clientUuid: event.clientUuid,
        userId: event.userId,
    });

    if (event.type === "stroke.create") {
        const stroke = event.payloadJson as StrokeFeature;
        const clientUuid = stroke.properties?.clientUuid;
        if (clientUuid) {
            if (isStrokeTombstoned(clientUuid)) {
                console.info(
                    "[searchlight:sse] stroke.create skipped — tombstone exists:",
                    clientUuid,
                );
                return;
            }
            const pending = currentSessionId
                ? getPendingEvents(currentSessionId)
                : [];
            const hasPendingDelete = pending.some(
                (e) =>
                    e.type === "stroke.delete" &&
                    (e.payloadJson as { clientUuid: string })?.clientUuid ===
                        clientUuid,
            );
            if (hasPendingDelete) {
                console.info(
                    "[searchlight:sse] stroke.create skipped — local pending delete exists:",
                    clientUuid,
                );
                return;
            }
        }
        const current = strokes.get();
        const isDup = !!current.find(
            (s) => s.properties.clientUuid === stroke.properties.clientUuid,
        );
        if (!isDup) {
            console.info(
                "[searchlight:sse] applying stroke.create",
                stroke.properties.clientUuid,
                `(${current.length} → ${current.length + 1} strokes)`,
            );
            strokes.set([...current, stroke]);
        } else {
            console.info(
                "[searchlight:sse] stroke.create is a duplicate, skipping",
                stroke.properties.clientUuid,
            );
        }
    } else if (event.type === "stroke.delete") {
        const { clientUuid } = event.payloadJson as { clientUuid: string };
        if (clientUuid) {
            recordStrokeTombstone(clientUuid);
        }
        const before = strokes.get().length;
        strokes.set(
            strokes.get().filter((s) => s.properties.clientUuid !== clientUuid),
        );
        const after = strokes.get().length;
        console.info(
            "[searchlight:sse] applying stroke.delete",
            clientUuid,
            `(${before} → ${after} strokes)`,
        );
    } else if (event.type === "questions.replace") {
        const unsynced = getPendingEvents(targetSessionId).filter(
            (e) => e.type === "questions.replace" && e.status !== "synced",
        );
        // Our own replace can echo back before its PUT is acknowledged. The
        // echo proves it committed at this sequence, so replaces from other
        // players committed after it must apply rather than be skipped. The
        // echo itself is not applied: the board already shows that list, or a
        // newer edit that is still on its way.
        const own = unsynced.find((e) => e.clientUuid === event.clientUuid);
        const serverList = (
            event.payloadJson as {
                questions: Array<{ payloadJson: Questions[number] }>;
            }
        ).questions.map((question) => question.payloadJson);
        if (own) {
            markEventSynced(targetSessionId, own.localId);
            const payload = own.payloadJson as QuestionsReplacePayload;
            const local = payload.questions.map((question) => question.payloadJson);
            if (payload.merged) {
                // The board doesn't show the other side's changes yet: show
                // the merged list, as its answer would (it may never come).
                questionsSavedByEcho(targetSessionId, payload, serverList, eventSeq);
            } else {
                // The board's base moves on.
                if (sameQuestionList(local, serverList)) {
                    advanceBoardBase(targetSessionId, payload.base, {
                        sequence: eventSeq,
                        questions: serverList,
                    });
                }
            }
        } else if (!showServerQuestions(targetSessionId, serverList, eventSeq)) {
            return;
        }
    } else if (event.type === "hider.update") {
        const { hiderLat, hiderLng } = event.payloadJson as {
            hiderLat: number | null;
            hiderLng: number | null;
        };
        if (hasPendingHiderSave(targetSessionId)) {
            console.info(
                "[searchlight:sse] hider.update ignored — local save pending for session",
                targetSessionId,
            );
            return;
        }
        console.info("[searchlight:sse] applying hider.update", {
            hiderLat,
            hiderLng,
        });
        suppressNextHiderSave();
        hiderMode.set(
            hiderLat != null && hiderLng != null
                ? { latitude: hiderLat, longitude: hiderLng }
                : false,
        );
    } else if (event.type === "planning.toggle") {
        const { planningModeEnabled: enabled } = event.payloadJson as {
            planningModeEnabled: boolean;
        };
        if (hasPendingPlanningModeSave(targetSessionId)) {
            console.info(
                "[searchlight:sse] planning.toggle ignored — local save pending for session",
                targetSessionId,
            );
            return;
        }
        console.info("[searchlight:sse] applying planning.toggle", enabled);
        suppressNextPlanningModeSave();
        planningModeEnabled.set(enabled);
    } else if (event.type === "session.revision-upgraded") {
        console.info(
            "[searchlight:sse] session.revision-upgraded received",
            event.payloadJson,
        );
        if (typeof window !== "undefined") {
            window.dispatchEvent(
                new CustomEvent("session-revision-upgraded", {
                    detail: event.payloadJson,
                }),
            );
        }
    } else {
        console.warn("[searchlight:sse] unknown event type:", event.type);
    }

    if (persist) persistSessionCache();
}

function handlePresenceEvent(type: string, payloadJson: unknown): void {
    if (type === "presence.snapshot") {
        const { users } = payloadJson as { users: PresenceUser[] };
        console.info(
            "[searchlight:sse] presence.snapshot:",
            users.length,
            "user(s)",
        );
        connectedUsers.set(users);
    } else if (type === "presence.join") {
        const user = payloadJson as PresenceUser;
        const current = connectedUsers.get();
        if (!current.find((u) => u.userId === user.userId)) {
            console.info("[searchlight:sse] presence.join:", user.displayName);
            connectedUsers.set([...current, user]);
        }
    } else if (type === "presence.leave") {
        const { userId } = payloadJson as { userId: string };
        console.info("[searchlight:sse] presence.leave:", userId);
        connectedUsers.set(
            connectedUsers.get().filter((u) => u.userId !== userId),
        );
    }
}

function startReplay(sessionId: string, generation: number): void {
    clearTimeout(replayRetry);
    replayRetry = undefined;
    isGapFilling = true;
    void gapFill(sessionId, generation, ++replayAttempt);
}

async function gapFill(
    sessionId: string,
    generation: number,
    attempt: number,
): Promise<void> {
    const isCurrent = () =>
        currentGeneration === generation &&
        currentSessionId === sessionId &&
        replayAttempt === attempt;
    if (!isCurrent()) return;

    let complete = false;
    let unavailableStatus: number | undefined;
    try {
        let after = lastAppliedSequence;
        while (isCurrent()) {
            const url = `${API_BASE}/sessions/${sessionId}/events?after=${after}&limit=50`;
            const res = await fetch(url, { credentials: "include" });
            if (!isCurrent()) return;
            if (isUnavailableStatus(res.status)) {
                unavailableStatus = res.status;
                break;
            }
            if (!res.ok) throw new Error(`Gap fill failed: ${res.status}`);
            const data = (await res.json()) as {
                events: EventRecord[];
                nextAfter: number | null;
            };
            if (!isCurrent()) return;
            if (!Array.isArray(data.events))
                throw new Error("Invalid event page");
            for (const event of data.events) {
                handleServerEvent(event, sessionId, false);
            }
            // Persist once per page, not once per stroke in a long replay.
            persistSessionCache();
            if (data.nextAfter === null) {
                complete = true;
                break;
            }
            if (
                !Number.isSafeInteger(data.nextAfter) ||
                data.nextAfter <= after ||
                data.events.length === 0
            ) {
                throw new Error("Invalid event page cursor");
            }
            after = data.nextAfter;
        }
    } catch (error) {
        if (isCurrent())
            console.warn("[searchlight:sse] gap fill error:", error);
    }
    if (!isCurrent()) return;
    if (unavailableStatus !== undefined) {
        sessionUnavailable(sessionId, unavailableStatus);
    } else if (complete) {
        replayRetryDelay = RETRY_MIN_MS;
        syncStatus.set("live");
        isGapFilling = false;
        drainBufferedEvents(sessionId, generation);
    } else {
        syncStatus.set("offline");
        const delay = replayRetryDelay;
        replayRetryDelay = Math.min(delay * 2, RETRY_MAX_MS);
        replayRetry = setTimeout(() => {
            if (isCurrent()) startReplay(sessionId, generation);
        }, delay);
    }
}

function drainBufferedEvents(sessionId: string, generation: number): void {
    if (liveEventBuffer.length === 0) return;
    const buffered = liveEventBuffer.splice(0, liveEventBuffer.length);
    buffered.sort((a, b) => a.sequence - b.sequence);
    console.info(
        "[searchlight:sse] draining",
        buffered.length,
        "buffered live event(s)",
    );
    for (let index = 0; index < buffered.length; index++) {
        if (currentGeneration !== generation || currentSessionId !== sessionId)
            return;
        const event = buffered[index];
        if (event.sequence > lastAppliedSequence + 1) {
            // The stream got ahead of durable replay. Keep the gap buffered
            // rather than skipping an earlier question or stroke mutation.
            liveEventBuffer = buffered.slice(index);
            isGapFilling = true;
            syncStatus.set("offline");
            replayRetry = setTimeout(() => {
                if (
                    currentGeneration === generation &&
                    currentSessionId === sessionId
                ) {
                    startReplay(sessionId, generation);
                }
            }, 3000);
            return;
        }
        handleServerEvent(event, sessionId);
    }
}

/**
 * Stream live events for `sessionId`. `onUnavailable` is called, after the
 * stream has stopped, once the server answers 403 or 404 for the session.
 */
export function startSSE(
    sessionId: string,
    onUnavailable?: (status: number) => void,
): void {
    console.info("[searchlight:sse] startSSE called for session", sessionId);
    stopSSE();
    const generation = ++currentGeneration;
    currentSessionId = sessionId;
    onSessionUnavailable = onUnavailable;

    const cached = getCachedSession(sessionId);
    lastAppliedSequence =
        typeof cached?.lastSequence === "number" ? cached.lastSequence : 0;
    isGapFilling = false;
    liveEventBuffer = [];
    console.info(
        "[searchlight:sse] lastAppliedSequence from cache:",
        lastAppliedSequence,
    );
    openStream(sessionId, generation);
}

// An EventSource gives up for good, without saying why, once a reconnect gets
// a non-200 answer (a 502 during a deploy, or a revoked session). Check the
// session is still there, then open a new stream that resumes from the last
// applied sequence.
function scheduleReconnect(sessionId: string, generation: number): void {
    const isCurrent = () =>
        currentGeneration === generation && currentSessionId === sessionId;
    const delay = reconnectDelay;
    reconnectDelay = Math.min(delay * 2, RETRY_MAX_MS);
    console.info("[searchlight:sse] stream closed, reconnecting in", delay, "ms");
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(async () => {
        reconnectTimer = undefined;
        if (!isCurrent()) return;
        let res: Response | undefined;
        try {
            res = await fetch(
                `${API_BASE}/sessions/${sessionId}/events/cursor`,
                { credentials: "include" },
            );
        } catch (err) {
            console.warn("[searchlight:sse] reconnect check failed:", err);
        }
        if (!isCurrent()) return;
        if (res && isUnavailableStatus(res.status)) {
            sessionUnavailable(sessionId, res.status);
        } else if (res?.ok) {
            openStream(sessionId, generation);
        } else {
            scheduleReconnect(sessionId, generation);
        }
    }, delay);
}

function openStream(sessionId: string, generation: number): void {
    const url = `${API_BASE}/sessions/${sessionId}/stream`;
    console.info("[searchlight:sse] opening EventSource →", url);

    const source = new EventSource(url, { withCredentials: true });
    eventSource = source;

    source.onopen = () => {
        if (
            source !== eventSource ||
            currentGeneration !== generation ||
            currentSessionId !== sessionId
        ) {
            return;
        }
        console.info(
            "[searchlight:sse] connection opened, readyState:",
            source.readyState,
        );
        reconnectDelay = RETRY_MIN_MS;
        syncStatus.set("live");
        startReplay(sessionId, generation);
        // The server is reachable again: deliver edits that failed meanwhile,
        // which would otherwise keep blocking incoming updates.
        retryPendingEvents(sessionId);
    };

    source.onmessage = (e: MessageEvent) => {
        if (
            source !== eventSource ||
            currentGeneration !== generation ||
            currentSessionId !== sessionId
        ) {
            console.info(
                "[searchlight:sse] message ignored — obsolete EventSource",
            );
            return;
        }
        console.info(
            "[searchlight:sse] raw message received, length:",
            (e.data as string).length,
        );
        try {
            const parsed = JSON.parse(e.data as string) as {
                type: string;
                payloadJson: unknown;
            };
            if (parsed.type.startsWith("presence.")) {
                handlePresenceEvent(parsed.type, parsed.payloadJson);
                return;
            }
            const record = parsed as unknown as EventRecord;
            const seq =
                "sequence" in record && typeof record.sequence === "number"
                    ? record.sequence
                    : undefined;

            if (isGapFilling) {
                if (liveEventBuffer.length >= MAX_BUFFERED_EVENTS)
                    liveEventBuffer.shift();
                liveEventBuffer.push(record);
                return;
            }
            if (typeof seq === "number" && seq > lastAppliedSequence + 1) {
                liveEventBuffer.push(record);
                startReplay(sessionId, generation);
                return;
            }

            handleServerEvent(record, sessionId);
        } catch (err) {
            console.warn(
                "[searchlight:sse] failed to parse SSE message:",
                err,
                "raw:",
                e.data,
            );
        }
    };

    source.onerror = (e) => {
        if (
            source !== eventSource ||
            currentGeneration !== generation ||
            currentSessionId !== sessionId
        ) {
            return;
        }
        console.warn(
            "[searchlight:sse] connection error, readyState:",
            source.readyState,
            e,
        );
        // The next onopen starts a fresh replay attempt.
        if (syncStatus.get() === "live") {
            syncStatus.set("synced");
            console.info("[searchlight:sse] status reverted to synced");
        }
        if (source.readyState === EventSource.CLOSED) {
            scheduleReconnect(sessionId, generation);
        }
    };
}

export function stopSSE(): void {
    currentGeneration++;
    if (eventSource) {
        console.info(
            "[searchlight:sse] stopSSE — closing EventSource for session",
            currentSessionId,
        );
        eventSource.close();
        eventSource = null;
    }
    clearTimeout(replayRetry);
    replayRetry = undefined;
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
    replayRetryDelay = RETRY_MIN_MS;
    reconnectDelay = RETRY_MIN_MS;
    onSessionUnavailable = undefined;
    replayAttempt++;
    liveEventBuffer = [];
    isGapFilling = false;
    if (syncStatus.get() === "live") syncStatus.set("synced");
    connectedUsers.set([]);
    currentSessionId = null;
    lastAppliedSequence = 0;
}
