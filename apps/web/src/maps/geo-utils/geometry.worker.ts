import {
    type BufferRequest,
    calculateBuffer,
    calculateDistance,
    type DistanceRequest,
} from "./bufferGeometry";
import type { ClipRequest, UnionRequest } from "./clipGeometry";
import { calculateClip, calculateUnion } from "./clipGeometry";
import { calculateLineVoronoi, type LineVoronoiRequest } from "./lineVoronoi";
import { createJobQueue, type WorkerJob } from "./workerQueue";
import {
    calculateFilterZoneIndexes,
    type FilterZoneRequest,
} from "./zoneFilter";

type GeometryRequest =
    | BufferRequest
    | ClipRequest
    | FilterZoneRequest
    | DistanceRequest
    | LineVoronoiRequest
    | UnionRequest;

async function calculate(request: GeometryRequest): Promise<unknown> {
    if (request.kind === "filterZone") {
        return calculateFilterZoneIndexes(request.circles, request.regions);
    }
    if (request.kind === "clip") return calculateClip(request);
    if (request.kind === "union") return calculateUnion(request);
    if (request.kind === "lineVoronoi") return calculateLineVoronoi(request);
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
