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
  // logged_out: Google ended the login, and the tracker leaves the account
  // alone until new cookies are uploaded.
  status: "starting" | "ok" | "error" | "logged_out";
  ok: boolean;
  error: string | null;
  updatedAt: number | null;
  // The Google account it's signed in as; null when logged out or unknown.
  signedInAs: string | null;
  loggedOutAt: number | null;
  cookiesUpdatedAt: number | null;
  people: number;
}

export async function fetchTracker<T>(path: string): Promise<{ status: number; body: T }> {
  const res = await fetch(new URL(path, env.LOCATION_TRACKER_URL), {
    signal: AbortSignal.timeout(5_000),
  });
  return { status: res.status, body: (await res.json()) as T };
}

// PUT /accounts/:name/cookies on the tracker: it checks the export, saves it
// and restarts the account with it. 400 carries a message for people.
export async function putTrackerCookies(
  account: string,
  cookies: string,
): Promise<{ status: number; body: { ok?: boolean; error?: string } }> {
  const res = await fetch(new URL(`/accounts/${encodeURIComponent(account)}/cookies`, env.LOCATION_TRACKER_URL), {
    method: "PUT",
    body: cookies,
    signal: AbortSignal.timeout(10_000),
  });
  return { status: res.status, body: (await res.json()) as { ok?: boolean; error?: string } };
}
