import * as turf from "@turf/turf";

import { isRadius } from "@/lib/askedQuestions";
import { hiderMode } from "@/lib/context";
import { arcBuffer, modifyMapData } from "@/maps/geo-utils";
import type { RadiusQuestion } from "@/maps/schema";

export const adjustPerRadius = async (
    question: RadiusQuestion,
    mapData: any,
) => {
    if (mapData === null) return;
    // A bad radius eliminates nothing, as a tentacle without one does.
    if (!isRadius(question.radius)) return mapData;

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
    if (!isRadius(question.radius)) return undefined;
    const point = turf.point([question.lng, question.lat]);
    const circle = await arcBuffer(
        turf.featureCollection([point]),
        question.radius,
        question.unit,
    );

    return turf.polygonToLine(circle);
};
