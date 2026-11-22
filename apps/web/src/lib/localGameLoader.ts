import {
  type GameDefinition,
  validateGameDefinition,
  type ValidationIssue,
} from "@searchlight/shared";

import { compileGameDefinition } from "@/game-definition/compile";

/** Same 50 MB upper bound as the API's game import endpoint. */
export const MAX_LOCAL_GAME_BYTES = 50 * 1024 * 1024;
const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

export type LocalGameParseResult =
  | { ok: true; definition: GameDefinition }
  | { ok: false; error: string; issues?: ValidationIssue[] };

/**
 * Parses, validates, and test-compiles a raw JSON string into a GameDefinition.
 * Mirrors GameImporter's lenient handling of a missing `serverId` so
 * hand-authored or local-only files work without needing a Discord server ID.
 */
export function parseAndValidateLocalGame(text: string): LocalGameParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err: unknown) {
    const message = err instanceof Error && err.message ? err.message : "Invalid JSON";
    return { ok: false, error: `Not valid JSON: ${message}` };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "Game file must be a JSON object." };
  }

  const candidate: Record<string, unknown> = {
    ...(parsed as Record<string, unknown>),
  };
  if (!candidate.serverId) {
    candidate.serverId = "home-games";
  }

  const validation = validateGameDefinition(candidate);
  if (!validation.valid) {
    const first = validation.errors[0];
    const summary = first
      ? `${first.message}${first.path && first.path !== "/" ? ` (${first.path})` : ""}`
      : "Game definition failed validation.";
    return {
      ok: false,
      error:
        validation.errors.length > 1
          ? `${summary} (+${validation.errors.length - 1} more)`
          : summary,
      issues: validation.errors.slice(0, 10),
    };
  }

  const definition = candidate as GameDefinition;
  try {
    compileGameDefinition(definition);
  } catch (err: unknown) {
    const message =
      err instanceof Error && err.message ? err.message : "Could not compile game definition";
    return { ok: false, error: `The app can't load this game: ${message}` };
  }

  return { ok: true, definition };
}

/**
 * Validates an external URL for loading a static `game.json`.
 * Only allows `https:` (and `http:` for loopback dev hosts), with no embedded
 * credentials.
 */
export function validateExternalGameUrl(
  raw: string,
): { ok: true; url: URL } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: false, error: "Enter a URL to a .game.json file." };
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, error: "That doesn't look like a valid URL." };
  }
  const isLoopback =
    url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback)) {
    return {
      ok: false,
      error: "Only https:// URLs are supported.",
    };
  }
  if (url.username || url.password) {
    return {
      ok: false,
      error: "URLs with embedded credentials are not allowed.",
    };
  }
  return { ok: true, url };
}

/**
 * Reads a response body as UTF-8 text while enforcing a hard byte limit so an
 * unexpectedly huge remote resource cannot exhaust browser memory.
 */
async function readBoundedText(res: Response, maxBytes: number): Promise<string> {
  const contentLength = Number(res.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error(`File is too large (limit is ${Math.round(maxBytes / (1024 * 1024))} MB).`);
  }

  if (!res.body) {
    const text = await res.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw new Error(`File is too large (limit is ${Math.round(maxBytes / (1024 * 1024))} MB).`);
    }
    return text;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let totalBytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        void reader.cancel().catch(() => {});
        throw new Error(`File is too large (limit is ${Math.round(maxBytes / (1024 * 1024))} MB).`);
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
}

async function fetchTextWithTimeout(
  url: string,
  {
    maxBytes = MAX_LOCAL_GAME_BYTES,
    timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
    signal,
    corsHint = false,
  }: {
    maxBytes?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
    corsHint?: boolean;
  } = {},
): Promise<{ ok: true; text: string } | { ok: false; error: string; status?: number }> {
  const controller = new AbortController();
  let timedOut = false;
  const onExternalAbort = () => controller.abort();
  if (signal?.aborted) {
    controller.abort();
  } else {
    signal?.addEventListener("abort", onExternalAbort, { once: true });
  }
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const res = await fetch(url, {
      method: "GET",
      mode: "cors",
      credentials: "omit",
      signal: controller.signal,
    });
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error:
          res.status === 404
            ? "File not found (404)."
            : `Server responded with HTTP ${res.status}.`,
      };
    }
    const text = await readBoundedText(res, maxBytes);
    return { ok: true, text };
  } catch (err: unknown) {
    if (timedOut) {
      return { ok: false, error: "Request timed out. Try again." };
    }
    if (signal?.aborted) {
      return { ok: false, error: "Cancelled." };
    }
    if (err instanceof Error && err.message.startsWith("File is too large")) {
      return { ok: false, error: err.message };
    }
    return {
      ok: false,
      error: corsHint
        ? "Couldn't download that URL. Make sure you're online and the host allows cross-origin requests (CORS), or download the file and drop it here instead."
        : "Couldn't reach Searchlight. Check your connection and try again.",
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onExternalAbort);
  }
}

export async function loadLocalGameFromFile(file: File): Promise<LocalGameParseResult> {
  if (file.size > MAX_LOCAL_GAME_BYTES) {
    return {
      ok: false,
      error: `File is too large (limit is ${Math.round(MAX_LOCAL_GAME_BYTES / (1024 * 1024))} MB).`,
    };
  }
  let text: string;
  try {
    text = await file.text();
  } catch (err: unknown) {
    const message = err instanceof Error && err.message ? err.message : "Read error";
    return { ok: false, error: `Couldn't read file: ${message}` };
  }
  return parseAndValidateLocalGame(text);
}

export async function loadLocalGameFromUrl(
  rawUrl: string,
  signal?: AbortSignal,
): Promise<LocalGameParseResult & { url?: string }> {
  const validated = validateExternalGameUrl(rawUrl);
  if (!validated.ok) return validated;
  const fetched = await fetchTextWithTimeout(validated.url.href, {
    signal,
    corsHint: true,
  });
  if (!fetched.ok) return fetched;
  const parsed = parseAndValidateLocalGame(fetched.text);
  return parsed.ok ? { ...parsed, url: validated.url.href } : parsed;
}

export async function loadLocalGameFromLink(
  apiBase: string,
  token: string,
  signal?: AbortSignal,
): Promise<LocalGameParseResult & { invalidLink?: boolean }> {
  const url = `${apiBase}/game-links/${encodeURIComponent(token)}/definition`;
  const fetched = await fetchTextWithTimeout(url, {
    signal,
    corsHint: false,
  });
  if (!fetched.ok) {
    if (fetched.status === 404) {
      return {
        ok: false,
        invalidLink: true,
        error: "This game link is invalid or has been revoked.",
      };
    }
    return fetched;
  }
  return parseAndValidateLocalGame(fetched.text);
}
