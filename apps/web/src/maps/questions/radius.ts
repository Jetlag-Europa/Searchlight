import * as turf from "@turf/turf";

import { hiderMode } from "@/lib/context";
import { arcBuffer, modifyMapData } from "@/maps/geo-utils";
import type { RadiusQuestion } from "@/maps/schema";

/**
 * Whether a radar has a circle to draw. The card used to accept a typed 0 or
 * a negative radius, and another client may store null: such a radar
 * eliminates nothing until the player enters a radius.
 */
const hasRadius = (question: { radius?: unknown }) =>
    typeof question.radius === "number" &&
    Number.isFinite(question.radius) &&
    question.radius > 0;

export const adjustPerRadius = async (
    question: RadiusQuestion,
    mapData: any,
) => {
    if (mapData === null) return;
    if (!hasRadius(question)) return mapData;

    const point = turf.point([question.lng, question.lat]);
    const circle = await arcBuffer(
        turf.featureCollection([point]),
        question.radius,
        question.unit,
    );

    return modifyMapData(mapData, circle, question.within);
};

export const hiderifyRadius = (question: RadiusQuestion) => {
    const $hiderMode = hiderMode.get();
    if ($hiderMode === false) {
        return question;
    }

    const distance = turf.distance(
        turf.point([question.lng, question.lat]),
        turf.point([$hiderMode.longitude, $hiderMode.latitude]),
        { units: question.unit },
    );

    if (distance <= question.radius) {
        question.within = true;
    } else {
        question.within = false;
    }

    return question;
};

export const radiusPlanningPolygon = async (question: RadiusQuestion) => {
    if (!hasRadius(question)) return undefined;
    const point = turf.point([question.lng, question.lat]);
    const circle = await arcBuffer(
        turf.featureCollection([point]),
        question.radius,
        question.unit,
    );

    return turf.polygonToLine(circle);
};
