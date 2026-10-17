import { useStore } from "@nanostores/react";
import { ArrowDownIcon, ArrowUpIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
    MENU_ITEM_CLASSNAME,
    SidebarMenuItem,
} from "@/components/ui/sidebar-l";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { compiledGameAtom } from "@/game-definition/store";
import {
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
import {
    formatMultiplier,
    isZoneSizeChange,
    validMultiplier,
    zoneScaleAfter,
} from "@/lib/zoneSize";
import type { ZoneSizeChange } from "@/maps/schema";

import { QuestionCard } from "./base";

// The game's curses usually shrink the zones by half or grow them by half.
const QUICK_MULTIPLIERS = [0.5, 1.5];

/**
 * A curse that resizes the hiding zones. Its place in the list is when it was
 * cast: the questions below it test the zones at the new size, the ones
 * above at the size they were asked at.
 */
export const ZoneSizeComponent = ({
    data,
    questionKey,
    className,
}: {
    data: ZoneSizeChange;
    questionKey: number;
    className?: string;
}) => {
    useStore(triggerLocalRefresh);
    const $questions = useStore(questions);
    const $isLoading = useStore(isLoading);
    const $compiledGame = useStore(compiledGameAtom);
    const label = defaultQuestionLabel($questions, questionKey);

    const multiplier = validMultiplier(data.multiplier);
    const index = $questions.findIndex((q) => q.key === questionKey);
    const scale = zoneScaleAfter($questions, index + 1);
    const affected = $questions
        .slice(index + 1)
        .filter((q) => !isZoneSizeChange(q) && q.data.enabled !== false).length;
    const circles = ($compiledGame?.hidingZones.stations ?? []).filter(
        (zone) => !zone.area,
    );
    const baseRadius = $compiledGame?.hidingZones.baseRadius;
    // Tier and per-zone radii differ from the game's, as in the zone sidebar.
    const varies =
        !!baseRadius &&
        circles.some(
            (zone) =>
                zone.radius?.value !== baseRadius.value ||
                zone.radius?.unit !== baseRadius.unit,
        );

    // Moving the change past a question changes which size that question
    // was asked at. Saved right away, like deleting.
    const move = (offset: number) => {
        const list = [...questions.get()];
        const from = list.findIndex((q) => q.key === questionKey);
        const to = from + offset;
        if (from < 0 || to < 0 || to >= list.length) return;
        [list[from], list[to]] = [list[to], list[from]];
        questions.set(list);
    };

    return (
        <QuestionCard
            questionKey={questionKey}
            label={label}
            name={questionName(data)}
            setName={(name) => questionModified(setQuestionName(data, name))}
            sub={formatMultiplier(multiplier)}
            className={className}
            collapsed={data.collapsed}
            setCollapsed={(collapsed) => {
                data.collapsed = collapsed; // Doesn't trigger a re-render so no need for questionModified
            }}
            enabled={data.enabled ?? true}
            setEnabled={(v) => questionModified((data.enabled = v))}
        >
            <SidebarMenuItem>
                <div
                    className={cn(
                        MENU_ITEM_CLASSNAME,
                        "gap-2 flex flex-row items-center",
                    )}
                >
                    <Label className="font-semibold whitespace-nowrap">
                        Multiply by
                    </Label>
                    <Input
                        type="number"
                        className="rounded-md p-2 grow"
                        min={0.25}
                        step={0.25}
                        value={multiplier}
                        disabled={$isLoading}
                        onChange={(e) => {
                            // Keep the last multiplier while the field is
                            // cleared or reads zero.
                            const multiplier = parseFloat(e.target.value);
                            if (!(multiplier > 0)) return;
                            questionModified((data.multiplier = multiplier));
                        }}
                    />
                </div>
            </SidebarMenuItem>
            <SidebarMenuItem>
                <ToggleGroup
                    className="grid grid-cols-2 gap-1 px-2 pb-2"
                    type="single"
                    variant="outline"
                    size="sm"
                    value={
                        QUICK_MULTIPLIERS.includes(multiplier)
                            ? String(multiplier)
                            : ""
                    }
                    onValueChange={(value: string) => {
                        if (!value) return;
                        questionModified((data.multiplier = Number(value)));
                    }}
                    disabled={$isLoading}
                >
                    {QUICK_MULTIPLIERS.map((multiplier) => (
                        <ToggleGroupItem
                            key={multiplier}
                            value={String(multiplier)}
                        >
                            {formatMultiplier(multiplier)}
                        </ToggleGroupItem>
                    ))}
                </ToggleGroup>
            </SidebarMenuItem>
            <SidebarMenuItem
                className={cn(MENU_ITEM_CLASSNAME, "text-sm block")}
            >
                {circles.length > 0 && baseRadius && (
                    <p>
                        Zones from here:{" "}
                        <span className="font-semibold">
                            {Number((baseRadius.value * scale).toFixed(3))}{" "}
                            {baseRadius.unit}
                        </span>{" "}
                        ({formatMultiplier(scale)} the game&apos;s)
                        {varies && ", varies by zone"}
                    </p>
                )}
                <p className="text-muted-foreground">
                    {affected === 0
                        ? "Applies to questions added below it."
                        : `Applies to the ${affected === 1 ? "question" : `${affected} questions`} below it.`}{" "}
                    Move it to where the curse was cast.
                </p>
            </SidebarMenuItem>
            <SidebarMenuItem className="flex gap-2 px-2 justify-center">
                <Button
                    variant="outline"
                    size="sm"
                    onClick={() => move(-1)}
                    disabled={$isLoading || index <= 0}
                >
                    <ArrowUpIcon /> Earlier
                </Button>
                <Button
                    variant="outline"
                    size="sm"
                    onClick={() => move(1)}
                    disabled={$isLoading || index >= $questions.length - 1}
                >
                    <ArrowDownIcon /> Later
                </Button>
            </SidebarMenuItem>
        </QuestionCard>
    );
};
