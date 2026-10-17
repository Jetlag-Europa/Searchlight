import { useStore } from "@nanostores/react";
import { Label } from "@radix-ui/react-label";

import { LatitudeLongitude } from "@/components/LatLngPicker";
import PresetsDialog from "@/components/PresetsDialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Select } from "@/components/ui/select";
import {
    MENU_ITEM_CLASSNAME,
    SidebarMenuItem,
} from "@/components/ui/sidebar-l";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { compiledGameAtom } from "@/game-definition/store";
import {
    autoLockQuestions,
    drawingQuestionKey,
    hiderMode,
    isLoading,
    questionModified,
    questions,
    triggerLocalRefresh,
} from "@/lib/context";
import {
    defaultQuestionLabel,
    questionName,
    setQuestionName,
} from "@/lib/questionNames";
import { cn } from "@/lib/utils";
import type { MeasuringQuestion } from "@/maps/schema";

import { QuestionCard } from "./base";

export const MeasuringQuestionComponent = ({
    data,
    questionKey,
    sub,
    className,
}: {
    data: MeasuringQuestion;
    questionKey: number;
    sub?: string;
    className?: string;
}) => {
    useStore(triggerLocalRefresh);
    const $hiderMode = useStore(hiderMode);
    const $questions = useStore(questions);
    const $drawingQuestionKey = useStore(drawingQuestionKey);
    const $isLoading = useStore(isLoading);
    const compiled = useStore(compiledGameAtom);
    const compiledMeasuring =
        compiled?.questions.filter((q) => q.family === "measuring") ?? [];

    const label = defaultQuestionLabel($questions, questionKey);

    let questionSpecific = <></>;

    switch (data.type) {
        case "custom-measure":
            if (data.drag) {
                questionSpecific = (
                    <>
                        <p className="px-2 mb-1 text-center text-orange-500">
                            To modify the measuring question, enable it:
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
                                presetTypeHint={data.type}
                            />
                        </div>
                    </>
                );
            }
            break;
    }

    return (
        <QuestionCard
            questionKey={questionKey}
            label={label}
            name={questionName(data)}
            setName={(name) => questionModified(setQuestionName(data, name))}
            sub={compiled?.questionMap.get(data.type)?.label ?? sub}
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
            <SidebarMenuItem className={MENU_ITEM_CLASSNAME}>
                <Select
                    trigger="Measuring Type"
                    options={Object.fromEntries(
                        compiledMeasuring.map((q) => [q.id, q.label]),
                    )}
                    groups={{
                        Custom: {
                            disabled: false,
                            options: {
                                "custom-measure": "Custom Measure",
                            },
                        },
                    }}
                    value={data.type}
                    onValueChange={(value) => {
                        // A custom question starts with nothing to measure to.
                        if (value === "custom-measure") {
                            if (!(data as any).geo) {
                                (data as any).geo = {
                                    type: "FeatureCollection",
                                    features: [],
                                };
                            } else {
                                (data as any).geo.features = [];
                            }
                        }
                        data.type = value;
                        questionModified();
                    }}
                    disabled={!data.drag || $isLoading}
                />
            </SidebarMenuItem>
            {questionSpecific}
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
            <div className="flex gap-2 items-center p-2">
                <Label
                    className={cn(
                        "font-semibold text-lg",
                        $isLoading && "text-muted-foreground",
                    )}
                >
                    Result
                </Label>
                <ToggleGroup
                    className="grow"
                    type="single"
                    value={data.hiderCloser ? "closer" : "further"}
                    onValueChange={(value: "closer" | "further") =>
                        questionModified(
                            (data.hiderCloser = value === "closer"),
                        )
                    }
                    disabled={!!$hiderMode || !data.drag || $isLoading}
                >
                    <ToggleGroupItem value="further">
                        Hider Further
                    </ToggleGroupItem>
                    <ToggleGroupItem value="closer">
                        Hider Closer
                    </ToggleGroupItem>
                </ToggleGroup>
            </div>
        </QuestionCard>
    );
};
