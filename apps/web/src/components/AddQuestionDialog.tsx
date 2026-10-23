import { useStore } from "@nanostores/react";
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
    followMe,
    isLoading,
    lastGpsFix,
    leafletMapContext,
} from "@/lib/context";
import {
    newQuestionPosition,
    newThermometerData,
} from "@/lib/questionPosition";
import { newQuestionKey } from "@/maps/schema";

// New questions start at the seeker while Follow Me knows where they are, so
// they don't have to tap "Set to current location" on every card. Uses the
// watch's last fix: adding never waits on (or prompts for) a new one.
const startPosition = () => {
    const map = leafletMapContext.get();
    if (!map) return null;
    return newQuestionPosition(
        map.getCenter(),
        followMe.get(),
        lastGpsFix.get(),
    );
};

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
    // addQuestion starts each question at the first type (or radar size) not
    // asked yet; the card offers the others.
    const runAddRadius = () => {
        const center = startPosition();
        if (!center) return false;
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
        const center = startPosition();
        if (!center) return false;
        addQuestion({ id: "thermometer", data: newThermometerData(center) });
        return true;
    };

    const runAddTentacles = () => {
        const center = startPosition();
        if (!center) return false;
        addQuestion({
            id: "tentacles",
            data: defaultCustomQuestions.get()
                ? {
                      lat: center.lat,
                      lng: center.lng,
                      locationType: "custom",
                      places: [],
                  }
                : { lat: center.lat, lng: center.lng },
        });
        return true;
    };

    const runAddMatching = () => {
        const center = startPosition();
        if (!center) return false;
        addQuestion({
            id: "matching",
            data: defaultCustomQuestions.get()
                ? { lat: center.lat, lng: center.lng, type: "custom-points" }
                : { lat: center.lat, lng: center.lng },
        });
        return true;
    };

    const runAddMeasuring = () => {
        const center = startPosition();
        if (!center) return false;
        addQuestion({
            id: "measuring",
            data: defaultCustomQuestions.get()
                ? { lat: center.lat, lng: center.lng, type: "custom-measure" }
                : { lat: center.lat, lng: center.lng },
        });
        return true;
    };
    // A curse that resizes the hiding zones, cast now: it applies to the
    // questions asked after it, which are added below it.
    const runAddZoneSize = () => {
        addQuestion({ id: "zone-size", data: {} });
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
                            ? { ...parsed, key: newQuestionKey() }
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
                        className={
                            !hasRadius ? "opacity-40 cursor-not-allowed" : ""
                        }
                    >
                        Add Radius {compiled && !hasRadius && "(Disabled)"}
                    </SidebarMenuButton>
                    <SidebarMenuButton
                        onClick={() => {
                            if (runAddThermometer()) setOpen(false);
                        }}
                        disabled={disabled || !hasThermometer}
                        className={
                            !hasThermometer
                                ? "opacity-40 cursor-not-allowed"
                                : ""
                        }
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
                        onClick={() => {
                            if (runAddZoneSize()) setOpen(false);
                        }}
                        disabled={disabled}
                    >
                        Resize Hiding Zones (Curse)
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
