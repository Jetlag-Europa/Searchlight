import type {
  GameDefinition,
  GameImportResponse,
  GameListing,
  GameRevisionsResponse,
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
  // Listing of a new game; the server's default (listed) when omitted.
  listing?: GameListing,
): Promise<GameImportResponse> {
  const url = buildApiUrl("/games/import");
  if (dryRun) {
    url.searchParams.set("dryRun", "true");
  }
  if (allowUpdate) {
    url.searchParams.set("allowUpdate", "true");
  }
  if (listing) {
    url.searchParams.set("listing", listing);
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

export async function exportGameDefinitionAPI(
  gameId: string,
  sessionId?: string,
): Promise<GameDefinition> {
  const url = buildApiUrl(`/games/${encodeURIComponent(gameId)}/export`);
  if (sessionId) {
    url.searchParams.set("sessionId", sessionId);
  }
  const res = await fetch(url.toString(), {
    credentials: "include",
  });

  if (!res.ok) {
    throw new Error(`Export failed with status ${res.status}`);
  }

  return res.json();
}

export async function fetchGameRevisionsAPI(
  gameId: string,
  sessionId?: string,
): Promise<GameRevisionsResponse> {
  const url = buildApiUrl(`/games/${encodeURIComponent(gameId)}/revisions`);
  if (sessionId) {
    url.searchParams.set("sessionId", sessionId);
  }
  const res = await fetch(url.toString(), {
    credentials: "include",
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch revisions: ${res.status}`);
  }

  return res.json();
}

export async function fetchGameRevisionAPI(
  gameId: string,
  revision: number | string,
  sessionId?: string,
): Promise<GameDefinition> {
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
        return directRes.json();
      }
    }
    throw new Error(`Failed to fetch revision ${revision}: ${res.status}`);
  }

  return res.json();
}
