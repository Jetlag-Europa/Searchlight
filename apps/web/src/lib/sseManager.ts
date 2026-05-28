import type { EventRecord } from "@taibled/shared";
import { questions, syncStatus, connectedUsers } from "@/lib/context";
import type { PresenceUser } from "@/lib/context";
import { strokes } from "@/annotations/hooks/useAnnotationStore";
import { getPendingEvents, getCachedSession, setCachedSession } from "@/lib/eventQueue";
import { suppressNextQuestionSave } from "@/lib/questionSaveSuppress";
import type { StrokeFeature } from "@/annotations/types";
import type { Questions } from "@/maps/schema";

const API_BASE = import.meta.env.PUBLIC_API_BASE as string;

let eventSource: EventSource | null = null;
let currentSessionId: string | null = null;
let lastServerEventAt: string | null = null;
let hadError = false;

function handleServerEvent(event: EventRecord): void {
    console.info("[taibled:sse] received event", {
        type: event.type,
        clientUuid: event.clientUuid,
        userId: event.userId,
        serverReceivedAt: event.serverReceivedAt,
    });

    if (!lastServerEventAt || event.serverReceivedAt > lastServerEventAt) {
        lastServerEventAt = event.serverReceivedAt;
    }

    if (event.type === "stroke.create") {
        const stroke = event.payloadJson as StrokeFeature;
        const current = strokes.get();
        const isDup = !!current.find((s) => s.properties.clientUuid === stroke.properties.clientUuid);
        if (!isDup) {
            console.info("[taibled:sse] applying stroke.create", stroke.properties.clientUuid, `(${current.length} → ${current.length + 1} strokes)`);
            strokes.set([...current, stroke]);
        } else {
            console.info("[taibled:sse] stroke.create is a duplicate, skipping", stroke.properties.clientUuid);
        }
    } else if (event.type === "stroke.delete") {
        const { clientUuid } = event.payloadJson as { clientUuid: string };
        const before = strokes.get().length;
        strokes.set(strokes.get().filter((s) => s.properties.clientUuid !== clientUuid));
        const after = strokes.get().length;
        console.info("[taibled:sse] applying stroke.delete", clientUuid, `(${before} → ${after} strokes)`);
    } else if (event.type === "questions.replace") {
        const pending = currentSessionId ? getPendingEvents(currentSessionId) : [];
        const localPending = pending.filter((e) => e.type === "questions.replace" && e.status === "pending");
        if (localPending.length > 0) {
            console.info("[taibled:sse] questions.replace skipped — local pending replace exists", localPending.length, "pending");
            return;
        }
        const payload = event.payloadJson as { questions: Array<{ payloadJson: unknown }> };
        const newQs = payload.questions.map((q) => q.payloadJson) as unknown as Questions;
        console.info("[taibled:sse] applying questions.replace", newQs.length, "question(s)");
        suppressNextQuestionSave();
        questions.set(newQs);
    } else {
        console.warn("[taibled:sse] unknown event type:", event.type);
    }

    if (currentSessionId) {
        const cached = getCachedSession(currentSessionId);
        if (cached) {
            setCachedSession({ ...cached, lastServerEventAt: lastServerEventAt ?? "" });
            console.info("[taibled:sse] cache updated with lastServerEventAt", lastServerEventAt);
        } else {
            console.info("[taibled:sse] no cache entry to update");
        }
    }
}

function handlePresenceEvent(type: string, payloadJson: unknown): void {
    if (type === "presence.snapshot") {
        const { users } = payloadJson as { users: PresenceUser[] };
        console.info("[taibled:sse] presence.snapshot:", users.length, "user(s)");
        connectedUsers.set(users);
    } else if (type === "presence.join") {
        const user = payloadJson as PresenceUser;
        const current = connectedUsers.get();
        if (!current.find((u) => u.userId === user.userId)) {
            console.info("[taibled:sse] presence.join:", user.displayName);
            connectedUsers.set([...current, user]);
        }
    } else if (type === "presence.leave") {
        const { userId } = payloadJson as { userId: string };
        console.info("[taibled:sse] presence.leave:", userId);
        connectedUsers.set(connectedUsers.get().filter((u) => u.userId !== userId));
    }
}

async function gapFill(sessionId: string): Promise<void> {
    if (!lastServerEventAt) {
        console.info("[taibled:sse] gap fill skipped — no lastServerEventAt");
        return;
    }
    const url = `${API_BASE}/sessions/${sessionId}/events?since=${encodeURIComponent(lastServerEventAt)}`;
    console.info("[taibled:sse] gap fill fetch", url);
    try {
        const res = await fetch(url, { credentials: "include" });
        if (!res.ok) {
            console.warn("[taibled:sse] gap fill fetch failed:", res.status);
            return;
        }
        const { events } = (await res.json()) as { events: EventRecord[] };
        console.info("[taibled:sse] gap fill received", events.length, "event(s)");
        for (const event of events) {
            handleServerEvent(event);
        }
    } catch (err) {
        console.warn("[taibled:sse] gap fill error:", err);
    }
}

export function startSSE(sessionId: string): void {
    console.info("[taibled:sse] startSSE called for session", sessionId);
    stopSSE();
    currentSessionId = sessionId;

    const cached = getCachedSession(sessionId);
    lastServerEventAt = cached?.lastServerEventAt || null;
    console.info("[taibled:sse] lastServerEventAt from cache:", lastServerEventAt);

    const url = `${API_BASE}/sessions/${sessionId}/stream`;
    console.info("[taibled:sse] opening EventSource →", url);

    const source = new EventSource(url, { withCredentials: true });
    eventSource = source;

    source.onopen = () => {
        console.info("[taibled:sse] connection opened, readyState:", source.readyState);
        syncStatus.set("live");
        if (hadError) {
            console.info("[taibled:sse] reconnected after error — triggering gap fill");
            hadError = false;
            gapFill(sessionId).catch((err) => console.warn("[taibled:sse] gap fill threw:", err));
        }
    };

    source.onmessage = (e: MessageEvent) => {
        console.info("[taibled:sse] raw message received, length:", (e.data as string).length);
        try {
            const parsed = JSON.parse(e.data as string) as { type: string; payloadJson: unknown };
            if (parsed.type.startsWith("presence.")) {
                handlePresenceEvent(parsed.type, parsed.payloadJson);
                return;
            }
            handleServerEvent(parsed as unknown as EventRecord);
        } catch (err) {
            console.warn("[taibled:sse] failed to parse SSE message:", err, "raw:", e.data);
        }
    };

    source.onerror = (e) => {
        console.warn("[taibled:sse] connection error, readyState:", source.readyState, e);
        hadError = true;
        if (syncStatus.get() === "live") {
            syncStatus.set("synced");
            console.info("[taibled:sse] status reverted to synced");
        }
    };
}

export function stopSSE(): void {
    if (eventSource) {
        console.info("[taibled:sse] stopSSE — closing EventSource for session", currentSessionId);
        eventSource.close();
        eventSource = null;
    }
    if (syncStatus.get() === "live") syncStatus.set("synced");
    connectedUsers.set([]);
    currentSessionId = null;
    lastServerEventAt = null;
    hadError = false;
}
