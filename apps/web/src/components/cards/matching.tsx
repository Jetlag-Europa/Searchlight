import { useStore } from "@nanostores/react";
import * as React from "react";
import { toast } from "react-toastify";

import CustomInitDialog from "@/components/CustomInitDialog";
import { LatitudeLongitude } from "@/components/LatLngPicker";
import PresetsDialog from "@/components/PresetsDialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import {
    MENU_ITEM_CLASSNAME,
    SidebarMenuItem,
} from "@/components/ui/sidebar-l";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { compiledGameAtom } from "@/game-definition/store";
import {
    autoLockQuestions,
    customInitPreference,
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
import { determineMatchingBoundary } from "@/maps/questions/matching";
import type { MatchingQuestion } from "@/maps/schema";

import { QuestionCard } from "./base";

export const MatchingQuestionComponent = ({
    data,
    questionKey,
    sub,
    className,
}: {
    data: MatchingQuestion;
    questionKey: number;
    sub?: string;
    className?: string;
}) => {
    useStore(triggerLocalRefresh);
    const $hiderMode = useStore(hiderMode);
    const $questions = useStore(questions);
    const $drawingQuestionKey = useStore(drawingQuestionKey);
    const $isLoading = useStore(isLoading);
    const $customInitPref = useStore(customInitPreference);
    const compiled = useStore(compiledGameAtom);
    const compiledMatching =
        compiled?.questions.filter((q) => q.family === "matching") ?? [];
    const [customDialogOpen, setCustomDialogOpen] = React.useState(false);
    const [pendingCustomType, setPendingCustomType] = React.useState<
        "custom-zone" | "custom-points" | null
    >(null);
    const prefillSeqRef = React.useRef(0);
    const prefillScope = React.useMemo(() => Symbol("matching-prefill"), []);

    React.useEffect(() => {
        return () => {
            prefillSeqRef.current++;
            resetScopedLoading(prefillScope);
        };
    }, [prefillScope]);

    const label = `Matching
    ${
        $questions
            .filter((q) => q.id === "matching")
            .map((q) => q.key)
            .indexOf(questionKey) + 1
    }`;

    let questionSpecific = <></>;

    switch (data.type) {
        case "custom-zone":
        case "custom-points":
            if (data.drag) {
                questionSpecific = (
                    <>
                        <p className="px-2 mb-1 text-center text-orange-500">
                            To modify the matching{" "}
                            {data.type === "custom-zone" ? "zones" : "points"},
                            enable it:
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
                                disabled={$isLoading}
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
    }

    return (
        <QuestionCard
            questionKey={questionKey}
            label={label}
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
            <CustomInitDialog
                open={customDialogOpen}
                onOpenChange={setCustomDialogOpen}
                onBlank={async () => {
                    if (!pendingCustomType) return;
                    if (pendingCustomType === "custom-zone") {
                        (data as any).geo = undefined;
                        toast.info("Please draw the zone on the map.");
                    } else {
                        (data as any).geo = [];
                        toast.info("Please draw the points on the map.");
                    }
                    data.type = pendingCustomType;
                    questionModified();
                    setCustomDialogOpen(false);
                }}
                onPrefill={async () => {
                    if (!pendingCustomType) return;
                    const currentSeq = ++prefillSeqRef.current;
                    setScopedLoading(prefillScope, true);
                    try {
                        if (pendingCustomType === "custom-zone") {
                            const boundary =
                                await determineMatchingBoundary(data);
                            if (prefillSeqRef.current !== currentSeq) return;
                            (data as { geo?: unknown }).geo = boundary;
                        } else {
                            (data as { geo?: unknown }).geo = [];
                            toast.info("Please draw the points on the map.");
                        }
                        data.type = pendingCustomType;
                        questionModified();
                        setCustomDialogOpen(false);
                    } finally {
                        setScopedLoading(prefillScope, false);
                    }
                }}
            />
            <SidebarMenuItem className={MENU_ITEM_CLASSNAME}>
                <Select
                    trigger="Matching Type"
                    options={Object.fromEntries(
                        compiledMatching.map((q) => [q.id, q.label]),
                    )}
                    groups={{
                        Custom: {
                            disabled: false,
                            options: {
                                "custom-points": "Custom Points",
                                "custom-zone": "Custom Zone",
                            },
                        },
                    }}
                    value={data.type}
                    onValueChange={async (value) => {
                        if (
                            value === "custom-zone" ||
                            value === "custom-points"
                        ) {
                            if ($customInitPref === "ask") {
                                setPendingCustomType(value);
                                setCustomDialogOpen(true);
                                return;
                            }
                            // Apply preference without dialog
                            if ($customInitPref === "blank") {
                                if (value === "custom-zone") {
                                    (data as any).geo = undefined;
                                    toast.info(
                                        "Please draw the zone on the map.",
                                    );
                                } else {
                                    (data as any).geo = [];
                                    toast.info(
                                        "Please draw the points on the map.",
                                    );
                                }
                            } else if ($customInitPref === "prefill") {
                                const currentSeq = ++prefillSeqRef.current;
                                setScopedLoading(prefillScope, true);
                                try {
                                    if (value === "custom-zone") {
                                        const boundary =
                                            await determineMatchingBoundary(
                                                data,
                                            );
                                        if (
                                            prefillSeqRef.current !== currentSeq
                                        )
                                            return;
                                        (data as { geo?: unknown }).geo =
                                            boundary;
                                    } else {
                                        (data as { geo?: unknown }).geo = [];
                                        toast.info(
                                            "Please draw the points on the map.",
                                        );
                                    }
                                } finally {
                                    setScopedLoading(prefillScope, false);
                                }
                                if (prefillSeqRef.current !== currentSeq)
                                    return;
                            }
                        }

                        questionModified((data.type = value));
                    }}
                    disabled={!data.drag || $isLoading}
                />
            </SidebarMenuItem>
            {questionSpecific}

            {data.type !== "custom-zone" && (
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
            )}
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
                    value={data.same ? "same" : "different"}
                    onValueChange={(value) => {
                        if (value === "same") {
                            questionModified((data.same = true));
                        } else if (value === "different") {
                            questionModified((data.same = false));
                        }
                    }}
                    disabled={!!$hiderMode || !data.drag || $isLoading}
                >
                    <ToggleGroupItem value="different">
                        Different
                    </ToggleGroupItem>
                    <ToggleGroupItem value="same">Same</ToggleGroupItem>
                </ToggleGroup>
            </div>
        </QuestionCard>
    );
};
