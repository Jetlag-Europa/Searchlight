import type {
    Feature,
    FeatureCollection,
    MultiPolygon,
    Polygon,
} from "geojson";

import type * as BufferGeometry from "./bufferGeometry";
import type { BufferRequest, DistanceRequest } from "./bufferGeometry";
import type { ClipRequest, UnionRequest } from "./clipGeometry";
import { calculateClip, calculateUnion } from "./clipGeometry";
import { calculateLineVoronoi, type LineVoronoiRequest } from "./lineVoronoi";
import {
    calculateFilterZoneIndexes,
    type FilterZoneRequest,
} from "./zoneFilter";

type GeometryResult = Feature<Polygon | MultiPolygon> | null;
type Reply = { id: number } & (
    | { result: unknown }
    | { error: string }
    | { superseded: true }
);

export interface RequestOptions {
    /**
     * Identifies who is asking, such as one question. A newer request with
     * the same key makes this one obsolete: if the worker has not started it
     * yet, it is skipped and its promise rejects with a SupersededError.
     */
    supersede?: string;
}

/** A newer request with the same supersede key replaced this one. */
export class SupersededError extends Error {
    constructor() {
        super("A newer geometry request replaced this one");
        this.name = "SupersededError";
    }
}

// Server-side and geometry test runtimes have no browser Worker API, so they
// buffer on this thread. ArcGIS loads on demand there: browsers use the worker
// and shouldn't download it with the page.
let inlineBuffer: Promise<typeof BufferGeometry> | undefined;
function loadInlineBuffer(): Promise<typeof BufferGeometry> {
    inlineBuffer ??= import("./bufferGeometry");
    return inlineBuffer;
}
// Start loading now so the first buffer doesn't wait for it.
if (typeof Worker === "undefined") loadInlineBuffer().catch(() => {});

let worker: Worker | undefined;
let nextId = 0;
const pending = new Map<
    number,
    {
        resolve: (result: unknown) => void;
        reject: (error: Error) => void;
    }
>();

function getWorker(): Worker {
    if (!worker) {
        worker = new Worker(new URL("./geometry.worker.ts", import.meta.url), {
            type: "module",
        });
        worker.onmessage = (event: MessageEvent<Reply>) => {
            const reply = event.data;
            const task = pending.get(reply.id);
            if (!task) return;
            pending.delete(reply.id);
            if ("error" in reply) task.reject(new Error(reply.error));
            else if ("superseded" in reply) task.reject(new SupersededError());
            else task.resolve(reply.result);
        };
        const fail = () => {
            worker?.terminate();
            worker = undefined;
            const error = new Error(
                "Geometry worker failed; retry the calculation",
            );
            for (const task of pending.values()) task.reject(error);
            pending.clear();
        };
        worker.onerror = fail;
        worker.onmessageerror = fail;
    }
    return worker;
}

export function requestGeometry(
    request: BufferRequest,
    options?: RequestOptions,
): Promise<Feature<MultiPolygon>>;
export function requestGeometry(request: DistanceRequest): Promise<number>;
export function requestGeometry(request: ClipRequest): Promise<GeometryResult>;
export function requestGeometry(request: UnionRequest): Promise<GeometryResult>;
export function requestGeometry(
    request: LineVoronoiRequest,
): Promise<Feature<Polygon | MultiPolygon>[][]>;
export async function requestGeometry(
    request:
        | BufferRequest
        | ClipRequest
        | DistanceRequest
        | LineVoronoiRequest
        | UnionRequest,
    options?: RequestOptions,
): Promise<unknown> {
    if (typeof Worker === "undefined") {
        if (request.kind === "clip") return calculateClip(request);
        if (request.kind === "union") return calculateUnion(request);
        if (request.kind === "lineVoronoi")
            return calculateLineVoronoi(request);
        const buffer = await loadInlineBuffer();
        if (request.kind === "distance")
            return buffer.calculateDistance(request);
        return buffer.calculateBuffer(request);
    }
    const activeWorker = getWorker();
    return new Promise((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, {
            resolve: resolve as (result: unknown) => void,
            reject,
        });
        try {
            activeWorker.postMessage({
                id,
                request,
                supersede: options?.supersede,
            });
        } catch (error) {
            pending.delete(id);
            reject(error);
        }
    });
}
export async function filterZoneIndexes(
    circles: Feature<Polygon | MultiPolygon>[],
    regions: FeatureCollection<Polygon | MultiPolygon>[],
): Promise<number[]> {
    if (typeof Worker === "undefined") {
        return calculateFilterZoneIndexes(circles, regions);
    }
    const activeWorker = getWorker();
    return new Promise((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, {
            resolve: resolve as (result: unknown) => void,
            reject,
        });
        try {
            const request: FilterZoneRequest = {
                kind: "filterZone",
                circles,
                regions,
            };
            activeWorker.postMessage({ id, request });
        } catch (error) {
            pending.delete(id);
            reject(error);
        }
    });
}
export { calculateFilterZoneIndexes };
