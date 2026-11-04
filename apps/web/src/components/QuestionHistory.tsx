import { useStore } from "@nanostores/react";
import {
    type ReactNode,
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
} from "react";

import { Button } from "@/components/ui/button";
import type { CompiledGame } from "@/game-definition/compile";
import { compiledGameAtom } from "@/game-definition/store";
import {
    activeSessionId,
    sessionReadOnly,
    verifiedUserId,
} from "@/lib/activeSession";
import {
    defaultUnit,
    isLoading,
    pendingEventCount,
    questions,
} from "@/lib/context";
import {
    showAlreadyOnBoard,
    showRestoredToast,
} from "@/lib/deleteQuestionsWithUndo";
import {
    type HistoryLine,
    historyLines,
    type RemovedQuestion,
} from "@/lib/historyLines";
import {
    questionConflicts,
    questionDecisionsPossible,
} from "@/lib/questionConflicts";
import {
    formatHistoryTime,
    historyOf,
    loadedHistory,
    loadNewerHistory,
    loadNewestHistory,
    loadOlderHistory,
    QuestionHistoryError,
    restorable,
    restoreFromHistory,
} from "@/lib/questionHistory";
import { hasPendingQuestionSave } from "@/lib/sessionState";
import { onQuestionsSaved } from "@/lib/syncManager";

// Long enough for a burst of edits.
const REFRESH_DELAY_MS = 1500;
// How long a save may wait before the History says it isn't in there yet:
// each of the player's own saves waits a moment.
const UNSAVED_NOTE_DELAY_MS = 3000;
// The start of what restorable() says of a question that's back.
const ON_THE_BOARD = "On the board";
// Older pages loaded on their own while the loaded ones show nothing, such as
// a run of saves that only folded cards.
const MAX_AUTO_OLDER = 5;

const Note = ({ children }: { children: ReactNode }) => (
    <p className="px-4 py-2 text-sm text-muted-foreground">{children}</p>
);

export interface HistoryListProps {
    lines: readonly HistoryLine[];
    current: readonly { key: number }[];
    compiled: Pick<CompiledGame, "questionMap"> | null;
    disabled: boolean;
    // A spectator can't change the board: no Restore at all.
    readOnly?: boolean;
    onRestore: (targets: RemovedQuestion[]) => void;
}

/** The lines, newest first, with Restore on deleted questions. */
export const HistoryList = ({
    lines,
    current,
    compiled,
    disabled,
    readOnly = false,
    onRestore,
}: HistoryListProps) => {
    // Restore, or why not, as visible text: a disabled button's tooltip never
    // shows on a phone.
    const restoreControl = (targets: RemovedQuestion[]) => {
        if (readOnly) return null;
        const checks = targets.map((t) => restorable(t, current, compiled));
        const unavailable = checks.find((c) => c.status === "unavailable");
        if (!checks.some((c) => c.status === "ok")) {
            let reason =
                unavailable?.status === "unavailable" ? unavailable.reason : "";
            // Several back: one's label ("On the board as Radius 1") would
            // read as where all of them are.
            const back = checks.filter(
                (c) =>
                    c.status === "unavailable" &&
                    c.reason.startsWith(ON_THE_BOARD),
            );
            if (back.length > 1 && reason.startsWith(ON_THE_BOARD)) {
                reason = ON_THE_BOARD;
            }
            // Two lines at most, beside the change: "On the board as" a long
            // name is cut short there, the rest is read whole.
            return (
                <span
                    className="line-clamp-2 max-w-[7rem] shrink-0 break-words py-1 text-right text-xs leading-5 text-muted-foreground"
                    title={reason}
                >
                    {reason}
                </span>
            );
        }
        return (
            <Button
                variant="outline"
                size="sm"
                className="h-7 shrink-0 px-2 text-xs"
                disabled={disabled}
                onClick={() => onRestore(targets)}
            >
                {targets.length > 1 ? "Restore all" : "Restore"}
            </Button>
        );
    };

    return (
        <ul className="flex flex-col">
            {lines.map((line) => {
                const { day, time } = formatHistoryTime(line.at);
                return (
                    <li
                        key={line.id}
                        className="flex items-start gap-2 border-b border-border/50 px-3 py-2 text-sm"
                    >
                        <time
                            dateTime={line.at}
                            title={new Date(line.at).toLocaleString()}
                            className="shrink-0 whitespace-nowrap text-xs leading-5 tabular-nums text-muted-foreground"
                        >
                            {day && <span className="block">{day}</span>}
                            {time}
                        </time>
                        <div className="min-w-0 flex-1 break-words">
                            <span className="font-semibold">{line.who}</span>{" "}
                            {line.text}
                            {line.items && (
                                <details className="mt-1 text-xs text-muted-foreground">
                                    <summary className="cursor-pointer select-none">
                                        Show questions
                                    </summary>
                                    <ul className="mt-1 flex flex-col gap-1">
                                        {line.items.map((item, i) => (
                                            <li
                                                key={i}
                                                className="flex items-center justify-between gap-2"
                                            >
                                                <span className="min-w-0 break-words">
                                                    {item.label}
                                                </span>
                                                {item.removed &&
                                                    restoreControl([
                                                        item.removed,
                                                    ])}
                                            </li>
                                        ))}
                                    </ul>
                                </details>
                            )}
                        </div>
                        {line.removed && restoreControl(line.removed)}
                    </li>
                );
            })}
        </ul>
    );
};

export const QuestionHistory = () => {
    const sessionId = useStore(activeSessionId);
    const $questions = useStore(questions);
    const $isLoading = useStore(isLoading);
    const selfId = useStore(verifiedUserId);
    const unit = useStore(defaultUnit);
    const compiled = useStore(compiledGameAtom);
    // Whether Restore is offered depends on these too (restoreBlocked).
    useStore(questionConflicts);
    useStore(questionDecisionsPossible);
    const $readOnly = useStore(sessionReadOnly);
    // For the note on changes not saved yet: re-read as the queue changes.
    useStore(pendingEventCount);

    const loaded = useStore(loadedHistory);
    // Kept while the History is hidden (loadedHistory): shown at once when
    // it opens again, and only brought up to date.
    const shown = sessionId ? historyOf(sessionId, loaded) : null;
    const history = shown?.history ?? null;
    // The last refresh failed: what's shown may be behind.
    const refreshFailed = shown?.refreshFailed ?? false;
    // Why there's nothing to show: the first load failed, or the API can't
    // tell.
    const [problem, setProblem] = useState<"error" | "unavailable" | null>(
        null,
    );
    const [olderState, setOlderState] = useState<"idle" | "loading" | "error">(
        "idle",
    );
    const unavailable = useRef(false);
    const autoOlder = useRef(0);
    const firstLoad = useRef(false);

    const fail = useCallback((error: unknown) => {
        // A 404 is an API without this route (web and API are deployed
        // separately), or a session that's gone: asking again won't help.
        if (error instanceof QuestionHistoryError && error.status === 404) {
            unavailable.current = true;
            setProblem("unavailable");
            return;
        }
        // Shown only while there's no history: a failed refresh keeps it.
        setProblem("error");
    }, []);

    const loadNewestPage = useCallback(async () => {
        if (!sessionId || unavailable.current) return;
        autoOlder.current = 0;
        setOlderState("idle");
        firstLoad.current = !historyOf(sessionId);
        let current = true;
        try {
            current = await loadNewestHistory(sessionId);
            if (current) setProblem(null);
        } catch (error) {
            fail(error);
        } finally {
            if (current) firstLoad.current = false;
        }
    }, [sessionId, fail]);

    // The saves since the newest one loaded, on top.
    const loadNewer = useCallback(async () => {
        if (!sessionId || unavailable.current) return;
        // Still on its first page, which will include this change; after a
        // failed first load, try again.
        if (!historyOf(sessionId) && firstLoad.current) return;
        try {
            // Nothing loaded, or too many to tell: start again from the
            // newest page.
            if ((await loadNewerHistory(sessionId)) === "more") {
                return loadNewestPage();
            }
        } catch (error) {
            fail(error);
        }
    }, [sessionId, fail, loadNewestPage]);

    const loadOlder = useCallback(async () => {
        if (!sessionId || !historyOf(sessionId)?.history.nextBefore) return;
        setOlderState("loading");
        try {
            if (await loadOlderHistory(sessionId)) setOlderState("idle");
        } catch {
            setOlderState("error");
        }
    }, [sessionId]);

    // On opening, and for another session, account or role: what was
    // loaded before, brought up to date, or the newest page.
    useEffect(() => {
        unavailable.current = false;
        setProblem(null);
        if (sessionId && historyOf(sessionId)) void loadNewer();
        else void loadNewestPage();
    }, [sessionId, selfId, $readOnly, loadNewer, loadNewestPage]);

    // Keep it current while it's shown: once a change reaches the board, and
    // once a question save of this device's is in, however long it took.
    useEffect(() => {
        if (!sessionId) return;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const refresh = () => {
            clearTimeout(timer);
            timer = setTimeout(() => void loadNewer(), REFRESH_DELAY_MS);
        };
        const stopBoard = questions.listen(refresh);
        const stopSaves = onQuestionsSaved((saved) => {
            if (saved.sessionId === sessionId) refresh();
        });
        return () => {
            clearTimeout(timer);
            stopBoard();
            stopSaves();
        };
    }, [sessionId, loadNewer]);

    // And on coming back: online again, or the app shown again.
    useEffect(() => {
        if (!sessionId) return;
        const refresh = () => void loadNewer();
        const onVisible = () => {
            if (document.visibilityState === "visible") refresh();
        };
        window.addEventListener("online", refresh);
        document.addEventListener("visibilitychange", onVisible);
        return () => {
            window.removeEventListener("online", refresh);
            document.removeEventListener("visibilitychange", onVisible);
        };
    }, [sessionId, loadNewer]);

    const [online, setOnline] = useState(
        () => typeof navigator === "undefined" || navigator.onLine,
    );
    useEffect(() => {
        const update = () => setOnline(navigator.onLine);
        update();
        window.addEventListener("online", update);
        window.addEventListener("offline", update);
        return () => {
            window.removeEventListener("online", update);
            window.removeEventListener("offline", update);
        };
    }, []);
    // Changes not saved yet aren't in the History until they are. Said
    // offline, or once a save has waited a while, not for every save.
    const pending =
        !!sessionId && !$readOnly && hasPendingQuestionSave(sessionId);
    const [slowSave, setSlowSave] = useState(false);
    useEffect(() => {
        setSlowSave(false);
        if (!pending) return;
        const timer = setTimeout(
            () => setSlowSave(true),
            UNSAVED_NOTE_DELAY_MS,
        );
        return () => clearTimeout(timer);
    }, [pending]);

    const lines = useMemo(
        () => historyLines(history?.entries ?? [], { selfId, unit }),
        [history, selfId, unit],
    );

    useEffect(() => {
        if (!history || olderState !== "idle") return;
        if (lines.length > 0 || !history.nextBefore) return;
        if (autoOlder.current >= MAX_AUTO_OLDER) return;
        autoOlder.current++;
        void loadOlder();
    }, [olderState, lines.length, history, loadOlder]);

    const unsaved = pending && (!online || slowSave);
    const unsavedNote = unsaved && (
        <p className="px-4 py-2 text-xs text-muted-foreground">
            Your latest changes will show here once they&apos;re saved.
        </p>
    );

    if (!sessionId || problem === "unavailable") {
        return <Note>History isn&apos;t available for this session.</Note>;
    }
    if (!history && problem === "error") {
        return (
            <div className="flex flex-col pb-2">
                {unsavedNote}
                <div className="flex flex-col items-start gap-2 px-4 py-2 text-sm">
                    <p className="text-muted-foreground">
                        Couldn&apos;t load the history.
                    </p>
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                            setProblem(null);
                            void loadNewestPage();
                        }}
                    >
                        Try again
                    </Button>
                </div>
            </div>
        );
    }
    if (!history) return <Note>Loading…</Note>;

    const hasOlder = !!history.nextBefore;
    return (
        <div className="flex flex-col pb-2">
            {unsavedNote}
            {refreshFailed && (
                <div className="flex items-center justify-between gap-2 px-4 py-1 text-xs text-muted-foreground">
                    <span>Couldn&apos;t refresh</span>
                    <Button
                        variant="outline"
                        size="sm"
                        className="h-7 px-2 text-xs"
                        onClick={() => void loadNewer()}
                    >
                        Try again
                    </Button>
                </div>
            )}
            {lines.length === 0 &&
                (!hasOlder ? (
                    <Note>No changes yet</Note>
                ) : olderState === "loading" ? (
                    <Note>Loading…</Note>
                ) : (
                    <Note>No question changes recently.</Note>
                ))}
            <HistoryList
                lines={lines}
                current={$questions}
                compiled={compiled}
                disabled={$isLoading}
                readOnly={$readOnly}
                onRestore={(targets) => {
                    const { back, alreadyBack } = restoreFromHistory(targets);
                    if (back.length > 0) showRestoredToast(back);
                    else if (alreadyBack > 0) showAlreadyOnBoard();
                }}
            />
            {hasOlder && (
                <div className="flex flex-col items-center gap-1 px-4 pt-2">
                    <Button
                        variant="outline"
                        size="sm"
                        disabled={olderState === "loading"}
                        onClick={() => void loadOlder()}
                    >
                        {olderState === "loading" ? "Loading…" : "Show older"}
                    </Button>
                    {olderState === "error" && (
                        <p className="text-xs text-muted-foreground">
                            Couldn&apos;t load older changes.
                        </p>
                    )}
                </div>
            )}
        </div>
    );
};
