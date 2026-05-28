import type { EventRecord } from "@taibled/shared";

type Listener = (event: EventRecord) => void;
const listeners = new Map<string, Set<Listener>>();

export function subscribe(sessionId: string, cb: Listener): () => void {
  if (!listeners.has(sessionId)) listeners.set(sessionId, new Set());
  listeners.get(sessionId)!.add(cb);
  return () => {
    listeners.get(sessionId)?.delete(cb);
    if (listeners.get(sessionId)?.size === 0) listeners.delete(sessionId);
  };
}

export function broadcast(sessionId: string, event: EventRecord): void {
  listeners.get(sessionId)?.forEach((cb) => cb(event));
}
