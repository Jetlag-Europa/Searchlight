import { afterEach, describe, expect, test, vi } from "vitest";
import { discord } from "./discord-client.js";

// A minimal Response stand-in: 200 OK, no rate-limit headers, empty member body.
function fakeResponse() {
    return {
        status: 200,
        ok: true,
        headers: { get: () => null },
        json: async () => ({ roles: [], nick: null }),
    } as unknown as Response;
}

describe("discord client — global rate-limit queue", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    test("serializes a burst and meters it to the global rate (no overshoot)", async () => {
        const fetchMock = vi.fn(async () => fakeResponse());
        vi.stubGlobal("fetch", fetchMock);

        const start = Date.now();
        // 60 concurrent calls: the 50-token bucket absorbs the first 50 instantly,
        // the remaining 10 must wait for tokens to accrue at 50/sec (~200 ms).
        await Promise.all(
            Array.from({ length: 60 }, (_, i) =>
                discord.getGuildMember("guild-1", `user-${i}`),
            ),
        );
        const elapsed = Date.now() - start;

        expect(fetchMock).toHaveBeenCalledTimes(60);
        expect(elapsed).toBeGreaterThan(120);
    });
});
