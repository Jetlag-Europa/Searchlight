import type { Evaluator } from "@searchlight/shared";
import * as turf from "@turf/turf";
import type {
    BBox,
    Feature,
    FeatureCollection,
    MultiPolygon,
    Point,
    Polygon,
} from "geojson";

import { compiledGameAtom } from "@/game-definition/store";
import { cellOfSite, geoSpatialVoronoiSafe, safeUnion } from "@/maps/geo-utils";
import { requestGeometry } from "@/maps/geo-utils/geometryClient";

import {
    cachedGeometry,
    containingRegion,
    type GeometrySource,
    geometrySource,
    nearestLine,
    type Region,
} from "./geometry";
export interface MatchingEvaluationParams {
    evaluator: Evaluator;
    datasets: Record<string, unknown>;
    data: {
        lat: number;
        lng: number;
        drag?: boolean;
        same?: boolean;
        comparison?: "shorter" | "same" | "longer";
        customRegions?: FeatureCollection<Polygon | MultiPolygon>;
        places?: unknown[];
    };
    mapGeoData: FeatureCollection<Polygon | MultiPolygon> | null | undefined;
}

interface MatchingGeometry {
    region: Region;
    sameInside: boolean;
}

function resolvePlayAreaBbox(
    mapGeoData?: FeatureCollection<Polygon | MultiPolygon> | null,
    extraFeatures?: Feature[],
): BBox {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    const compiled = compiledGameAtom.get();
    if (compiled?.playArea?.features?.length) {
        const b = turf.bbox(compiled.playArea);
        if (Number.isFinite(b[0])) {
            minX = Math.min(minX, b[0]);
            minY = Math.min(minY, b[1]);
            maxX = Math.max(maxX, b[2]);
            maxY = Math.max(maxY, b[3]);
        }
    }
    if (compiled?.bounds && compiled.bounds.every(Number.isFinite)) {
        const b = compiled.bounds;
        minX = Math.min(minX, b[0]);
        minY = Math.min(minY, b[1]);
        maxX = Math.max(maxX, b[2]);
        maxY = Math.max(maxY, b[3]);
    }
    if (mapGeoData?.features?.length) {
        const b = turf.bbox(mapGeoData);
        if (Number.isFinite(b[0])) {
            minX = Math.min(minX, b[0]);
            minY = Math.min(minY, b[1]);
            maxX = Math.max(maxX, b[2]);
            maxY = Math.max(maxY, b[3]);
        }
    }
    if (extraFeatures?.length) {
        const b = turf.bbox(turf.featureCollection(extraFeatures));
        if (Number.isFinite(b[0])) {
            minX = Math.min(minX, b[0]);
            minY = Math.min(minY, b[1]);
            maxX = Math.max(maxX, b[2]);
            maxY = Math.max(maxY, b[3]);
        }
    }
    if (!Number.isFinite(minX)) return [-180, -85, 180, 85];
    const span = Math.max(maxX - minX, maxY - minY, 0.2);
    const pad = Math.max(0.5, span * 0.5);
    return [
        Math.max(-180, minX - pad),
        Math.max(-85, minY - pad),
        Math.min(180, maxX + pad),
        Math.min(85, maxY + pad),
    ];
}
/**
 * The seeker's nearest line's region, built once per layer in the geometry
 * worker. The sampled partition can misplace a boundary by up to a sample
 * step, so between lines closer than that it can put the seeker in another
 * line's cell; the seeker's own position is then added back.
 */
async function nearestLineRegion(
    source: GeometrySource,
    seekerPoint: Feature<Point>,
    featureOrdinal: number,
    domainBbox: BBox,
): Promise<Region | undefined> {
    const domainKey = domainBbox.map((value) => value.toFixed(4)).join(",");
    const cells = await cachedGeometry(
        source,
        `matching:line-voronoi:${domainKey}`,
        () =>
            requestGeometry({
                kind: "lineVoronoi",
                lines: source.lines.map(({ featureOrdinal, line }) => ({
                    featureOrdinal,
                    line,
                })),
                domain: domainBbox,
            }),
        true,
    );
    const region = await cachedGeometry(
        source,
        `matching:line:${featureOrdinal}:${domainKey}`,
        async () =>
            cells[featureOrdinal]?.length
                ? requestGeometry({
                      kind: "union",
                      regions: cells[featureOrdinal],
                  })
                : null,
        true,
    );
    if (!region) return undefined;
    if (turf.booleanPointInPolygon(seekerPoint, region)) return region;
    const [lng, lat] = seekerPoint.geometry.coordinates;
    return cachedGeometry(
        source,
        `matching:line-seeker:${featureOrdinal}:${lng}:${lat}:${domainKey}`,
        async () => {
            // Every point within half the gap between the seeker's nearest and
            // next-nearest lines is nearer the seeker's line than any other.
            let own = Infinity;
            let other = Infinity;
            for (const part of source.lines) {
                const distance = turf.pointToLineDistance(
                    seekerPoint,
                    part.line,
                    { units: "kilometers" },
                );
                if (part.featureOrdinal === featureOrdinal) {
                    own = Math.min(own, distance);
                } else {
                    other = Math.min(other, distance);
                }
            }
            const radius = (other - own) / 2;
            if (!(radius > 0)) return region;
            const seekerDisc = turf.circle(seekerPoint, radius, {
                units: "kilometers",
            });
            return (
                (await requestGeometry({
                    kind: "union",
                    regions: [region, seekerDisc],
                })) ?? region
            );
        },
    );
}

export async function determineMatchingGeometry(
    params: Omit<MatchingEvaluationParams, "mapGeoData"> & {
        mapGeoData?: FeatureCollection<Polygon | MultiPolygon> | null;
    },
): Promise<MatchingGeometry | undefined> {
    const { evaluator, datasets, data, mapGeoData } = params;
    const source = geometrySource(evaluator, datasets, data);
    if (!source) return undefined;
    const seekerPoint = turf.point([data.lng, data.lat]);

    switch (evaluator.operator) {
        case "nearest-feature-match": {
            if (source.lines.length > 0) {
                const closest = nearestLine(source.lines, seekerPoint);
                const featureOrdinal = source.lines.find(
                    (part) => part.source === closest,
                )?.featureOrdinal;
                if (featureOrdinal === undefined) return undefined;
                const domainBbox = resolvePlayAreaBbox(
                    mapGeoData,
                    source.lines.map((l) => l.line),
                );

                // Single-source line fast path: this line is trivially the nearest line to every point in the domain.
                if (source.lines.every((l) => l.featureOrdinal === 0)) {
                    const worldDomain = turf.bboxPolygon(domainBbox);
                    return { region: worldDomain, sameInside: true };
                }

                const region = await nearestLineRegion(
                    source,
                    seekerPoint,
                    featureOrdinal,
                    domainBbox,
                );
                return region ? { region, sameInside: true } : undefined;
            }

            if (!source.points.length) return undefined;
            const nearest = turf.nearestPoint(
                seekerPoint,
                turf.featureCollection(source.points),
            );
            const domainBbox = resolvePlayAreaBbox(mapGeoData, [
                ...source.points,
                seekerPoint,
            ]);
            const domainKey = `${domainBbox[0].toFixed(4)},${domainBbox[1].toFixed(4)},${domainBbox[2].toFixed(4)},${domainBbox[3].toFixed(4)}`;
            const voronoi = await cachedGeometry(
                source,
                `matching:point-voronoi:${domainKey}`,
                () =>
                    geoSpatialVoronoiSafe(
                        turf.featureCollection(source.points),
                        domainBbox,
                    ),
            );
            const region = cellOfSite(
                voronoi.features,
                nearest.geometry.coordinates,
            );
            return region ? { region, sameInside: true } : undefined;
        }

        case "containing-region-match": {
            if (!source.regions.length) return undefined;
            const containing = containingRegion(source.regions, seekerPoint);
            if (containing) return { region: containing, sameInside: true };
            const region = await cachedGeometry(
                source,
                "matching:region-union",
                () => safeUnion(turf.featureCollection(source.regions)),
                true,
            );
            // Outside every region is itself a matching category. Previously neither
            // answer constrained the map there, even though hider mode answered it.
            return { region, sameInside: false };
        }

        default:
            return undefined;
    }
}

/** Apply the answer only after deriving the reusable, standalone boundary. */
export async function evaluateMatchingOperator(
    params: MatchingEvaluationParams,
) {
    if (!params.mapGeoData) return params.mapGeoData;
    const geometry = await determineMatchingGeometry(params);
    if (!geometry) return params.mapGeoData;
    return requestGeometry({
        kind: "clip",
        mapData: params.mapGeoData,
        modifications: geometry.region,
        within: (params.data.same !== false) === geometry.sameInside,
    });
}
