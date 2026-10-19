// Checks the result of the one-off legacy session import
// (scripts/legacy-import/README.md) with the app's own code. Skipped unless
// LEGACY_IMPORT_CHECK names an export of the imported sessions:
//
//   LEGACY_IMPORT_CHECK=/path/imported.json pnpm --filter web exec vitest run tests/legacyImportCheck.test.ts
//
// Every question must parse, be offered by its session's pinned revision and
// evaluate against the play area without an error (measuring questions need a
// browser, so they are only counted); every tentacle answer must
// name one of its layer's sites. Sessions with a hider position also report
// how many questions rule the hider out.
import { readFileSync, writeFileSync } from "node:fs";

import * as turf from "@turf/turf";
import type { FeatureCollection, Point } from "geojson";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/maps/geo-utils", async (importActual) => {
    const actual = await importActual<typeof import("@/maps/geo-utils")>();
    return {
        ...actual,
        arcBuffer: async (
            fc: FeatureCollection<Point>,
            radius: number,
            unit: turf.Units,
        ) => turf.buffer(fc.features[0], radius, { units: unit }),
    };
});

import { compiledGameAtom, isQuestionSupported } from "@/game-definition/store";
import { applyGameDefinition, resetGameState } from "@/lib/games";
import { standaloneRegion } from "@/maps";
import { featuresMatch } from "@/maps/questions/operators/tentacle";
import { questionSchema } from "@/maps/schema";

const file = process.env.LEGACY_IMPORT_CHECK;

interface Imported {
    revisions: Record<string, { gameKey: string; revision: number; definition: any }>;
    sessions: { id: string; revisionId: string; hider: [number, number] | null; questions: any[] }[];
    snapshots: { id: string; revisionId: string; questions: any[] }[];
}

function regionContains(region: any, point: [number, number]): boolean {
    return (region?.features ?? []).some(
        (f: any) =>
            (f.geometry?.type === "Polygon" || f.geometry?.type === "MultiPolygon") &&
            turf.booleanPointInPolygon(point, f),
    );
}

describe.skipIf(!file)("legacy import", () => {
    beforeAll(() => {
        vi.stubGlobal("sessionStorage", {
            getItem: () => null,
            setItem: () => {},
            removeItem: () => {},
        });
    });
    afterAll(() => {
        resetGameState();
        vi.unstubAllGlobals();
    });

    it("leaves only questions the app can show and answer", { timeout: 3_600_000 }, async () => {
        const data: Imported = JSON.parse(readFileSync(file!, "utf8"));
        const problems: string[] = [];
        const perGame: Record<
            string,
            {
                questions: number;
                measuringNotEvaluated: number;
                empty: number;
                slowest: number;
                hiderChecked: number;
                hiderOut: number;
            }
        > = {};
        const hiderOut: string[] = [];
        const empty: string[] = [];

        const work = [
            ...data.sessions.map((s) => ({ kind: "session", ...s })),
            ...data.snapshots.map((s) => ({ kind: "snapshot", hider: null, ...s })),
        ].sort((a, b) => a.revisionId.localeCompare(b.revisionId));

        let current: string | undefined;
        for (const item of work) {
            const rev = data.revisions[item.revisionId];
            if (!rev) {
                problems.push(`${item.kind} ${item.id}: revision ${item.revisionId} not exported`);
                continue;
            }
            if (current !== item.revisionId) {
                resetGameState();
                applyGameDefinition(rev.definition);
                current = item.revisionId;
            }
            const compiled = compiledGameAtom.get()!;
            const stats = (perGame[`${rev.gameKey}@${rev.revision}`] ??= {
                questions: 0,
                measuringNotEvaluated: 0,
                empty: 0,
                slowest: 0,
                hiderChecked: 0,
                hiderOut: 0,
            });

            for (const [index, raw] of item.questions.entries()) {
                const where = `${item.kind} ${item.id} #${index} ${raw?.id}:${raw?.data?.type ?? raw?.data?.locationType ?? ""}`;
                stats.questions++;
                const parsed = questionSchema.safeParse(raw);
                if (!parsed.success) {
                    problems.push(`${where}: doesn't parse: ${parsed.error.issues[0]?.message}`);
                    continue;
                }
                const question = parsed.data;
                if (!isQuestionSupported(question, compiled)) {
                    problems.push(`${where}: not offered by ${rev.gameKey} revision ${rev.revision}`);
                    continue;
                }
                if (question.id === "tentacles" && question.data.location && question.data.locationType !== "custom") {
                    const def = compiled.questionMap.get(question.data.locationType) as any;
                    const sites = compiled.datasets[def?.evaluator?.source?.datasetId]?.features?.features ?? [];
                    if (!sites.some((site: unknown) => featuresMatch(site, question.data.location))) {
                        problems.push(`${where}: tentacle answer matches no site`);
                    }
                }
                // Measuring buffers use ArcGIS's WASM operators, which don't
                // run under Node; check those in a browser.
                if (question.id === "measuring") {
                    stats.measuringNotEvaluated++;
                    continue;
                }
                const started = performance.now();
                let region;
                try {
                    region = await standaloneRegion(question, compiled.playArea);
                } catch (err) {
                    problems.push(`${where}: evaluation failed: ${(err as Error).message}`);
                    continue;
                }
                stats.slowest = Math.max(stats.slowest, Math.round(performance.now() - started));
                if (!region?.features?.length) {
                    stats.empty++;
                    empty.push(where);
                }
                if (item.hider) {
                    stats.hiderChecked++;
                    if (!regionContains(region, item.hider)) {
                        stats.hiderOut++;
                        hiderOut.push(where);
                    }
                }
            }
        }

        const summary = { problems, perGame, hiderOut, empty };
        if (process.env.LEGACY_IMPORT_CHECK_OUT) {
            writeFileSync(process.env.LEGACY_IMPORT_CHECK_OUT, JSON.stringify(summary, null, 2));
        }
        expect(problems).toEqual([]);
    });
});
