import { useStore } from "@nanostores/react";
import * as turf from "@turf/turf";
import type { Feature, Point } from "geojson";
import { Suspense, use, useEffect, useMemo, useRef } from "react";

import { LatitudeLongitude } from "@/components/LatLngPicker";
import PresetsDialog from "@/components/PresetsDialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import {
    MENU_ITEM_CLASSNAME,
    SidebarMenuItem,
} from "@/components/ui/sidebar-l";
import { UnitSelect } from "@/components/UnitSelect";
import { compiledGameAtom } from "@/game-definition/store";
import {
    autoLockQuestions,
    drawingQuestionKey,
    hiderMode,
    isLoading,
    questionModified,
    questions,
    resetScopedLoading,
    setScopedLoading,
    triggerLocalRefresh,
} from "@/lib/context";
import { cn } from "@/lib/utils";
import { featuresMatch } from "@/maps/questions/operators/tentacle";
import { getLocationsForTentacleQuestion } from "@/maps/questions/tentacles";
import {
    determineUnionizedStrings,
    NO_GROUP,
    type TentacleQuestion,
    tentacleQuestionSchema,
    type TraditionalTentacleQuestion,
} from "@/maps/schema";

import { QuestionCard } from "./base";

export const TentacleQuestionComponent = ({
    data,
    questionKey,
    sub,
    className,
}: {
    data: TentacleQuestion;
    questionKey: number;
    sub?: string;
    className?: string;
}) => {
    const $questions = useStore(questions);
    const $drawingQuestionKey = useStore(drawingQuestionKey);
    const $isLoading = useStore(isLoading);
    const compiled = useStore(compiledGameAtom);
    const compiledTentacles =
        compiled?.questions.filter((q) => q.family === "tentacle") ?? [];
    // use() suspends on every promise it hasn't seen, so a fresh promise per
    // render flashed the spinner and re-filtered the dataset on any re-render.
    // Only create one when an input of the lookup changes, including the
    // compiled game, whose layers a game's lookup reads.
    const locationsPromise = useMemo(
        () =>
            data.locationType === "custom"
                ? Promise.resolve(turf.featureCollection(data.places ?? []))
                : getLocationsForTentacleQuestion(data),
        [
            data.locationType,
            data.lat,
            data.lng,
            data.radius,
            data.unit,
            data.places,
            compiled,
        ],
    );
    const prefillSeqRef = useRef(0);
    const prefillScope = useMemo(() => Symbol("tentacle-prefill"), []);

    useEffect(() => {
        return () => {
            prefillSeqRef.current++;
            resetScopedLoading(prefillScope);
        };
    }, [prefillScope]);

    const label = `Tentacles
    ${
        $questions
            .filter((q) => q.id === "tentacles")
            .map((q) => q.key)
            .indexOf(questionKey) + 1
    }`;
    return (
        <QuestionCard
            questionKey={questionKey}
            label={label}
            sub={compiled?.questionMap.get(data.locationType)?.label ?? sub}
            className={className}
            collapsed={data.collapsed}
            setCollapsed={(collapsed) => {
                data.collapsed = collapsed; // Doesn't trigger a re-render so no need for questionModified
            }}
            locked={!data.drag}
            setLocked={(locked) => questionModified((data.drag = !locked))}
            enabled={data.enabled ?? true}
            setEnabled={(v) => questionModified((data.enabled = v))}
        >
            <SidebarMenuItem>
                <div className={cn(MENU_ITEM_CLASSNAME, "gap-2 flex flex-row")}>
                    <Input
                        type="number"
                        className="rounded-md p-2 w-16"
                        value={data.radius}
                        onChange={(e) =>
                            questionModified(
                                (data.radius = parseFloat(e.target.value)),
                            )
                        }
                        disabled={!data.drag || $isLoading}
                    />
                    <UnitSelect
                        unit={data.unit}
                        onChange={(unit) =>
                            questionModified((data.unit = unit))
                        }
                        disabled={!data.drag || $isLoading}
                    />
                </div>
            </SidebarMenuItem>
            <SidebarMenuItem className={MENU_ITEM_CLASSNAME}>
                <Select
                    trigger="Location Type"
                    value={data.locationType}
                    options={
                        compiled
                            ? Object.fromEntries(
                                  compiledTentacles.map((q) => [q.id, q.label]),
                              )
                            : Object.fromEntries(
                                  tentacleQuestionSchema.options
                                      .filter((x) => x.description === NO_GROUP)
                                      .flatMap((x) =>
                                          determineUnionizedStrings(
                                              x.shape.locationType,
                                          ),
                                      )
                                      .map((x) => [
                                          (x._def as any).value,
                                          x.description,
                                      ]),
                              )
                    }
                    groups={
                        compiled
                            ? {
                                  Custom: {
                                      disabled: false,
                                      options: {
                                          custom: "Custom Locations",
                                      },
                                  },
                              }
                            : Object.fromEntries(
                                  tentacleQuestionSchema.options
                                      .filter((x) => x.description !== NO_GROUP)
                                      .map((x) => [
                                          x.description,
                                          Object.fromEntries(
                                              determineUnionizedStrings(
                                                  x.shape.locationType,
                                              ).map((y) => [
                                                  (y._def as any).value,
                                                  y.description,
                                              ]),
                                          ),
                                      ]),
                              )
                    }
                    onValueChange={async (value) => {
                        const currentSeq = ++prefillSeqRef.current;
                        if (value === "custom") {
                            setScopedLoading(prefillScope, true);
                            try {
                                const priorLocations =
                                    await getLocationsForTentacleQuestion(
                                        data as TraditionalTentacleQuestion,
                                    );
                                if (prefillSeqRef.current !== currentSeq)
                                    return;
                                data.locationType = "custom";
                                data.places = priorLocations.features.map(
                                    (x) => ({
                                        ...x,
                                        properties: {
                                            ...x.properties,
                                            name:
                                                x.properties?.["name:en"] ??
                                                x.properties?.name,
                                        },
                                    }),
                                );
                                data.location = false;
                            } finally {
                                setScopedLoading(prefillScope, false);
                            }
                        } else {
                            data.location = false;
                            data.locationType = value;
                        }
                        if (prefillSeqRef.current === currentSeq) {
                            questionModified();
                        }
                    }}
                    disabled={!data.drag || $isLoading}
                />
            </SidebarMenuItem>
            {data.locationType === "custom" && data.drag && (
                <>
                    <p className="px-2 mb-1 text-center text-orange-500">
                        To modify tentacle locations, enable it:
                        <Checkbox
                            className="mx-1 my-1"
                            checked={$drawingQuestionKey === questionKey}
                            onCheckedChange={(checked) => {
                                if (checked) {
                                    drawingQuestionKey.set(questionKey);
                                } else {
                                    drawingQuestionKey.set(-1);
                                }
                            }}
                            disabled={!data.drag || $isLoading}
                        />
                        and use the buttons at the bottom left of the map.
                    </p>
                    <div className="flex justify-center mb-2">
                        <PresetsDialog
                            data={data}
                            presetTypeHint="custom-tentacles"
                        />
                    </div>
                </>
            )}
            <LatitudeLongitude
                latitude={data.lat}
                longitude={data.lng}
                colorName={data.color}
                onChange={(lat, lng) => {
                    if (lat !== null) {
                        data.lat = lat;
                    }
                    if (lng !== null) {
                        data.lng = lng;
                    }
                    if (autoLockQuestions.get()) data.drag = false;
                    questionModified();
                }}
                disabled={!data.drag || $isLoading}
            />
            <SidebarMenuItem className={MENU_ITEM_CLASSNAME}>
                <Suspense
                    fallback={
                        <div className="flex items-center justify-center w-full h-8">
                            <svg
                                xmlns="http://www.w3.org/2000/svg"
                                width="24"
                                height="24"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                className="animate-spin"
                            >
                                <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                            </svg>
                        </div>
                    }
                >
                    <TentacleLocationSelector
                        data={data}
                        promise={locationsPromise}
                        disabled={!data.drag || $isLoading}
                    />
                </Suspense>
            </SidebarMenuItem>
        </QuestionCard>
    );
};

function getFeatureKey(feature: Feature<Point>): string {
    if (feature.id !== undefined && feature.id !== null) {
        return String(feature.id);
    }
    return JSON.stringify(feature.geometry.coordinates);
}

const TentacleLocationSelector = ({
    data,
    promise,
    disabled,
}: {
    data: TentacleQuestion;
    promise: Promise<{ features: Feature[] }>;
    disabled: boolean;
}) => {
    useStore(triggerLocalRefresh);
    const $hiderMode = useStore(hiderMode);
    const compiled = useStore(compiledGameAtom);
    const locations = use(promise);
    // Until its game loads, a game tentacle's sites are unknown, not absent:
    // its answer must be kept, not cleared.
    const locationsKnown = data.locationType === "custom" || compiled !== null;

    const allFeatures = (locations.features || []).filter(
        (f): f is Feature<Point> => f.geometry?.type === "Point",
    );

    // Filter locations to only those within the radius of the primary location
    const filteredFeatures: Feature<Point>[] = (() => {
        if (
            data.lat === null ||
            data.lng === null ||
            data.radius === undefined ||
            data.radius === null
        ) {
            return allFeatures;
        }

        const center = turf.point([data.lng, data.lat]);

        return allFeatures.filter((feature) => {
            const dist = turf.distance(center, feature, { units: data.unit });
            return dist <= data.radius;
        });
    })();

    // If the currently selected location is no longer within radius, clear it.
    if (
        locationsKnown &&
        data.location &&
        !filteredFeatures.some((f) => featuresMatch(f, data.location))
    ) {
        data.location = false;
        questionModified();
    }

    const nameCounts = new Map<string, number>();
    for (const f of filteredFeatures) {
        const name = (f.properties?.name as string | undefined) ?? "Location";
        nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
    }

    const featureOptions: Record<string, string> = {};
    for (const f of filteredFeatures) {
        const key = getFeatureKey(f);
        const name = (f.properties?.name as string | undefined) ?? "Location";
        const isDuplicate = (nameCounts.get(name) ?? 0) > 1;
        if (isDuplicate) {
            const coords = f.geometry.coordinates;
            featureOptions[key] =
                `${name} (${coords[1].toFixed(3)}, ${coords[0].toFixed(3)})`;
        } else {
            featureOptions[key] = name;
        }
    }

    const currentMatched = data.location
        ? filteredFeatures.find((f) => featuresMatch(f, data.location))
        : null;
    const currentValue = currentMatched
        ? getFeatureKey(currentMatched)
        : "false";

    return (
        <Select
            trigger="Location"
            options={{
                false: "Not Within",
                ...featureOptions,
            }}
            value={currentValue}
            onValueChange={(value) => {
                if (value === "false") {
                    data.location = false;
                } else {
                    const found = filteredFeatures.find(
                        (feature) => getFeatureKey(feature) === value,
                    );
                    data.location = found
                        ? {
                              ...found,
                              properties: {
                                  ...found.properties,
                                  name: found.properties?.name ?? "Location",
                              },
                          }
                        : false;
                }

                questionModified();
            }}
            disabled={!!$hiderMode || disabled || !locationsKnown}
        />
    );
};
