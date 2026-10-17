import { useStore } from "@nanostores/react";
import * as turf from "@turf/turf";
import React from "react";
import { toast } from "react-toastify";

import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogTitle,
    DialogTrigger,
} from "@/components/ui/dialog";
import { SidebarMenuButton } from "@/components/ui/sidebar-l";
import { compiledGameAtom } from "@/game-definition/store";
import {
    addQuestion,
    defaultCustomQuestions,
    isLoading,
    leafletMapContext,
} from "@/lib/context";
export const AddQuestionDialog = ({
    children,
}: {
    children: React.ReactNode;
}) => {
    const $isLoading = useStore(isLoading);
    const compiled = useStore(compiledGameAtom);
    const [open, setOpen] = React.useState(false);

    // Questions come from the game: nothing can be added until it has loaded.
    const disabled = $isLoading || !compiled;
    const hasRadius =
        compiled?.questions.some((q) => q.family === "radius") ?? false;
    const hasThermometer =
        compiled?.questions.some((q) => q.family === "thermometer") ?? false;
    // Player-drawn custom questions are allowed in every game, so a family
    // without compiled questions still adds its custom variant (addQuestion).
    const hasTentacles =
        compiled?.questions.some((q) => q.family === "tentacle") ?? false;
    const hasMatching =
        compiled?.questions.some((q) => q.family === "matching") ?? false;
    const hasMeasuring =
        compiled?.questions.some((q) => q.family === "measuring") ?? false;
    // addQuestion starts the radar at the game's first declared radius; the
    // card offers the others as quick picks.
    const runAddRadius = () => {
        const map = leafletMapContext.get();
        if (!map) return false;
        const center = map.getCenter();
        addQuestion({
            id: "radius",
            data: {
                lat: center.lat,
                lng: center.lng,
            },
        });
        return true;
    };

    const runAddThermometer = () => {
        const map = leafletMapContext.get();
        if (!map) return false;
        const center = map.getCenter();
        const destination = turf.destination([center.lng, center.lat], 5, 90, {
            units: "kilometers",
        });

        addQuestion({
            id: "thermometer",
            data: {
                latA: center.lat,
                lngB: center.lng,
                latB: destination.geometry.coordinates[1],
                lngA: destination.geometry.coordinates[0],
            },
        });

        return true;
    };

    const runAddTentacles = () => {
        const map = leafletMapContext.get();
        if (!map) return false;
        const center = map.getCenter();
        const firstTentacle = compiled?.questions.find((q) => q.family === "tentacle");
        addQuestion({
            id: "tentacles",
            data: defaultCustomQuestions.get()
                ? {
                      lat: center.lat,
                      lng: center.lng,
                      locationType: "custom",
                      places: [],
                  }
                : {
                      lat: center.lat,
                      lng: center.lng,
                      locationType: firstTentacle ? firstTentacle.id : undefined,
                  },
        });
        return true;
    };

    const runAddMatching = () => {
        const map = leafletMapContext.get();
        if (!map) return false;
        const center = map.getCenter();
        const firstMatching = compiled?.questions.find((q) => q.family === "matching");
        addQuestion({
            id: "matching",
            data: defaultCustomQuestions.get()
                ? { lat: center.lat, lng: center.lng, type: "custom-points" }
                : {
                      lat: center.lat,
                      lng: center.lng,
                      type: firstMatching ? firstMatching.id : undefined,
                  },
        });
        return true;
    };

    const runAddMeasuring = () => {
        const map = leafletMapContext.get();
        if (!map) return false;
        const center = map.getCenter();
        const firstMeasuring = compiled?.questions.find((q) => q.family === "measuring");
        addQuestion({
            id: "measuring",
            data: defaultCustomQuestions.get()
                ? { lat: center.lat, lng: center.lng, type: "custom-measure" }
                : {
                      lat: center.lat,
                      lng: center.lng,
                      type: firstMeasuring ? firstMeasuring.id : undefined,
                  },
        });
        return true;
    };
    const runPasteQuestion = async () => {
        if (!navigator || !navigator.clipboard) {
            toast.error("Clipboard API not supported in your browser");
            return false;
        }

        try {
            await toast.promise(
                navigator.clipboard.readText().then((text) => {
                    const parsed = JSON.parse(text);
                    const question =
                        parsed &&
                        typeof parsed === "object" &&
                        !Array.isArray(parsed)
                            ? { ...parsed, key: Math.random() }
                            : parsed;

                    return addQuestion(question);
                }),
                {
                    pending: "Reading from clipboard",
                    success: "Question added from clipboard!",
                    error: "No valid question found in clipboard",
                },
                { autoClose: 1000 },
            );

            return true;
        } catch {
            return false;
        }
    };

    return (
        <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>{children}</DialogTrigger>
            <DialogContent>
                <DialogTitle>Add Question</DialogTitle>
                <DialogDescription>
                    {compiled
                        ? "Select which question type you would like to add."
                        : "Questions can be added once the game has loaded."}
                </DialogDescription>

                <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <SidebarMenuButton
                        onClick={() => {
                            if (runAddRadius()) setOpen(false);
                        }}
                        disabled={disabled || !hasRadius}
                        className={!hasRadius ? "opacity-40 cursor-not-allowed" : ""}
                    >
                        Add Radius {compiled && !hasRadius && "(Disabled)"}
                    </SidebarMenuButton>
                    <SidebarMenuButton
                        onClick={() => {
                            if (runAddThermometer()) setOpen(false);
                        }}
                        disabled={disabled || !hasThermometer}
                        className={!hasThermometer ? "opacity-40 cursor-not-allowed" : ""}
                    >
                        Add Thermometer{" "}
                        {compiled && !hasThermometer && "(Disabled)"}
                    </SidebarMenuButton>
                    <SidebarMenuButton
                        onClick={() => {
                            if (runAddTentacles()) setOpen(false);
                        }}
                        disabled={disabled}
                    >
                        Add Tentacles {compiled && !hasTentacles && "(Custom)"}
                    </SidebarMenuButton>
                    <SidebarMenuButton
                        onClick={() => {
                            if (runAddMatching()) setOpen(false);
                        }}
                        disabled={disabled}
                    >
                        Add Matching {compiled && !hasMatching && "(Custom)"}
                    </SidebarMenuButton>
                    <SidebarMenuButton
                        onClick={() => {
                            if (runAddMeasuring()) setOpen(false);
                        }}
                        disabled={disabled}
                    >
                        Add Measuring {compiled && !hasMeasuring && "(Custom)"}
                    </SidebarMenuButton>
                    <SidebarMenuButton
                        onClick={async () => {
                            const ok = await runPasteQuestion();
                            if (ok) setOpen(false);
                        }}
                        disabled={disabled}
                    >
                        Paste Question
                    </SidebarMenuButton>
                </div>
            </DialogContent>
        </Dialog>
    );
};
