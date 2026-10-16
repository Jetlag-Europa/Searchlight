import { useStore } from "@nanostores/react";
import type { DistanceRadius } from "@searchlight/shared";

import { LatitudeLongitude } from "@/components/LatLngPicker";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
    MENU_ITEM_CLASSNAME,
    SidebarMenuItem,
} from "@/components/ui/sidebar-l";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { UnitSelect } from "@/components/UnitSelect";
import { radarRadii } from "@/game-definition/compile";
import { compiledGameAtom } from "@/game-definition/store";
import {
    autoLockQuestions,
    hiderMode,
    isLoading,
    questionModified,
    questions,
    triggerLocalRefresh,
} from "@/lib/context";
import { cn } from "@/lib/utils";
import type { RadiusQuestion } from "@/maps/schema";

import { QuestionCard } from "./base";

const UNIT_ABBREVIATIONS: Record<DistanceRadius["unit"], string> = {
    meters: "m",
    kilometers: "km",
    miles: "mi",
};

// Short label for a quick-pick radius: 500 meters -> "500 m", 2000 -> "2 km".
const formatRadius = ({ value, unit }: DistanceRadius) =>
    unit === "meters" && value >= 1000 && value % 100 === 0
        ? `${value / 1000} km`
        : `${value} ${UNIT_ABBREVIATIONS[unit]}`;

export const RadiusQuestionComponent = ({
    data,
    questionKey,
    sub,
    className,
}: {
    data: RadiusQuestion;
    questionKey: number;
    sub?: string;
    className?: string;
}) => {
    useStore(triggerLocalRefresh);
    const $hiderMode = useStore(hiderMode);
    const $questions = useStore(questions);
    const $isLoading = useStore(isLoading);
    const $compiledGame = useStore(compiledGameAtom);
    // Radii the game declares, offered as quick picks when there are several.
    const declaredRadii = $compiledGame ? radarRadii($compiledGame) : [];
    const declaredIndex = declaredRadii.findIndex(
        (r) => r.value === data.radius && r.unit === data.unit,
    );
    const label = `Radius
    ${
        $questions
            .filter((q) => q.id === "radius")
            .map((q) => q.key)
            .indexOf(questionKey) + 1
    }`;

    return (
        <QuestionCard
            questionKey={questionKey}
            label={label}
            sub={sub}
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
                        disabled={!data.drag || $isLoading}
                        onChange={(e) =>
                            questionModified(
                                (data.radius = parseFloat(e.target.value)),
                            )
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
                    {declaredRadii.map((radius, index) => (
                        <ToggleGroupItem
                            key={index}
                            value={String(index)}
                            className="whitespace-nowrap"
                        >
                            {formatRadius(radius)}
                        </ToggleGroupItem>
                    ))}
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
        </QuestionCard>
    );
};
