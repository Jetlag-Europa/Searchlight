import { describe, expect, test } from "vitest";

import {
    geometryFallbackChunks,
    type OutputChunk,
} from "@/lib/geometryFallbackChunks";

const FALLBACK = "/src/maps/geo-utils/bufferGeometry.ts";
const LOADER = "/src/maps/geo-utils/geometryClient.ts";

const chunk = (
    fileName: string,
    {
        isEntry = false,
        imports = [] as string[],
        dynamicImports = [] as string[],
        moduleIds = [] as string[],
    } = {},
): OutputChunk => ({ fileName, isEntry, imports, dynamicImports, moduleIds });

// As the build has it: a page loads the client, which loads the fallback on
// demand; the fallback loads ArcGIS's operators, which import back from it
// and share a chunk with the page.
const build = () => [
    chunk("page.js", { isEntry: true, imports: ["client.js"] }),
    chunk("client.js", {
        imports: ["shared.js"],
        dynamicImports: ["fallback.js"],
        moduleIds: [`/app${LOADER}`],
    }),
    chunk("fallback.js", {
        imports: ["shared.js"],
        dynamicImports: ["operator.js"],
        moduleIds: [`/app${FALLBACK}`],
    }),
    chunk("operator.js", { imports: ["fallback.js", "label.js", "shared.js"] }),
    chunk("label.js"),
    chunk("shared.js"),
];

describe("the chunks only the geometry fallback needs", () => {
    test("are the fallback's own, but not what pages share with it", () => {
        expect(geometryFallbackChunks(build(), FALLBACK, LOADER)).toEqual(
            new Set(["fallback.js", "operator.js", "label.js"]),
        );
    });

    test("are none when the build has no fallback", () => {
        const chunks = build().filter((c) => c.fileName !== "fallback.js");
        expect(geometryFallbackChunks(chunks, FALLBACK, LOADER).size).toBe(0);
    });

    test("can't be imported statically by a page", () => {
        const chunks = build();
        chunks[0].imports.push("fallback.js");
        expect(() => geometryFallbackChunks(chunks, FALLBACK, LOADER)).toThrow(
            "page.js imports fallback.js statically",
        );
        // Or through a chunk that does.
        const through = build();
        through[0].imports.push("operator.js");
        expect(() => geometryFallbackChunks(through, FALLBACK, LOADER)).toThrow(
            "operator.js imports fallback.js statically",
        );
    });

    test("can't be merged into a chunk the pages share", () => {
        const chunks = build();
        chunks
            .find((c) => c.fileName === "shared.js")
            ?.moduleIds.push(`C:\\app${FALLBACK.replaceAll("/", "\\")}`);
        expect(() => geometryFallbackChunks(chunks, FALLBACK, LOADER)).toThrow(
            "client.js imports shared.js statically",
        );
    });

    test("can't be an entry", () => {
        const chunks = build();
        chunks[2].isEntry = true;
        expect(() => geometryFallbackChunks(chunks, FALLBACK, LOADER)).toThrow(
            "fallback.js is an entry",
        );
    });

    test("can only be loaded on demand by the geometry client", () => {
        const chunks = build();
        chunks.push(
            chunk("other.js", {
                isEntry: true,
                dynamicImports: ["fallback.js"],
            }),
        );
        expect(() => geometryFallbackChunks(chunks, FALLBACK, LOADER)).toThrow(
            "other.js imports fallback.js, not through",
        );
    });
});
