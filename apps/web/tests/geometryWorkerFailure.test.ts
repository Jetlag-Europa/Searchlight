// A geometry worker that fails takes every pending calculation with it. That
// isn't the question's doing: the map must show its error, not a board that
// silently leaves the question's answer out.
import * as turf from "@turf/turf";
import { afterAll, describe, expect, it, vi } from "vitest";

// Take the browser path: a stand-in Worker, whose first message makes it fail
// and whose replacements do the geometry on this thread.
const worker = vi.hoisted(() => {
    const state = { failNext: true, started: 0, terminated: 0 };
    vi.stubGlobal(
        "Worker",
        class {
            onmessage?: (event: { data: unknown }) => void;
            onerror?: (event: unknown) => void;
            constructor() {
                state.started++;
            }
            terminate() {
                state.terminated++;
            }
            postMessage({ id, request }: any) {
                queueMicrotask(async () => {
                    if (state.failNext) {
                        state.failNext = false;
                        this.onerror?.(new Error("worker crashed"));
                        return;
                    }
                    const result =
                        request.kind === "clip"
                            ? await calculateClip(request)
                            : turf.buffer(
                                  request.geometry.features[0],
                                  request.distance,
                                  { units: request.unit },
                              );
                    this.onmessage?.({ data: { id, result } });
                });
            }
        },
    );
    return state;
});

import { setActiveGameDefinition } from "@/game-definition/store";
import { computePerQuestionRegions } from "@/maps";
import { GeometryWorkerError } from "@/maps/geo-utils";
import { calculateClip } from "@/maps/geo-utils/clipGeometry";

afterAll(() => {
    setActiveGameDefinition(null);
    vi.unstubAllGlobals();
});

describe("a geometry worker failure", () => {
    it("stops the map refresh instead of ignoring a valid radar", async () => {
        const base = turf.featureCollection([
            turf.bboxPolygon([17, 58, 19, 60]),
        ]);
        setActiveGameDefinition({
            id: "worker-failure",
            name: "Worker failure",
            serverId: "home-games",
            radars: true,
            map: { center: [18, 59], playArea: base },
            hidingZones: {
                radius: 1,
                unit: "kilometers",
                features: { type: "FeatureCollection", features: [] },
            },
        } as any);
        const radar: any = {
            id: "radius",
            key: 1,
            data: {
                lat: 59.33,
                lng: 18.06,
                radius: 2,
                unit: "kilometers",
                within: true,
                drag: false,
            },
        };

        await expect(
            computePerQuestionRegions([radar], base, false),
        ).rejects.toBeInstanceOf(GeometryWorkerError);
        expect(worker).toMatchObject({ started: 1, terminated: 1 });

        // The next refresh gets a new worker and the radar's real region.
        const [retried] = await computePerQuestionRegions([radar], base, false);
        expect(worker.started).toBe(2);
        expect(turf.area(retried.region)).toBeLessThan(turf.area(base) / 100);
    });
});
