import { useStore } from "@nanostores/react";
import { SidebarCloseIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
    AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
    Sidebar,
    SidebarContent,
    SidebarGroup,
    SidebarGroupContent,
    SidebarMenu,
    SidebarMenuButton,
    SidebarMenuItem,
} from "@/components/ui/sidebar-l";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { sessionReadOnly } from "@/lib/activeSession";
import { sidebarContextL as SidebarContext } from "@/lib/context";
import {
    autoSave,
    isLoading,
    questions,
    save,
    triggerLocalRefresh,
    warningAlarm,
} from "@/lib/context";
import { deleteQuestionsWithUndo } from "@/lib/deleteQuestionsWithUndo";
import { sameQuestionKey } from "@/lib/questionMerge";
import {
    questionCardToShow,
    questionSidebarTab,
} from "@/lib/questionSidebarTab";

import { AddQuestionDialog } from "./AddQuestionDialog";
import {
    MatchingQuestionComponent,
    MeasuringQuestionComponent,
    RadiusQuestionComponent,
    TentacleQuestionComponent,
    ThermometerQuestionComponent,
    ZoneSizeComponent,
} from "./QuestionCards";
import { QuestionHistory } from "./QuestionHistory";

export const QuestionSidebar = () => {
    useStore(triggerLocalRefresh);
    const $questions = useStore(questions);
    const $autoSave = useStore(autoSave);
    const $isLoading = useStore(isLoading);
    const $warningAlarm = useStore(warningAlarm);
    const $readOnly = useStore(sessionReadOnly);
    const [alarmActive, setAlarmActive] = useState(false);
    // History is only fetched while its tab is shown.
    const tab = useStore(questionSidebarTab);
    const audioRef = useRef<HTMLAudioElement | null>(null);
    const cardToShow = useStore(questionCardToShow);
    const sidebar = useStore(SidebarContext);
    // State, not a ref: a phone's sheet draws its content only once open,
    // a moment after it says so, and the card is looked for again then.
    const [content, setContent] = useState<HTMLDivElement | null>(null);

    // Show (after a Restore): once the sidebar is open on the cards, scroll
    // to the card and move focus to it. Not on the board any more (taken
    // away meanwhile), there is nothing to show.
    useEffect(() => {
        if (cardToShow === null || tab !== "questions") return;
        if (!$questions.some((q) => sameQuestionKey(q.key, cardToShow))) {
            questionCardToShow.set(null);
            return;
        }
        if (!(sidebar.isMobile ? sidebar.openMobile : sidebar.open)) return;
        const card = Array.from(
            content?.querySelectorAll<HTMLElement>("[data-question-key]") ??
                [],
        ).find((el) =>
            sameQuestionKey(Number(el.dataset.questionKey), cardToShow),
        );
        if (!card) return;
        questionCardToShow.set(null);
        card.scrollIntoView({ block: "center", behavior: "smooth" });
        card
            .querySelector<HTMLElement>("[data-question-card-header]")
            ?.focus({ preventScroll: true });
    }, [
        cardToShow,
        tab,
        $questions,
        content,
        sidebar.isMobile,
        sidebar.open,
        sidebar.openMobile,
    ]);

    const startAlarm = () => {
        if (!$warningAlarm) return;
        setAlarmActive(true);
        const audio = new Audio("/Mountain%20Audio%20-%20Alarm.mp3");
        audio.loop = true;
        audio.play().catch(() => {});
        audioRef.current = audio;
    };

    const stopAlarm = () => {
        setAlarmActive(false);
        if (audioRef.current) {
            audioRef.current.pause();
            audioRef.current.currentTime = 0;
            audioRef.current = null;
        }
    };

    return (
        <>
        {alarmActive && (
            <div className="warning-flash fixed inset-0 z-[1039] pointer-events-none" />
        )}
        <Sidebar>
            <div className="flex items-center justify-between">
                <h2 className="ml-4 mt-4 font-poppins text-2xl">Questions</h2>
                <SidebarCloseIcon
                    className="mr-2 visible md:hidden"
                    onClick={() => {
                        SidebarContext.get().setOpenMobile(false);
                    }}
                />
            </div>
            <ToggleGroup
                type="single"
                variant="outline"
                size="sm"
                // On a phone the session chips float over the sheet's top.
                className="mt-6 grid grid-cols-2 gap-1 px-4 pt-2 md:mt-0"
                value={tab}
                onValueChange={(value: string) => {
                    if (value === "questions" || value === "history") {
                        questionSidebarTab.set(value);
                    }
                }}
            >
                <ToggleGroupItem value="questions">Questions</ToggleGroupItem>
                <ToggleGroupItem value="history">History</ToggleGroupItem>
            </ToggleGroup>
            <SidebarContent ref={setContent}>
                {tab === "history" && <QuestionHistory />}
                {tab === "questions" && $questions.map((question) => {
                    switch (question.id) {
                        case "radius":
                            return (
                                <RadiusQuestionComponent
                                    data={question.data}
                                    key={question.key}
                                    questionKey={question.key}
                                />
                            );
                        case "thermometer":
                            return (
                                <ThermometerQuestionComponent
                                    data={question.data}
                                    key={question.key}
                                    questionKey={question.key}
                                />
                            );
                        case "tentacles":
                            return (
                                <TentacleQuestionComponent
                                    data={question.data}
                                    key={question.key}
                                    questionKey={question.key}
                                />
                            );
                        case "matching":
                            return (
                                <MatchingQuestionComponent
                                    data={question.data}
                                    key={question.key}
                                    questionKey={question.key}
                                />
                            );
                        case "measuring":
                            return (
                                <MeasuringQuestionComponent
                                    data={question.data}
                                    key={question.key}
                                    questionKey={question.key}
                                />
                            );
                        case "zone-size":
                            return (
                                <ZoneSizeComponent
                                    data={question.data}
                                    key={question.key}
                                    questionKey={question.key}
                                />
                            );
                        default:
                            return null;
                    }
                })}
            </SidebarContent>
            {/* A spectator can't add, delete or save questions. */}
            {tab === "questions" && ($readOnly ? (
                <SidebarGroup>
                    <p className="px-2 py-1 text-sm text-muted-foreground">
                        You&apos;re spectating: you can watch, but not change
                        the board.
                    </p>
                </SidebarGroup>
            ) : (
                <SidebarGroup>
                    <SidebarGroupContent>
                        <SidebarMenu>
                            <SidebarMenuItem>
                                <AddQuestionDialog>
                                    <SidebarMenuButton disabled={$isLoading}>
                                        Add Question
                                    </SidebarMenuButton>
                                </AddQuestionDialog>
                            </SidebarMenuItem>
                            <SidebarMenuItem>
                                <AlertDialog onOpenChange={(open) => open ? startAlarm() : stopAlarm()}>
                                    <AlertDialogTrigger asChild>
                                        <SidebarMenuButton
                                            className="bg-red-600 hover:bg-red-700 transition-colors"
                                            disabled={$isLoading}
                                        >
                                            Delete All Questions
                                        </SidebarMenuButton>
                                    </AlertDialogTrigger>
                                    <AlertDialogContent aria-describedby={undefined}>
                                        <AlertDialogHeader>
                                            <AlertDialogTitle>
                                                Are you absolutely sure?
                                            </AlertDialogTitle>
                                            <AlertDialogDescription>
                                                This will delete all questions for
                                                everyone in the session. You can
                                                undo it for a few seconds.
                                            </AlertDialogDescription>
                                        </AlertDialogHeader>
                                        <AlertDialogFooter>
                                            <AlertDialogCancel>
                                                Cancel
                                            </AlertDialogCancel>
                                            <AlertDialogAction
                                                onClick={() =>
                                                    deleteQuestionsWithUndo(
                                                        questions
                                                            .get()
                                                            .map((q) => q.key),
                                                    )
                                                }
                                            >
                                                Delete All Questions
                                            </AlertDialogAction>
                                        </AlertDialogFooter>
                                    </AlertDialogContent>
                                </AlertDialog>
                            </SidebarMenuItem>
                            {!$autoSave && (
                                <SidebarMenuItem>
                                    <SidebarMenuButton
                                        className="bg-blue-600 p-2 rounded-md font-semibold font-poppins transition-shadow duration-500"
                                        onClick={save}
                                        disabled={$isLoading}
                                    >
                                        Save
                                    </SidebarMenuButton>
                                </SidebarMenuItem>
                            )}
                        </SidebarMenu>
                    </SidebarGroupContent>
                </SidebarGroup>
            ))}
        </Sidebar>
        </>
    );
};
