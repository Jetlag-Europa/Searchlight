import type { EventRecord, PresenceEvent, HiderUpdateEvent, PlanningToggleEvent, PresenceUser } from "@taibled/shared";

type AnySSEEvent = EventRecord | PresenceEvent | HiderUpdateEvent | PlanningToggleEvent;
type Listener = (event: AnySSEEvent) => void;

const listeners = new Map<string, Set<Listener>>();
const presenceMap = new Map<string, Map<string, { user: PresenceUser; count: number }>>();

export function subscribe(sessionId: string, cb: Listener): () => void {
  if (!listeners.has(sessionId)) listeners.set(sessionId, new Set());
  listeners.get(sessionId)!.add(cb);
  return () => {
    listeners.get(sessionId)?.delete(cb);
    if (listeners.get(sessionId)?.size === 0) listeners.delete(sessionId);
  };
}

export function broadcast(sessionId: string, event: AnySSEEvent): void {
  listeners.get(sessionId)?.forEach((cb) => cb(event));
}

export function getPresence(sessionId: string): PresenceUser[] {
  return Array.from(presenceMap.get(sessionId)?.values() ?? []).map((e) => e.user);
}

export function addPresence(sessionId: string, user: PresenceUser): void {
  if (!presenceMap.has(sessionId)) presenceMap.set(sessionId, new Map());
  const sessionPresence = presenceMap.get(sessionId)!;
  const existing = sessionPresence.get(user.userId);
  if (existing) {
    existing.count++;
  } else {
    sessionPresence.set(user.userId, { user, count: 1 });
    broadcast(sessionId, { type: "presence.join", payloadJson: user });
  }
}

export function removePresence(sessionId: string, userId: string): void {
  const sessionPresence = presenceMap.get(sessionId);
  if (!sessionPresence) return;
  const existing = sessionPresence.get(userId);
  if (!existing) return;
  existing.count--;
  if (existing.count <= 0) {
    sessionPresence.delete(userId);
    if (sessionPresence.size === 0) presenceMap.delete(sessionId);
    broadcast(sessionId, { type: "presence.leave", payloadJson: { userId } });
  }
}
