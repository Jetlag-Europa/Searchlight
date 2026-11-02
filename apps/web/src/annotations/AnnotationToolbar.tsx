import { useStore } from "@nanostores/react";
import { Eraser, Pen, Pencil, Power, Trash2, X } from "lucide-react";
import { useState } from "react";

import {
    clearAllStrokes,
    color as colorStore,
    detectPencilOnly,
    drawingEnabled,
    penEraserActive,
    penToolbarVisible,
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
import { sessionReadOnly } from "@/lib/activeSession";
import { cn } from "@/lib/utils";

const tapStyle = { touchAction: "manipulation" as const };
const tapClass = "min-h-[44px] min-w-[44px]";

interface ToolButtonProps {
    icon: React.ReactNode;
    label: string;
    title?: string;
    active: boolean;
    onClick: () => void;
}

function ToolButton({ icon, label, title, active, onClick }: ToolButtonProps) {
    return (
        <Button
            type="button"
            size="icon"
            variant={active ? "default" : "outline"}
            aria-label={label}
            title={title ?? label}
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
    const $detectPencil = useStore(detectPencilOnly);
    const $visible = useStore(penToolbarVisible);
    const $penEraser = useStore(penEraserActive);
    const $readOnly = useStore(sessionReadOnly);
    const [confirmOpen, setConfirmOpen] = useState(false);

    // Spectators can't draw.
    if (!$visible || $readOnly) return null;

    const setTool = (t: AnnotationTool) => toolStore.set(t);
    const setWidth = (w: StrokeWidthPreset) => widthPresetStore.set(w);
    // A pen's eraser button erases whatever tool is chosen; show that.
    const toolInUse: AnnotationTool = $penEraser ? "eraser" : $tool;

    return (
        <div
            className="flex flex-col items-center gap-1.5 rounded-lg bg-background/95 p-1.5 shadow-lg border border-border backdrop-blur-sm"
            style={tapStyle}
            data-annotation-toolbar
        >
            <Toggle
                pressed={$drawingEnabled}
                onPressedChange={(v) => drawingEnabled.set(v)}
                aria-label="Pen mode on/off"
                title={$drawingEnabled ? "Pen Mode: ON" : "Pen Mode: OFF"}
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
                {$drawingEnabled ? <Power /> : <Pencil />}
            </Toggle>

            {$drawingEnabled && (
                <>
                    <div className="h-px w-8 bg-border" />

                    <ToolButton
                        icon={<Pen />}
                        label="Pen"
                        active={toolInUse === "pen"}
                        onClick={() => setTool("pen")}
                    />
                    <ToolButton
                        icon={<Eraser />}
                        label="Eraser"
                        title="Eraser (or your pen's eraser or side button)"
                        active={toolInUse === "eraser"}
                        onClick={() => setTool("eraser")}
                    />
                    <ToolButton
                        icon={<X strokeWidth={3} />}
                        label="Cross-out"
                        active={toolInUse === "crossout"}
                        onClick={() => setTool("crossout")}
                    />

                    <div className="h-px w-8 bg-border" />

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

                    <div className="h-px w-8 bg-border" />

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

                    <div className="h-px w-8 bg-border" />

                    <Toggle
                        pressed={$detectPencil}
                        onPressedChange={(v) => detectPencilOnly.set(v)}
                        aria-label="Detect pencil only"
                        title={
                            $detectPencil
                                ? "Detect Pencil: ON (stylus only)"
                                : "Detect Pencil: OFF (finger or stylus)"
                        }
                        style={tapStyle}
                        className={cn(tapClass, "border border-border")}
                        variant="outline"
                    >
                        <Pencil />
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
