import esriConfig from "@arcgis/core/config.js";

import {
    type BufferRequest,
    calculateBuffer,
    calculateDistance,
    type DistanceRequest,
} from "./bufferGeometry";
import type {
    BoundaryTargetRequest,
    ClipRequest,
    UnionRequest,
} from "./clipGeometry";
import {
    calculateBoundaryTarget,
    calculateClip,
    calculateUnion,
} from "./clipGeometry";
import { calculateLineVoronoi, type LineVoronoiRequest } from "./lineVoronoi";
import {
    findRegionOverlaps,
    type RegionOverlapsRequest,
    removeRegionOverlaps,
    type RemoveRegionOverlapsRequest,
} from "./regionOverlaps";
import { createJobQueue, type WorkerJob } from "./workerQueue";
import {
    calculateFilterZoneIndexes,
    type FilterZoneRequest,
} from "./zoneFilter";

// ArcGIS's assets (its projection engine WASM) come with the app, so geodesic
// questions work offline: astro.config.mjs serves them, the service worker
// precaches them. The operators load on demand, after this has run.
esriConfig.assetsPath = __ARCGIS_ASSETS_PATH__;

type GeometryRequest =
    | BoundaryTargetRequest
    | BufferRequest
    | ClipRequest
    | FilterZoneRequest
    | DistanceRequest
    | LineVoronoiRequest
    | RegionOverlapsRequest
    | RemoveRegionOverlapsRequest
    | UnionRequest;

async function calculate(request: GeometryRequest): Promise<unknown> {
    if (request.kind === "filterZone") {
        return calculateFilterZoneIndexes(request.circles, request.regions);
    }
    if (request.kind === "clip") return calculateClip(request);
    if (request.kind === "union") return calculateUnion(request);
    if (request.kind === "boundaryTarget") {
        return calculateBoundaryTarget(request);
    }
    if (request.kind === "lineVoronoi") return calculateLineVoronoi(request);
    if (request.kind === "regionOverlaps") return findRegionOverlaps(request);
    if (request.kind === "removeRegionOverlaps") {
        return removeRegionOverlaps(request);
    }
    if (request.kind === "distance") return calculateDistance(request);
    return calculateBuffer(request);
}

const enqueue = createJobQueue<GeometryRequest>({
    run: async ({ id, request }) => {
        try {
            self.postMessage({ id, result: await calculate(request) });
        } catch (error) {
            self.postMessage({
                id,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    },
    skip: ({ id }) => self.postMessage({ id, superseded: true }),
    receivePending: () => new Promise((resolve) => setTimeout(resolve, 0)),
});

self.onmessage = (event: MessageEvent<WorkerJob<GeometryRequest>>) => {
    enqueue(event.data);
};
