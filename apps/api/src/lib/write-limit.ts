import { isAdmin } from "./permissions.js";

// Uploads and game changes parse, validate and store multi-MB definitions, and
// anyone in one of the registered servers may send them. One API instance, so
// memory will do. Tests lower these.
export const WRITE_LIMIT = {
  requests: 60,
  windowMs: 10 * 60_000,
  inFlightPerUser: 2,
  inFlightTotal: 8,
};

const recent = new Map<string, number[]>();
const inFlight = new Map<string, number>();
let inFlightTotal = 0;

function rateLimited(message: string) {
  return Object.assign(new Error(message), { statusCode: 429, code: "RATE_LIMITED" });
}

/** Throws 429 once a non-admin made WRITE_LIMIT.requests uploads or changes in the window. */
export function assertWithinWriteLimit(userId: string): void {
  if (isAdmin(userId)) return;
  const now = Date.now();
  for (const [id, times] of recent) {
    if (now - times[times.length - 1] >= WRITE_LIMIT.windowMs) recent.delete(id);
  }
  const times = (recent.get(userId) ?? []).filter((t) => now - t < WRITE_LIMIT.windowMs);
  if (times.length >= WRITE_LIMIT.requests) {
    const minutes = Math.ceil((times[0] + WRITE_LIMIT.windowMs - now) / 60_000);
    throw rateLimited(
      `Too many uploads or changes in a short time. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`,
    );
  }
  times.push(now);
  recent.set(userId, times);
}

/**
 * Takes one of the slots for requests that parse whole definitions, or throws
 * 429. Admins have no cap of their own but use the shared ones. The returned
 * release may be called any number of times.
 */
export function acquireUploadSlot(userId: string): () => void {
  const own = inFlight.get(userId) ?? 0;
  if (!isAdmin(userId) && own >= WRITE_LIMIT.inFlightPerUser) {
    throw rateLimited(
      "Another upload is still being processed. Wait for it to finish and try again.",
    );
  }
  if (inFlightTotal >= WRITE_LIMIT.inFlightTotal) {
    throw rateLimited("Searchlight is processing many uploads right now. Try again in a minute.");
  }
  inFlight.set(userId, own + 1);
  inFlightTotal++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    inFlightTotal--;
    const left = inFlight.get(userId)! - 1;
    if (left > 0) inFlight.set(userId, left);
    else inFlight.delete(userId);
  };
}

// For tests.
export function resetWriteLimits(): void {
  recent.clear();
  inFlight.clear();
  inFlightTotal = 0;
}
