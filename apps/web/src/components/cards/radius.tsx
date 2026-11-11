import { useStore } from "@nanostores/react";
import { CheckIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { LatitudeLongitude } from "@/components/LatLngPicker";
import { RawInput } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
    MENU_ITEM_CLASSNAME,
    SidebarMenuItem,
} from "@/components/ui/sidebar";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { UnitSelect } from "@/components/UnitSelect";
import { formatRadius, radarRadii } from "@/game-definition/compile";
import { compiledGameAtom } from "@/game-definition/store";
import {
    askedVariants,
    radarVariant,
    storedRadarVariant,
} from "@/lib/askedQuestions";
import {
    autoLockQuestions,
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
import type { RadiusQuestion } from "@/maps/schema";

import { AnswerSplitPreview } from "./answerSplit";
import { QuestionCard } from "./base";

/**
 * The radius field. A radius only counts above zero, but "0" is on the way to
 * "0.5": the field shows what the player types, and saves the last value
 * above zero typed, 500 ms after the last keystroke (like the other fields, so
 * the map isn't redrawn for each digit) or as soon as the field loses focus.
 * A radius set elsewhere meanwhile (a teammate, a quick pick) or the field
 * locking drops what was typed, and the field shows the stored radius.
 */
const RadiusField = ({
    radius,
    disabled,
    onRadius,
}: {
    radius: number;
    disabled: boolean;
    onRadius: (radius: number) => void;
}) => {
    // What the player typed, and the stored radius it was typed over.
    const [draft, setDraft] = useState<{ text: string; over: number }>();
    const pending = useRef<{
        radius: number;
        timer: ReturnType<typeof setTimeout>;
    }>(undefined);
    const save = useRef(onRadius);
    useEffect(() => {
        save.current = onRadius;
    });
    const cancel = () => {
        clearTimeout(pending.current?.timer);
        pending.current = undefined;
    };
    const flush = () => {
        const typed = pending.current?.radius;
        cancel();
        if (typed === undefined) return;
        // The draft now stands over the radius it saved.
        setDraft((draft) => draft && { ...draft, over: typed });
        save.current(typed);
    };
    // Saved when the card goes, say when its sheet closes under the field.
    useEffect(() => flush, []);

    const stale =
        draft !== undefined && (!Object.is(draft.over, radius) || disabled);
    useEffect(() => {
        if (!stale) return;
        cancel();
        setDraft(undefined);
    }, [stale]);

    return (
        <RawInput
            type="number"
            className="rounded-md p-2 w-16"
            min={0}
            // Another client may have stored none.
            value={draft && !stale ? draft.text : (radius ?? "")}
            disabled={disabled}
            onChange={(e) => {
                const text = e.target.value;
                setDraft({ text, over: draft && !stale ? draft.over : radius });
                // A cleared field, or one reading zero or less, keeps the
                // radius (and any typed but not yet saved).
                const typed = parseFloat(text);
                if (!(typed > 0) || !Number.isFinite(typed)) return;
                cancel();
                pending.current = {
                    radius: typed,
                    timer: setTimeout(flush, 500),
                };
            }}
            onBlur={() => {
                flush();
                setDraft(undefined);
            }}
        />
    );
};

export const RadiusQuestionComponent = ({
    data,
    questionKey,
    sub,
}: {
    data: RadiusQuestion;
    questionKey: number;
    sub?: string;
}) => {
    useStore(triggerLocalRefresh);
    const $hiderMode = useStore(hiderMode);
    const $questions = useStore(questions);
    const $isLoading = useStore(isLoading);
    const $compiledGame = useStore(compiledGameAtom);
    // Radii the game declares, offered as quick picks when there are several.
    const declaredRadii = $compiledGame ? radarRadii($compiledGame) : [];
    // Compared in meters, so a typed 2 km also picks a declared 2000 m.
    const variant = storedRadarVariant(data.radius, data.unit);
    const declaredIndex =
        variant === undefined
            ? -1
            : declaredRadii.findIndex(
                  (r) => radarVariant(r.value, r.unit) === variant,
              );
    // Sizes other radars asked, marked (but still offered) in the quick picks.
    const askedRadii = askedVariants($questions, "radius", questionKey);
    const label = defaultQuestionLabel($questions, questionKey);

    return (
        <QuestionCard
            questionKey={questionKey}
            label={label}
            name={questionName(data)}
            setName={(name) => questionModified(setQuestionName(data, name))}
            sub={sub}
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
                    <RadiusField
                        radius={data.radius}
                        disabled={!data.drag || $isLoading}
                        onRadius={(radius) =>
                            questionModified((data.radius = radius))
                        }
                    />
                    <UnitSelect
                        unit={data.unit}
                        disabled={!data.drag || $isLoading}
                        onChange={(unit) =>
                            questionModified((data.unit = unit))
                        }
                    />
                </div>
            </SidebarMenuItem>
            {declaredRadii.length > 1 && (
                <ToggleGroup
                    className="grid grid-cols-3 gap-1 px-2 pb-2"
                    type="single"
                    variant="outline"
                    size="sm"
                    value={declaredIndex < 0 ? "" : String(declaredIndex)}
                    onValueChange={(value: string) => {
                        const radius = declaredRadii[Number(value)];
                        if (!value || !radius) return;
                        data.radius = radius.value;
                        data.unit = radius.unit;
                        questionModified();
                    }}
                    disabled={!data.drag || $isLoading}
                >
                    {declaredRadii.map((radius, index) => {
                        const asked = askedRadii.has(
                            radarVariant(radius.value, radius.unit),
                        );
                        return (
                            <ToggleGroupItem
                                key={index}
                                value={String(index)}
                                className={cn(
                                    "whitespace-nowrap",
                                    asked &&
                                        "gap-1 data-[state=off]:text-muted-foreground [&_svg]:size-3",
                                )}
                                title={asked ? "Asked already" : undefined}
                            >
                                {formatRadius(radius)}
                                {asked && (
                                    <>
                                        <CheckIcon aria-hidden />
                                        <span className="sr-only">
                                            , asked already
                                        </span>
                                    </>
                                )}
                            </ToggleGroupItem>
                        );
                    })}
                </ToggleGroup>
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
                    value={data.within ? "inside" : "outside"}
                    onValueChange={(value: "inside" | "outside") =>
                        questionModified((data.within = value === "inside"))
                    }
                    disabled={!!$hiderMode || !data.drag || $isLoading}
                >
                    <ToggleGroupItem value="outside">Outside</ToggleGroupItem>
                    <ToggleGroupItem value="inside">Inside</ToggleGroupItem>
                </ToggleGroup>
            </div>
            <AnswerSplitPreview questionKey={questionKey} data={data} />
        </QuestionCard>
    );
};
