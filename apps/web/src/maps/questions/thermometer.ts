import type { AllGeoJSON } from "@turf/turf";
import * as turf from "@turf/turf";
import type { BBox } from "geojson";

import { hiderMode, mapGeoJSON, polyGeoJSON } from "@/lib/context";
import { safeUnion } from "@/maps/geo-utils";
import { geoSpatialVoronoiSafe } from "@/maps/geo-utils/voronoi";
import type { ThermometerQuestion } from "@/maps/schema";

/**
 * The cells nearer A and nearer B, drawn finely over a box round A, B and
 * `around`. Null when A and B are the same place: the hider's distance has
 * not changed, so they are neither warmer nor colder.
 */
const thermometerCells = (
    question: ThermometerQuestion,
    around: (AllGeoJSON | null)[],
) => {
    const pointA = turf.point([question.lngA, question.latA]);
    const pointB = turf.point([question.lngB, question.latB]);
    const domain: BBox = turf.bbox(turf.featureCollection([pointA, pointB]));
    for (const shape of around) {
        if (!shape) continue;
        const [west, south, east, north] = turf.bbox(shape);
        if (!Number.isFinite(west)) continue;
        domain[0] = Math.min(domain[0], west);
        domain[1] = Math.min(domain[1], south);
        domain[2] = Math.max(domain[2], east);
        domain[3] = Math.max(domain[3], north);
    }

    const voronoi = geoSpatialVoronoiSafe(
        turf.featureCollection([pointA, pointB]),
        domain,
    );
    const cellOf = (site: typeof pointA) =>
        voronoi.features.find((cell) => cell.properties?.site === site);
    const [a, b] = [cellOf(pointA), cellOf(pointB)];
    return a && b ? { a, b } : null;
};

export const adjustPerThermometer = (
    question: ThermometerQuestion,
    mapData: any,
) => {
    if (mapData === null) return;

    const cells = thermometerCells(question, [mapData]);
    if (!cells) return mapData;

    if (question.warmer) {
        return turf.intersect(
            turf.featureCollection([safeUnion(mapData), cells.b]),
        );
    } else {
        return turf.intersect(
            turf.featureCollection([safeUnion(mapData), cells.a]),
        );
    }
};

export const hiderifyThermometer = (question: ThermometerQuestion) => {
    const $hiderMode = hiderMode.get();
    if ($hiderMode === false) {
        return question;
    }

    const hiderPoint = turf.point([$hiderMode.longitude, $hiderMode.latitude]);

    const cells = thermometerCells(question, [
        polyGeoJSON.get() ?? mapGeoJSON.get(),
        hiderPoint,
    ]);
    if (!cells) return question;

    const hiderRegion = turf.booleanPointInPolygon(hiderPoint, cells.b) ? 1 : 0;

    if (hiderRegion === 1) {
        question.warmer = true;
    } else {
        question.warmer = false;
    }

    return question;
};

export const thermometerPlanningPolygon = (question: ThermometerQuestion) => {
    const cells = thermometerCells(question, [
        polyGeoJSON.get() ?? mapGeoJSON.get(),
    ]);
    if (!cells) return turf.featureCollection([]);

    return turf.featureCollection(
        [cells.a, cells.b]
            .map((x: any) => turf.polygonToLine(x))
            .flatMap((line) =>
                line.type === "FeatureCollection" ? line.features : [line],
            ),
    );
};
