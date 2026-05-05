import { useStore } from "@nanostores/react";
import { Eraser, Hand, Pen, Trash2, X } from "lucide-react";
import { useState } from "react";

import {
    allowFingerDrawing,
    clearAllStrokes,
    color as colorStore,
    drawingEnabled,
    tool as toolStore,
    widthPreset as widthPresetStore,
} from "@/annotations/hooks/useAnnotationStore";
import {
    type AnnotationTool,
    PEN_COLORS,
    type StrokeWidthPreset,
} from "@/annotations/types";
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Toggle } from "@/components/ui/toggle";
import { cn } from "@/lib/utils";

const tapStyle = { touchAction: "manipulation" as const };
const tapClass = "min-h-[44px] min-w-[44px]";

interface ToolButtonProps {
    icon: React.ReactNode;
    label: string;
    active: boolean;
    onClick: () => void;
}

function ToolButton({ icon, label, active, onClick }: ToolButtonProps) {
    return (
        <Button
            type="button"
            size="icon"
            variant={active ? "default" : "outline"}
            aria-label={label}
            title={label}
            onClick={onClick}
            style={tapStyle}
            className={tapClass}
        >
            {icon}
        </Button>
    );
}

interface SwatchProps {
    color: string;
    active: boolean;
    onClick: () => void;
}

function Swatch({ color, active, onClick }: SwatchProps) {
    return (
        <button
            type="button"
            aria-label={`Color ${color}`}
            onClick={onClick}
            style={{ ...tapStyle, backgroundColor: color }}
            className={cn(
                "rounded-md border-2 transition-all",
                tapClass,
                active
                    ? "border-white ring-2 ring-offset-2 ring-offset-background ring-primary"
                    : "border-border hover:border-foreground/40",
            )}
        />
    );
}

export function AnnotationToolbar() {
    const $tool = useStore(toolStore);
    const $color = useStore(colorStore);
    const $width = useStore(widthPresetStore);
    const $drawingEnabled = useStore(drawingEnabled);
    const $allowFinger = useStore(allowFingerDrawing);
    const [confirmOpen, setConfirmOpen] = useState(false);

    const setTool = (t: AnnotationTool) => toolStore.set(t);
    const setWidth = (w: StrokeWidthPreset) => widthPresetStore.set(w);

    return (
        <div
            className="flex items-center gap-1.5 rounded-lg bg-background/95 p-1.5 shadow-lg border border-border backdrop-blur-sm"
            style={tapStyle}
            data-annotation-toolbar
        >
            <Toggle
                pressed={$drawingEnabled}
                onPressedChange={(v) => drawingEnabled.set(v)}
                aria-label="Drawing on/off"
                title={$drawingEnabled ? "Drawing ON" : "Drawing OFF"}
                style={tapStyle}
                className={cn(
                    tapClass,
                    "border border-border",
                    $drawingEnabled
                        ? "bg-primary text-primary-foreground data-[state=on]:bg-primary data-[state=on]:text-primary-foreground"
                        : "",
                )}
                variant="outline"
            >
                {$drawingEnabled ? "ON" : "OFF"}
            </Toggle>

            {$drawingEnabled && (
                <>
                    <div className="w-px h-8 bg-border" />

                    <ToolButton
                        icon={<Pen />}
                        label="Pen"
                        active={$tool === "pen"}
                        onClick={() => setTool("pen")}
                    />
                    <ToolButton
                        icon={<Eraser />}
                        label="Eraser"
                        active={$tool === "eraser"}
                        onClick={() => setTool("eraser")}
                    />
                    <ToolButton
                        icon={<X strokeWidth={3} />}
                        label="Cross-out"
                        active={$tool === "crossout"}
                        onClick={() => setTool("crossout")}
                    />

                    <div className="w-px h-8 bg-border" />

                    {PEN_COLORS.map((c) => (
                        <Swatch
                            key={c}
                            color={c}
                            active={$color === c && $tool !== "crossout"}
                            onClick={() => {
                                colorStore.set(c);
                                if ($tool === "eraser") setTool("pen");
                            }}
                        />
                    ))}

                    <div className="w-px h-8 bg-border" />

                    <Button
                        type="button"
                        size="icon"
                        variant={$width === "thin" ? "default" : "outline"}
                        onClick={() => setWidth("thin")}
                        aria-label="Thin stroke"
                        title="Thin"
                        style={tapStyle}
                        className={tapClass}
                    >
                        <span className="block w-5 h-[2px] bg-current rounded-full" />
                    </Button>
                    <Button
                        type="button"
                        size="icon"
                        variant={$width === "thick" ? "default" : "outline"}
                        onClick={() => setWidth("thick")}
                        aria-label="Thick stroke"
                        title="Thick"
                        style={tapStyle}
                        className={tapClass}
                    >
                        <span className="block w-5 h-[6px] bg-current rounded-full" />
                    </Button>

                    <div className="w-px h-8 bg-border" />

                    <Toggle
                        pressed={$allowFinger}
                        onPressedChange={(v) => allowFingerDrawing.set(v)}
                        aria-label="Allow finger drawing"
                        title={
                            $allowFinger
                                ? "Finger drawing ON"
                                : "Finger drawing OFF (pen only)"
                        }
                        style={tapStyle}
                        className={cn(tapClass, "border border-border")}
                        variant="outline"
                    >
                        <Hand />
                    </Toggle>

                    <Button
                        type="button"
                        size="icon"
                        variant="destructive"
                        onClick={() => setConfirmOpen(true)}
                        aria-label="Clear all annotations"
                        title="Clear all"
                        style={tapStyle}
                        className={tapClass}
                    >
                        <Trash2 />
                    </Button>
                </>
            )}

            <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>
                            Clear all annotations?
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                            This deletes every drawn stroke. It cannot be
                            undone.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                            onClick={() => {
                                clearAllStrokes();
                                setConfirmOpen(false);
                            }}
                        >
                            Clear all
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </div>
    );
}
