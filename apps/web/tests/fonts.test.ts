import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
    FONT_STYLESHEET_URL,
    keepFontStyles,
    responseWithin,
} from "@/lib/fonts";

const css = () => new Response("@font-face{}", { status: 200 });

describe("the font stylesheet", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    test("is the one every page links", () => {
        const layout = readFileSync(
            resolve(__dirname, "../src/layouts/Layout.astro"),
            "utf8",
        );
        expect(layout).toContain("href={FONT_STYLESHEET_URL}");
        expect(layout).not.toContain("fonts.googleapis.com/css");
        expect(FONT_STYLESHEET_URL).toMatch(
            /^https:\/\/fonts\.googleapis\.com\/css2\?.*&display=swap$/,
        );
    });

    test("is kept as the service worker installs", async () => {
        const put = vi.fn(async () => {});
        const fetcher = vi.fn(async () => css());
        await keepFontStyles({ put }, 10_000, fetcher);
        const [request] = put.mock.calls[0] as unknown as [Request];
        expect(request.url).toBe(FONT_STYLESHEET_URL);
        expect(request.mode).toBe("cors");
    });

    test("isn't kept when Google answers with an error", async () => {
        const put = vi.fn(async () => {});
        await keepFontStyles(
            { put },
            10_000,
            vi.fn(async () => new Response("", { status: 503 })),
        );
        expect(put).not.toHaveBeenCalled();
    });

    test("doesn't fail the install offline or on a hanging connection", async () => {
        const put = vi.fn(async () => {});
        await expect(
            keepFontStyles(
                { put },
                10_000,
                vi.fn(async () => {
                    throw new TypeError("Failed to fetch");
                }),
            ),
        ).resolves.toBeUndefined();

        const hanging = keepFontStyles(
            { put },
            10_000,
            vi.fn(
                (_: RequestInfo | URL, init?: RequestInit) =>
                    new Promise<Response>((_, reject) =>
                        init?.signal?.addEventListener("abort", () =>
                            reject(new DOMException("aborted", "AbortError")),
                        ),
                    ),
            ),
        );
        await vi.advanceTimersByTimeAsync(10_000);
        await expect(hanging).resolves.toBeUndefined();
        expect(put).not.toHaveBeenCalled();
    });
});

describe("a page waiting for the stylesheet", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    test("gets it as soon as it comes", async () => {
        const response = css();
        await expect(
            responseWithin(Promise.resolve(response), 3_000),
        ).resolves.toBe(response);
    });

    test("goes on without it after the timeout", async () => {
        let settled: Response | undefined;
        void responseWithin(new Promise(() => {}), 3_000).then(
            (r) => (settled = r),
        );
        await vi.advanceTimersByTimeAsync(2_999);
        expect(settled).toBeUndefined();
        await vi.advanceTimersByTimeAsync(1);
        expect(settled?.type).toBe("error");
    });

    test("goes on without it when there's none to be had", async () => {
        const settled = await responseWithin(
            Promise.reject(new Error("no-response")),
            3_000,
        );
        expect(settled.type).toBe("error");
    });
});
