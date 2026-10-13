import type { EventRecord, PresenceEvent, HiderUpdateEvent, PlanningToggleEvent, PresenceUser, SessionRevisionUpgradedEvent } from "@searchlight/shared";

type AnySSEEvent = EventRecord | PresenceEvent | HiderUpdateEvent | PlanningToggleEvent | SessionRevisionUpgradedEvent;
type Listener = (event: AnySSEEvent) => void;

const listeners = new Map<string, Set<Listener>>();
const presenceMap = new Map<string, Map<string, { user: PresenceUser; count: number }>>();
const userStreams = new Map<string, Map<string, Set<() => void>>>();
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

export function registerUserStream(
  sessionId: string,
  userId: string,
  closeStream: () => void,
): () => void {
  if (!userStreams.has(sessionId)) userStreams.set(sessionId, new Map());
  const sessionStreams = userStreams.get(sessionId)!;
  if (!sessionStreams.has(userId)) sessionStreams.set(userId, new Set());
  const streamSet = sessionStreams.get(userId)!;
  streamSet.add(closeStream);

  return () => {
    streamSet.delete(closeStream);
    if (streamSet.size === 0) {
      sessionStreams.delete(userId);
    }
    if (sessionStreams.size === 0) {
      userStreams.delete(sessionId);
    }
  };
}

export function closeUserStreams(sessionId: string, userId: string): void {
  const sessionStreams = userStreams.get(sessionId);
  if (!sessionStreams) return;
  const streamSet = sessionStreams.get(userId);
  if (!streamSet) return;
  const closers = Array.from(streamSet);
  streamSet.clear();
  sessionStreams.delete(userId);
  if (sessionStreams.size === 0) {
    userStreams.delete(sessionId);
  }
  for (const close of closers) {
    try {
      close();
    } catch {
      // ignore
    }
  }
}

export function closeSessionStreams(sessionId: string): void {
  const sessionStreams = userStreams.get(sessionId);
  if (!sessionStreams) return;
  const allClosers: Array<() => void> = [];
  for (const streamSet of sessionStreams.values()) {
    allClosers.push(...streamSet);
  }
  userStreams.delete(sessionId);
  for (const close of allClosers) {
    try {
      close();
    } catch {
      // ignore
    }
  }
}
