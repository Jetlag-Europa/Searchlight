import type { GameSessionSummary } from "@searchlight/shared";

import { isSessionSummary } from "@/lib/eventQueue";
import { sessionUnavailableStatus } from "@/lib/sessionUnavailable";

const API_BASE = import.meta.env.PUBLIC_API_BASE as string;

export type SessionDetails =
    // The server answered with the session's details.
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
