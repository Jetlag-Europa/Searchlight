import { env } from "./env.js";

// The location tracker (searchlight-tracker, a Playwright container outside
// this repo) reads Google Maps location sharing for several Google accounts.

export interface TrackerPerson {
  id: string;
  name: string;
  photoUrl: string | null;
  lat: number;
  lng: number;
  accuracy: number | null;
  timestamp: number | null;
  battery: number | null;
  charging: boolean | null;
}

// GET /people?account= on the tracker.
export interface TrackerState {
  ok: boolean;
  updatedAt: number | null;
  error: string | null;
  people: TrackerPerson[];
}

// GET /accounts on the tracker.
export interface TrackerAccount {
  name: string;
  ok: boolean;
  error: string | null;
  updatedAt: number | null;
  people: number;
}

export async function fetchTracker<T>(path: string): Promise<{ status: number; body: T }> {
  const res = await fetch(new URL(path, env.LOCATION_TRACKER_URL), {
    signal: AbortSignal.timeout(5_000),
  });
  return { status: res.status, body: (await res.json()) as T };
}
