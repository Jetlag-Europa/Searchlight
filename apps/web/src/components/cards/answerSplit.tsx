import { useStore } from "@nanostores/react";
import { useEffect, useMemo, useRef, useState } from "react";

import { compiledGameAtom } from "@/game-definition/store";
import {
    disabledStations,
    gameDefinitionReady,
    hiderMode,
    isLoading,
    mapGeoJSON,
    perQuestionMapData,
    planningModeEnabled,
    polyGeoJSON,
    questions,
} from "@/lib/context";
import { createLatestTask } from "@/lib/latestTask";
import { zoneScaleAfter } from "@/lib/zoneSize";
import { type AnswerSplit, answerSplit, splitInputs } from "@/maps/answerSplit";
import {
    filterZoneIndexes,
    SupersededError,
} from "@/maps/geo-utils/geometryClient";

/**
 * How many hiding zones each answer would leave, on an unlocked question in
 * planning mode: picking a question that splits the zones evenly is the
 * seeker's best move. Recounted once the question stops changing and the map
 * has applied the other questions.
 */
export const AnswerSplitPreview = ({
    questionKey,
    data,
}: {
    questionKey: number;
    data: { drag?: boolean; enabled?: boolean };
}) => {
    const $planningMode = useStore(planningModeEnabled);
    const $hiderMode = useStore(hiderMode);
    const $questions = useStore(questions);
    const compiled = useStore(compiledGameAtom);
    const ready = useStore(gameDefinitionReady);
    const $isLoading = useStore(isLoading);
    const $perQuestionMapData = useStore(perQuestionMapData);
    const $disabledStations = useStore(disabledStations);
    const $polyGeoJSON = useStore(polyGeoJSON);
    const $mapGeoJSON = useStore(mapGeoJSON);
    const boundary = $polyGeoJSON ?? $mapGeoJSON;
    const task = useMemo(() => createLatestTask(), []);
    // The last count, with what it was counted from. Null answers when it
    // failed.
    const [split, setSplit] = useState<{
        basis: unknown[];
        answers: AnswerSplit[] | null;
    }>();

    const position = $questions.findIndex(({ key }) => key === questionKey);
    const question = $questions[position];
    const shown =
        $planningMode &&
        $hiderMode === false &&
        !!data.drag &&
        data.enabled !== false &&
        ready &&
        !!compiled?.hidingZones.stations?.length &&
        !!boundary &&
        !!question;

    // Each map refresh publishes a new list, mostly of the same regions.
    // Only a changed region calls for a new count. This question's own
    // region is left out while planning mode drops it.
    const others = $perQuestionMapData.filter(
        (entry) => entry.question?.key !== questionKey,
    );
    const answered = useRef(others);
    if (
        others.length !== answered.current.length ||
        others.some(
            (entry, index) =>
                entry.region !== answered.current[index].region ||
                entry.zoneScale !== answered.current[index].zoneScale,
        )
    ) {
        answered.current = others;
    }

    // Cards edit their data in place, so compare by value.
    const inputs = shown
        ? JSON.stringify([
              question.id,
              splitInputs(question),
              zoneScaleAfter($questions, position),
          ])
        : "";
    const basis = [
        inputs,
        answered.current,
        $disabledStations,
        compiled,
        boundary,
    ];
    const current =
        split?.basis.length === basis.length &&
        split.basis.every((value, index) => value === basis[index]);

    useEffect(() => {
        // While the map applies the questions, the zones still possible may
        // be about to change: count once it is done.
        if (!shown || $isLoading || current) return;
        // Wait for a dragged marker or a typed radius to settle.
        const timer = setTimeout(() => {
            void task.request(async (isCurrent) => {
                const count = () =>
                    answerSplit(
                        question,
                        $questions,
                        compiled,
                        answered.current,
                        $disabledStations,
                        boundary,
                        filterZoneIndexes,
                        isCurrent,
                    );
                try {
                    let answers: AnswerSplit[] | undefined;
                    for (let attempt = 1; ; attempt++) {
                        try {
                            answers = await count();
                            break;
                        } catch (error) {
                            // It shared geometry the map had requested, and a
                            // newer request replaced that. Count again.
                            if (
                                !(error instanceof SupersededError) ||
                                attempt === 3
                            )
                                throw error;
                            if (!isCurrent()) return;
                        }
                    }
                    if (isCurrent() && answers) setSplit({ basis, answers });
                } catch (error) {
                    if (!isCurrent()) return;
                    console.error("Error previewing the answers:", error);
                    setSplit({ basis, answers: null });
                }
            });
        }, 300);
        return () => {
            clearTimeout(timer);
            task.cancel();
        };
    }, [
        inputs,
        answered.current,
        $disabledStations,
        compiled,
        boundary,
        shown,
        $isLoading,
        current,
    ]);

    if (!shown || (current && !split.answers)) return null;
    return (
        <div className="px-2 text-sm text-muted-foreground">
            {current && !$isLoading ? (
                split.answers!.map(({ label, zones }) => (
                    <p key={label}>
                        {label} →{" "}
                        <span className="font-medium text-foreground">
                            {zones} {zones === 1 ? "zone" : "zones"}
                        </span>
                    </p>
                ))
            ) : (
                <p>Counting zones per answer…</p>
            )}
            <p className="text-xs">
                Zones left by each answer. A zone on the line counts for both.
            </p>
        </div>
    );
};
