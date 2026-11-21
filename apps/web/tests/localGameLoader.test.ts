import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  loadLocalGameFromLink,
  loadLocalGameFromUrl,
  MAX_LOCAL_GAME_BYTES,
  parseAndValidateLocalGame,
  validateExternalGameUrl,
} from "@/lib/localGameLoader";

const parisText = readFileSync(
  new URL("./fixtures/games/paris-2026.game.json", import.meta.url),
  "utf8",
);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseAndValidateLocalGame", () => {
  it("accepts a valid game definition", () => {
    const result = parseAndValidateLocalGame(parisText);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.definition.name).toBeTruthy();
    }
  });

  it("fills a default serverId when a local game file omits it", () => {
    const parsed = JSON.parse(parisText);
    delete parsed.serverId;
    const result = parseAndValidateLocalGame(JSON.stringify(parsed));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.definition.serverId).toBe("home-games");
    }
  });

  it("rejects malformed JSON and schema-invalid definitions with clear messages", () => {
    expect(parseAndValidateLocalGame("{not json")).toMatchObject({
      ok: false,
      error: expect.stringContaining("Not valid JSON"),
    });
    expect(parseAndValidateLocalGame("[]")).toMatchObject({
      ok: false,
      error: expect.stringContaining("JSON object"),
    });
    const bad = parseAndValidateLocalGame(JSON.stringify({ name: "Empty" }));
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.issues?.length).toBeGreaterThan(0);
    }
  });
});

describe("validateExternalGameUrl", () => {
  it("allows https URLs and http loopback URLs", () => {
    expect(validateExternalGameUrl("https://example.com/game.json").ok).toBe(true);
    expect(validateExternalGameUrl("http://localhost:8080/game.json").ok).toBe(true);
    expect(validateExternalGameUrl("http://127.0.0.1:8080/game.json").ok).toBe(true);
  });

  it("rejects remote http, non-http protocols, and embedded credentials", () => {
    expect(validateExternalGameUrl("http://example.com/game.json").ok).toBe(false);
    expect(validateExternalGameUrl("javascript:alert(1)").ok).toBe(false);
    expect(validateExternalGameUrl("file:///etc/passwd").ok).toBe(false);
    expect(validateExternalGameUrl("https://user:pass@example.com/game.json").ok).toBe(false);
  });
});

describe("loadLocalGameFromUrl", () => {
  it("downloads and validates a remote game.json", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(parisText, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await loadLocalGameFromUrl(
      "https://raw.githubusercontent.com/org/repo/main/paris.game.json",
    );
    expect(result.ok).toBe(true);
  });

  it("rejects responses whose Content-Length exceeds MAX_LOCAL_GAME_BYTES", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", {
        status: 200,
        headers: {
          "Content-Length": String(MAX_LOCAL_GAME_BYTES + 1),
        },
      }),
    );

    const result = await loadLocalGameFromUrl("https://example.com/huge.game.json");
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("too large"),
    });
  });

  it("returns a helpful CORS hint when fetch rejects with a network error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Failed to fetch"));

    const result = await loadLocalGameFromUrl("https://drive.google.com/file/d/123");
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("CORS"),
    });
  });
});

describe("loadLocalGameFromLink", () => {
  it("fetches /game-links/:token/definition and marks 404 as invalidLink", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(parisText, { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));

    const ok = await loadLocalGameFromLink("https://api.test", "tok123");
    expect(ok.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://api.test/game-links/tok123/definition",
      expect.objectContaining({ credentials: "omit" }),
    );

    const missing = await loadLocalGameFromLink("https://api.test", "bad");
    expect(missing).toMatchObject({
      ok: false,
      invalidLink: true,
    });
  });
});
