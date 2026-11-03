import type { GameSessionSummary } from "@searchlight/shared";

import { sessionUnavailableStatus } from "@/lib/sessionUnavailable";

const API_BASE = import.meta.env.PUBLIC_API_BASE as string;

// A request that hangs on a bad connection mustn't hold up the next try.
export const PROBE_TIMEOUT_MS = 8_000;

export type SessionProbe =
    // Everything a load reads answered: load it.
    | { kind: "ready"; session: GameSessionSummary }
    // The session is gone or closed to this user (see sessionUnavailableStatus).
    | { kind: "unavailable"; status: 403 | 404 }
    | { kind: "signedOut" }
    // Anything else: a 5xx, no network, a route this API doesn't have.
    | { kind: "retry" };

const RETRY: SessionProbe = { kind: "retry" };

/**
 * Whether the session would load now, without loading it: its details, then
 * its strokes and questions, as loadSessionContent reads them. Only reads:
 * nothing is cached or shown. The event cursor isn't asked for, as a load
 * goes on without it.
 */
export async function probeSession(sessionId: string): Promise<SessionProbe> {
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
): Promise<SessionProbe> {
    const read = (path: string) =>
        fetch(`${API_BASE}/sessions/${sessionId}${path}`, {
            credentials: "include",
            signal,
        });
    let res: Response;
    try {
        res = await read("");
    } catch {
        return RETRY;
    }
    if (res.status === 401) return { kind: "signedOut" };
    if (!res.ok) {
        const status = await sessionUnavailableStatus(res);
        return status === null ? RETRY : { kind: "unavailable", status };
    }
    let session: GameSessionSummary;
    try {
        session = (await res.json()) as GameSessionSummary;
    } catch {
        return RETRY;
    }
    try {
        const content = await Promise.all([
            read("/strokes").then((answer) => usableList(answer, "strokes")),
            read("/questions").then((answer) =>
                usableList(answer, "questions"),
            ),
        ]);
        if (content.includes("signedOut")) return { kind: "signedOut" };
        return content.every((part) => part === "ok")
            ? { kind: "ready", session }
            : RETRY;
    } catch {
        return RETRY;
    }
}

/**
 * Whether a content answer is one the load can use: OK, and JSON whose
 * `key` is a list of entries, as loadStrokesFromServer and fetchQuestions
 * read it.
 */
async function usableList(
    answer: Response,
    key: "strokes" | "questions",
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
        return Array.isArray(list) &&
            list.every((entry) => typeof entry === "object" && entry !== null)
            ? "ok"
            : "retry";
    } catch {
        return "retry";
    }
}
