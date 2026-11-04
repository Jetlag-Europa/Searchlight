import { useStore } from "@nanostores/react";
import { ArrowLeftIcon, HistoryIcon, SidebarCloseIcon } from "lucide-react";
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
} from "@/components/ui/sidebar";
import { sessionReadOnly } from "@/lib/activeSession";
import { sidebarContextL as SidebarContext } from "@/lib/context";
import {
    autoSave,
    isLoading,
    questions,
    save,
    sessionPickerOpen,
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
import { CardForQuestion } from "./QuestionCards";
import { QuestionHistory } from "./QuestionHistory";

export const QuestionSidebar = () => {
    useStore(triggerLocalRefresh);
    const $questions = useStore(questions);
    const $autoSave = useStore(autoSave);
    const $isLoading = useStore(isLoading);
    const $warningAlarm = useStore(warningAlarm);
    const $readOnly = useStore(sessionReadOnly);
    const [confirmOpen, setConfirmOpen] = useState(false);
    const [alarmActive, setAlarmActive] = useState(false);
    // History is only fetched while it's shown.
    const tab = useStore(questionSidebarTab);
    const audioRef = useRef<HTMLAudioElement | null>(null);
    const cardToShow = useStore(questionCardToShow);
    const sidebar = useStore(SidebarContext);
    const pickerOpen = useStore(sessionPickerOpen);
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
    // The confirm closes when the session picker opens: left open on a
    // desktop, it would stay over the next session's board and delete its
    // questions. A phone's sheet closing (the picker closes it), the desktop
    // sidebar turning into a sheet, or becoming a spectator (which hides the
    // button) takes the confirm along without saying it closed, so it must
    // not come back with the button.
    useEffect(() => {
        if ($readOnly || pickerOpen || !sidebar.openMobile) {
            setConfirmOpen(false);
            stopAlarm();
        }
    }, [$readOnly, pickerOpen, sidebar.openMobile, sidebar.isMobile]);

    return (
        <>
        {alarmActive && (
            <div className="warning-flash fixed inset-0 z-[1039] pointer-events-none" />
        )}
        <Sidebar>
            <div className="flex items-center justify-between">
                <h2 className="ml-4 mt-4 font-poppins text-2xl">
                    {tab === "history" ? "History" : "Questions"}
                </h2>
                <SidebarCloseIcon
                    className="mr-2 visible md:hidden"
                    onClick={() => {
                        SidebarContext.get().setOpenMobile(false);
                    }}
                />
            </div>
            <SidebarContent
                ref={setContent}
                // On a phone the session chips float over the sheet's top.
                className="mt-8 md:mt-0"
            >
                {tab === "history" && <QuestionHistory />}
                {tab === "questions" &&
                    $questions.map((question) => (
                        <CardForQuestion key={question.key} question={question} />
                    ))}
            </SidebarContent>
            <SidebarGroup>
                {/* A spectator can't add, delete or save questions. */}
                {tab === "questions" && $readOnly && (
                    <p className="px-2 py-1 text-sm text-muted-foreground">
                        You&apos;re spectating: you can watch, but not change
                        the board.
                    </p>
                )}
                <SidebarGroupContent>
                    <SidebarMenu>
                        {tab === "questions" && !$readOnly && (
                            <>
                                <SidebarMenuItem>
                                    <AddQuestionDialog>
                                        <SidebarMenuButton disabled={$isLoading}>
                                            Add Question
                                        </SidebarMenuButton>
                                    </AddQuestionDialog>
                                </SidebarMenuItem>
                                <SidebarMenuItem>
                                    <AlertDialog
                                        open={confirmOpen}
                                        onOpenChange={(open) => {
                                            setConfirmOpen(open);
                                            if (open) startAlarm();
                                            else stopAlarm();
                                        }}
                                    >
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
                            </>
                        )}
                        {/* Last, so it stays put when switching views. */}
                        <SidebarMenuItem>
                            <SidebarMenuButton
                                className="text-muted-foreground"
                                onClick={() =>
                                    questionSidebarTab.set(
                                        tab === "history"
                                            ? "questions"
                                            : "history",
                                    )
                                }
                            >
                                {tab === "history" ? (
                                    <>
                                        <ArrowLeftIcon />
                                        Back to questions
                                    </>
                                ) : (
                                    <>
                                        <HistoryIcon />
                                        History
                                    </>
                                )}
                            </SidebarMenuButton>
                        </SidebarMenuItem>
                    </SidebarMenu>
                </SidebarGroupContent>
            </SidebarGroup>
        </Sidebar>
        </>
    );
};
