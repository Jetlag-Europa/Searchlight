import type {
  GameDefinition,
  GameImportResponse,
} from "@searchlight/shared";

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

export async function fetchGameRevisionAPI(
  gameId: string,
  revision: number | string,
  sessionId?: string,
): Promise<GameDefinition> {
  return (await fetchGameRevisionJSON(gameId, revision, sessionId)).definition;
}

/** A game revision, and the JSON it came as (for keeping it as is). */
export async function fetchGameRevisionJSON(
  gameId: string,
  revision: number | string,
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
  });

  if (!res.ok) {
    if (typeof revision === "string" && isNaN(Number(revision))) {
      const directUrl = buildApiUrl(`/games/revisions/${encodeURIComponent(revision)}`);
      if (sessionId) directUrl.searchParams.set("sessionId", sessionId);
      const directRes = await fetch(directUrl.toString(), { credentials: "include" });
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
