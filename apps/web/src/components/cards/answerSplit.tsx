import { useStore } from "@nanostores/react";
import { useEffect, useMemo, useRef, useState } from "react";

import { compiledGameAtom } from "@/game-definition/store";
import {
    gameDefinitionReady,
    hiderMode,
    mapGeoJSON,
    perQuestionMapData,
    planningModeEnabled,
    polyGeoJSON,
    questions,
} from "@/lib/context";
import { createLatestTask } from "@/lib/latestTask";
import { zoneScaleAfter } from "@/lib/zoneSize";
import { type AnswerSplit, answerSplit } from "@/maps/answerSplit";
import { filterZoneIndexes } from "@/maps/geo-utils/geometryClient";

/**
 * How many hiding zones each answer would leave, on an unlocked question in
 * planning mode: picking a question that splits the zones evenly is the
 * seeker's best move. Recomputed once the question stops changing.
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
    const $perQuestionMapData = useStore(perQuestionMapData);
    const $polyGeoJSON = useStore(polyGeoJSON);
    const $mapGeoJSON = useStore(mapGeoJSON);
    const boundary = $polyGeoJSON ?? $mapGeoJSON;
    const task = useMemo(() => createLatestTask(), []);
    // Undefined while computing, null when it failed.
    const [split, setSplit] = useState<AnswerSplit[] | null>();

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
              { ...question.data, name: undefined, collapsed: undefined },
              zoneScaleAfter($questions, position),
          ])
        : "";

    useEffect(() => {
        if (!shown) return;
        setSplit(undefined);
        // Wait for a dragged marker or a typed radius to settle.
        const timer = setTimeout(() => {
            void task.request(async (isCurrent) => {
                try {
                    const result = await answerSplit(
                        question,
                        $questions,
                        compiled,
                        answered.current,
                        boundary,
                        filterZoneIndexes,
                        isCurrent,
                    );
                    if (isCurrent() && result) setSplit(result);
                } catch (error) {
                    if (!isCurrent()) return;
                    console.error("Error previewing the answers:", error);
                    setSplit(null);
                }
            });
        }, 300);
        return () => {
            clearTimeout(timer);
            task.cancel();
        };
    }, [inputs, answered.current, compiled, boundary]);

    if (!shown || split === null) return null;
    return (
        <div className="px-2 text-sm text-muted-foreground">
            <p>
                {split
                    ? split.map(({ label, zones }, index) => (
                          <span key={label}>
                              {index > 0 && " · "}
                              {label} →{" "}
                              <span className="font-medium text-foreground">
                                  {zones} {zones === 1 ? "zone" : "zones"}
                              </span>
                          </span>
                      ))
                    : "Counting zones per answer…"}
            </p>
            <p className="text-xs">
                Zones left by each answer. A zone on the line counts for both.
            </p>
        </div>
    );
};
