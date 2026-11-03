import type { GameSessionSummary } from "@searchlight/shared";

import { isSessionSummary } from "@/lib/eventQueue";
import { sessionUnavailableStatus } from "@/lib/sessionUnavailable";

const API_BASE = import.meta.env.PUBLIC_API_BASE as string;

// A request that hangs on a bad connection mustn't hold up the next try.
export const PROBE_TIMEOUT_MS = 8_000;

export type SessionDetails =
    // The server answered with the session's details (for a probe: and with
    // everything a load reads).
    | { kind: "ready"; session: GameSessionSummary }
    // The session is gone or closed to this user (see sessionUnavailableStatus).
    | { kind: "unavailable"; status: 403 | 404 }
    | { kind: "signedOut" }
    // Anything else: a 5xx, no network, a route this API doesn't have, an
    // answer that isn't the session's details, or `signal` aborted.
    | { kind: "retry" };

const RETRY: SessionDetails = { kind: "retry" };

/** The session's details from the server, or why there are none. */
export async function fetchSessionDetails(
    sessionId: string,
    signal?: AbortSignal,
): Promise<SessionDetails> {
    let res: Response;
    try {
        res = await fetch(`${API_BASE}/sessions/${sessionId}`, {
            credentials: "include",
            signal,
        });
    } catch {
        return RETRY;
    }
    if (res.status === 401) return { kind: "signedOut" };
    if (!res.ok) {
        const status = await sessionUnavailableStatus(res);
        return status === null ? RETRY : { kind: "unavailable", status };
    }
    try {
        const session: unknown = await res.json();
        return isSessionSummary(session, sessionId)
            ? { kind: "ready", session }
            : RETRY;
    } catch {
        return RETRY;
    }
}

/**
 * Whether the session would load now, without loading it: its details, then
 * its strokes and questions, as loadSessionContent reads them. Only reads:
 * nothing is cached or shown. The event cursor isn't asked for, as a load
 * goes on without it.
 */
export async function probeSession(sessionId: string): Promise<SessionDetails> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
        return await probe(sessionId, controller.signal);
    } finally {
        clearTimeout(timeout);
    }
}

async function probe(
    sessionId: string,
    signal: AbortSignal,
): Promise<SessionDetails> {
    const details = await fetchSessionDetails(sessionId, signal);
    if (details.kind !== "ready") return details;
    const read = (path: string) =>
        fetch(`${API_BASE}/sessions/${sessionId}${path}`, {
            credentials: "include",
            signal,
        }).then(
            (answer) => usableList(answer, path.slice(1)),
            () => "retry" as const,
        );
    // Each on its own: one failing mustn't hide the other's 401.
    const content = await Promise.all([read("/strokes"), read("/questions")]);
    if (content.includes("signedOut")) return { kind: "signedOut" };
    return content.every((part) => part === "ok") ? details : RETRY;
}

/**
 * Whether a content answer is one the load can use: OK, and JSON whose `key`
 * is a list. The load skips entries it can't read (see loadStrokesFromServer
 * and fetchQuestions).
 */
async function usableList(
    answer: Response,
    key: string,
): Promise<"ok" | "signedOut" | "retry"> {
    if (answer.status === 401) return "signedOut";
    if (!answer.ok) {
        void answer.body?.cancel().catch(() => {});
        return "retry";
    }
    try {
        const data: unknown = await answer.json();
        const list =
            typeof data === "object" && data !== null
                ? (data as Record<string, unknown>)[key]
                : undefined;
        return Array.isArray(list) ? "ok" : "retry";
    } catch {
        return "retry";
    }
}
