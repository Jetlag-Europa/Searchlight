import type { UsageEvent } from "@searchlight/shared";

const API_BASE = (import.meta.env.PUBLIC_API_BASE ?? "") as string;

/** Adds one to the event's count on the admin page. Dropped when offline. */
export function countUsage(event: UsageEvent): void {
  fetch(`${API_BASE}/usage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event }),
    // The Creator's handoffs can navigate away right after counting.
    keepalive: true,
  }).catch(() => {});
}
