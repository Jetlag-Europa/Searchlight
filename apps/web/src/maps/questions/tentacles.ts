import * as turf from "@turf/turf";
import type { BBox, Feature, FeatureCollection, Point } from "geojson";

import { compiledGameAtom } from "@/game-definition/store";
import { hiderMode } from "@/lib/context";
import { arcBuffer, safeUnion } from "@/maps/geo-utils";
import { geoSpatialVoronoiSafe } from "@/maps/geo-utils";
import type { TentacleQuestion, Units } from "@/maps/schema";

import { determineTentacleGeometry, featuresMatch } from "./operators/tentacle";

// A bbox covering the tentacle's POIs and its radius circle, used to clip the
// planar-Voronoi fallback in geoSpatialVoronoiSafe (which kicks in only when the
// spherical Voronoi is degenerate for tightly-clustered POIs).
function tentacleVoronoiBbox(
    points: FeatureCollection<Point>,
    question: TentacleQuestion,
): BBox {
    const circle = turf.buffer(turf.point([question.lng, question.lat]), question.radius * 1.15, {
        units: question.unit,
    });
    const fc = turf.featureCollection([
        ...points.features,
        ...(circle ? [circle] : []),
    ] as never);
    const [a, b, c, d] = turf.bbox(fc);
    const px = (c - a) * 0.1 || 0.1;
    const py = (d - b) * 0.1 || 0.1;
    return [a - px, b - py, c + px, d + py];
}

export async function getLocationsForTentacleQuestion(
    question: TentacleQuestion,
): Promise<FeatureCollection<Point>> {
    const game = compiledGameAtom.get();
    if (game && question.locationType && question.locationType !== "custom") {
        const qDef = game.questionMap.get(question.locationType);
        if (
            qDef &&
            qDef.family === "tentacle" &&
            "source" in qDef.evaluator &&
            qDef.evaluator.source?.kind === "dataset" &&
            qDef.evaluator.source.datasetId
        ) {
            const ds = game.datasets[qDef.evaluator.source.datasetId] as
                | { kind?: string; features?: { features?: Feature[] } }
                | undefined;
            if (ds?.kind === "inline" && ds.features?.features) {
                const withName = (p: Feature<Point>) => {
                    const props = (p.properties ?? {}) as Record<string, unknown>;
                    const name = (props.name ?? props["name:en"] ?? "POI") as string;
                    return {
                        ...p,
                        properties: {
                            ...props,
                            name,
                        },
                    } as Feature<Point>;
                };

                if (
                    question.lat !== null &&
                    question.lng !== null &&
                    question.radius !== undefined &&
                    question.radius !== null &&
                    question.unit !== undefined
                ) {
                    // List exactly the sites inside the circle the map uses.
                    const { points } = await determineTentacleGeometry({
                        evaluator: qDef.evaluator,
                        datasets: game.datasets,
                        data: question,
                    });
                    return turf.featureCollection(points.map(withName));
                }
                return turf.featureCollection(
                    ds.features.features
                        .filter((f): f is Feature<Point> => f.geometry?.type === "Point")
                        .map(withName),
                );
            }
        }
    }
    // A game's tentacle locations come only from its own layers.
    return turf.featureCollection([]) as FeatureCollection<Point>;
}

const filterPointsWithinRadius = (
    points: any,
    centerLng: number,
    centerLat: number,
    radius: number,
    unit: Units,
) => {
    if (
        centerLng === null ||
        centerLat === null ||
        radius === undefined ||
        radius === null
    ) {
        return points;
    }
    const center = turf.point([centerLng, centerLat]);

    return turf.featureCollection(
        points.features.filter((feature: any) => {
            const coords =
                feature?.geometry?.coordinates ??
                (feature?.properties?.lon && feature?.properties?.lat
                    ? [feature.properties.lon, feature.properties.lat]
                    : null);

            if (!coords) return false;

            const pt = turf.point(coords);
            const dist = turf.distance(center, pt, { units: unit });
            return dist <= radius;
        }),
    );
};

export const adjustPerTentacle = async (
    question: TentacleQuestion,
    mapData: any,
) => {
    if (mapData === null) return;
    if (question.location === false) {
        throw new Error("Must have a location");
    }

    const rawPoints =
        question.locationType === "custom"
            ? turf.featureCollection(question.places ?? [])
            : await getLocationsForTentacleQuestion(question);

    const points =
        question.locationType === "custom"
            ? filterPointsWithinRadius(
                  rawPoints,
                  question.lng,
                  question.lat,
                  question.radius,
                  question.unit,
              )
            : rawPoints;

    if (points.features.length === 1) {
        if (!featuresMatch(points.features[0], question.location)) {
            return mapData;
        }
        const circle = await arcBuffer(
            turf.featureCollection([turf.point([question.lng, question.lat])]),
            question.radius,
            question.unit,
        );
        return turf.intersect(
            turf.featureCollection([safeUnion(mapData), circle]),
        );
    }

    const voronoi = geoSpatialVoronoiSafe(points, tentacleVoronoiBbox(points, question));

    const correctPolygon = voronoi.features.find((feature) => {
        if (!question.location) return false;
        const site = (feature.properties as { site?: Feature<Point> } | undefined)?.site ?? feature;
        return featuresMatch(site, question.location);
    });
    if (!correctPolygon) {
        return mapData;
    }

    const circle = await arcBuffer(
        turf.featureCollection([turf.point([question.lng, question.lat])]),
        question.radius,
        question.unit,
    );

    return turf.intersect(
        turf.featureCollection([safeUnion(mapData), correctPolygon, circle]),
    );
};

export const hiderifyTentacles = async (question: TentacleQuestion) => {
    const $hiderMode = hiderMode.get();
    if ($hiderMode === false) {
        return question;
    }

    const rawPoints =
        question.locationType === "custom"
            ? turf.featureCollection(question.places ?? [])
            : await getLocationsForTentacleQuestion(question);

    const points =
        question.locationType === "custom"
            ? filterPointsWithinRadius(
                  rawPoints,
                  question.lng,
                  question.lat,
                  question.radius,
                  question.unit,
              )
            : rawPoints;

    const voronoi = geoSpatialVoronoiSafe(points, tentacleVoronoiBbox(points, question));

    const hider = turf.point([$hiderMode.longitude, $hiderMode.latitude]);
    const location = turf.point([question.lng, question.lat]);

    if (
        turf.distance(hider, location, { units: question.unit }) >
        question.radius
    ) {
        question.location = false;
        return question;
    }

    let correctLocation: any = null;

    // Use the cell's own `site` rather than indexing into points — the planar
    // fallback in geoSpatialVoronoiSafe may drop null cells, so cell order no
    // longer lines up with the input points. Both Voronoi paths set properties.site.
    const correctPolygon = voronoi.features.find((feature: any) => {
        const pointIn =
            turf.booleanPointInPolygon(hider, feature.geometry) || false;

        if (pointIn) {
            correctLocation = feature.properties.site;
        }
        return pointIn;
    });

    if (!correctPolygon) {
        return question;
    }

    question.location = correctLocation!;
    return question;
};

export const tentaclesPlanningPolygon = async (question: TentacleQuestion) => {
    const rawPoints =
        question.locationType === "custom"
            ? turf.featureCollection(question.places ?? [])
            : await getLocationsForTentacleQuestion(question);

    const points =
        question.locationType === "custom"
            ? filterPointsWithinRadius(
                  rawPoints,
                  question.lng,
                  question.lat,
                  question.radius,
                  question.unit,
              )
            : rawPoints;

    const voronoi = geoSpatialVoronoiSafe(points, tentacleVoronoiBbox(points, question));
    const circle = await arcBuffer(
        turf.featureCollection([turf.point([question.lng, question.lat])]),
        question.radius,
        question.unit,
    );

    const interiorVoronoi = voronoi.features
        .map((feature) =>
            turf.intersect(turf.featureCollection([feature, circle])),
        )
        .filter((feature) => feature !== null);

    return turf.combine(
        turf.featureCollection(
            interiorVoronoi
                .map((x: any) => turf.polygonToLine(x))
                .flatMap((line) =>
                    line.type === "FeatureCollection" ? line.features : [line],
                ),
        ),
    );
};
