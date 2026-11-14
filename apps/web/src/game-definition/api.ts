import type {
  GameDefinition,
  GameImportResponse,
} from "@searchlight/shared";

import { startLoadDeadline } from "@/lib/loadDeadline";

// Only for a download that has hung: the largest games take minutes on a slow
// link, and a load stops waiting for one well before (LOAD_TIMEOUT_MS).
const GAME_DOWNLOAD_TIMEOUT_MS = 5 * 60_000;

const API_BASE = (import.meta.env?.PUBLIC_API_BASE ?? (typeof process !== "undefined" ? process.env.PUBLIC_API_BASE : "") ?? "") as string;

function buildApiUrl(pathname: string): URL {
  const base = API_BASE || "http://localhost";
  const full = pathname.startsWith("/") ? `${base}${pathname}` : `${base}/${pathname}`;
  return new URL(full, "http://localhost");
}

export async function importGameDefinitionAPI(
  raw: unknown,
  dryRun = false,
  allowUpdate = false,
  // Only applies when the import creates the game.
  unlisted = false,
  // With allowUpdate: the id of the revision the update was previewed
  // against. The API refuses (409 GAME_CHANGED) if the game has changed since.
  expectedCurrentRevisionId?: string,
): Promise<GameImportResponse> {
  const url = buildApiUrl("/games/import");
  if (dryRun) {
    url.searchParams.set("dryRun", "true");
  }
  if (allowUpdate) {
    url.searchParams.set("allowUpdate", "true");
  }
  if (unlisted) {
    url.searchParams.set("unlisted", "true");
  }
  if (expectedCurrentRevisionId) {
    url.searchParams.set("expectedCurrentRevisionId", expectedCurrentRevisionId);
  }
  const res = await fetch(url.toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    credentials: "include",
    body: typeof raw === "string" ? raw : JSON.stringify(raw),
  });

  if (!res.ok) {
    const errorBody = await res.json().catch(() => ({}));
    throw Object.assign(
      new Error(errorBody.message || `Import failed with status ${res.status}`),
      {
        status: res.status,
        ...errorBody,
      },
    );
  }

  return res.json();
}

/**
 * A game revision, and the JSON it came as (for keeping it as is). A download
 * that hangs fails in the end, so the next load starts a new one (loads of
 * the same revision share one).
 */
export async function fetchGameRevisionJSON(
  gameId: string,
  revision: number | string,
  sessionId?: string,
): Promise<{ definition: GameDefinition; json: string }> {
  const deadline = startLoadDeadline(GAME_DOWNLOAD_TIMEOUT_MS);
  try {
    return await downloadGameRevision(gameId, revision, deadline.signal, sessionId);
  } finally {
    deadline.clear();
  }
}

async function downloadGameRevision(
  gameId: string,
  revision: number | string,
  signal: AbortSignal,
  sessionId?: string,
): Promise<{ definition: GameDefinition; json: string }> {
  const url = buildApiUrl(
    `/games/${encodeURIComponent(gameId)}/revisions/${encodeURIComponent(revision)}`,
  );
  if (sessionId) {
    url.searchParams.set("sessionId", sessionId);
  }
  const res = await fetch(url.toString(), {
    credentials: "include",
    signal,
  });

  if (!res.ok) {
    if (typeof revision === "string" && isNaN(Number(revision))) {
      const directUrl = buildApiUrl(`/games/revisions/${encodeURIComponent(revision)}`);
      if (sessionId) directUrl.searchParams.set("sessionId", sessionId);
      const directRes = await fetch(directUrl.toString(), {
        credentials: "include",
        signal,
      });
      if (directRes.ok) {
        const json = await directRes.text();
        return { definition: JSON.parse(json) as GameDefinition, json };
      }
    }
    throw new Error(`Failed to fetch revision ${revision}: ${res.status}`);
  }

  const json = await res.text();
  return { definition: JSON.parse(json) as GameDefinition, json };
}
