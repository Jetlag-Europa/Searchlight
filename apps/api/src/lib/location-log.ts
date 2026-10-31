import type { FastifyBaseLogger } from "fastify";
import prisma from "./prisma.js";
import { env } from "./env.js";
import { fetchTracker, type TrackerAccount, type TrackerState } from "./location-tracker.js";

// Stores every position the location tracker reads, for every account, whether
// or not anyone has the map open, and deletes rows older than
// LOCATION_LOG_DAYS. The tracker reads Google every 2 minutes; asking it every
// minute misses none of them.
const POLL_MS = 60_000;
const PRUNE_MS = 60 * 60_000;

async function recordPositions(log: FastifyBaseLogger): Promise<void> {
  let accounts: TrackerAccount[];
  try {
    accounts = (await fetchTracker<TrackerAccount[]>("/accounts")).body;
  } catch (err) {
    log.warn({ err }, "Location log: tracker unreachable");
    return;
  }
  for (const { name: account, ok } of accounts) {
    if (!ok) continue;
    try {
      const { body } = await fetchTracker<TrackerState>(`/people?account=${encodeURIComponent(account)}`);
      const rows = body.people
        .filter((p) => p.timestamp && Number.isFinite(p.lat) && Number.isFinite(p.lng))
        .map((p) => ({
          account,
          personId: p.id,
          name: p.name,
          lat: p.lat,
          lng: p.lng,
          accuracy: p.accuracy,
          battery: p.battery === null ? null : Math.round(p.battery),
          charging: p.charging,
          recordedAt: new Date(p.timestamp!),
        }));
      // A position the phone hasn't updated has the same recordedAt: skipped.
      if (rows.length) await prisma.locationLog.createMany({ data: rows, skipDuplicates: true });
    } catch (err) {
      log.warn({ err, account }, "Location log: couldn't record positions");
    }
  }
}

async function prune(log: FastifyBaseLogger): Promise<void> {
  try {
    const before = new Date(Date.now() - env.LOCATION_LOG_DAYS * 24 * 60 * 60_000);
    const { count } = await prisma.locationLog.deleteMany({ where: { recordedAt: { lt: before } } });
    if (count) log.info({ count }, "Location log: deleted old positions");
  } catch (err) {
    log.warn({ err }, "Location log: couldn't delete old positions");
  }
}

/** Starts recording. The timers don't keep the process alive. */
export function startLocationLog(log: FastifyBaseLogger): void {
  let running = false;
  const record = () => {
    // A slow round (tracker or database) mustn't overlap the next one.
    if (running) return;
    running = true;
    void recordPositions(log).finally(() => (running = false));
  };
  record();
  void prune(log);
  setInterval(record, POLL_MS).unref();
  setInterval(() => void prune(log), PRUNE_MS).unref();
}
