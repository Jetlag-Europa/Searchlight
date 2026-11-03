import { useStore } from "@nanostores/react";
import type { QuestionHistoryResponse } from "@searchlight/shared";
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
    appendOlderPage,
    fetchQuestionHistory,
    formatHistoryTime,
    prependNewer,
    QuestionHistoryError,
    restorable,
    restoreFromHistory,
} from "@/lib/questionHistory";
import { hasPendingQuestionSave } from "@/lib/sessionState";

// Long enough for a burst of edits, and for an own save to reach the server.
const REFRESH_DELAY_MS = 1500;
// How many times a refresh waits for this device's own question save.
const MAX_SAVE_WAITS = 8;
// Older pages loaded on their own while the loaded ones show nothing, such as
// a run of saves that only folded cards.
const MAX_AUTO_OLDER = 5;

type LoadState = "loading" | "ready" | "error" | "unavailable";

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
    onRestore: (line: HistoryLine, targets: RemovedQuestion[]) => void;
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
    const restoreControl = (line: HistoryLine, targets: RemovedQuestion[]) => {
        if (readOnly) return null;
        const checks = targets.map((t) =>
            restorable(t, current, compiled, lines),
        );
        const unavailable = checks.find((c) => c.status === "unavailable");
        if (!checks.some((c) => c.status === "ok")) {
            const reason =
                unavailable?.status === "unavailable" ? unavailable.reason : "";
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
                onClick={() => onRestore(line, targets)}
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
                                                    restoreControl(line, [
                                                        item.removed,
                                                    ])}
                                            </li>
                                        ))}
                                    </ul>
                                </details>
                            )}
                        </div>
                        {line.removed && restoreControl(line, line.removed)}
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

    const [history, setHistory] = useState<QuestionHistoryResponse | null>(
        null,
    );
    const [state, setState] = useState<LoadState>("loading");
    const [olderState, setOlderState] = useState<"idle" | "loading" | "error">(
        "idle",
    );
    // The last refresh failed: what's shown may be behind.
    const [refreshFailed, setRefreshFailed] = useState(false);
    // The loaded history, for the cursor of a refresh.
    const historyRef = useRef(history);
    historyRef.current = history;
    // Bumped whenever the loaded history is replaced (another session, or
    // the newest page loaded afresh): responses asked for before are dropped.
    const generation = useRef(0);
    const unavailable = useRef(false);
    const autoOlder = useRef(0);
    const firstLoad = useRef(false);

    const fail = useCallback((error: unknown) => {
        // A 404 is an API without this route (web and API are deployed
        // separately), or a session that's gone: asking again won't help.
        if (error instanceof QuestionHistoryError && error.status === 404) {
            unavailable.current = true;
            setState("unavailable");
            return;
        }
        // A failed refresh keeps what's shown.
        setState((current) => (current === "ready" ? current : "error"));
    }, []);

    const loadNewestPage = useCallback(async () => {
        // Drops whatever an earlier session still has in flight.
        const gen = ++generation.current;
        if (!sessionId) setState("unavailable");
        if (!sessionId || unavailable.current) return;
        autoOlder.current = 0;
        setOlderState("idle");
        firstLoad.current = !historyRef.current;
        try {
            const page = await fetchQuestionHistory(sessionId);
            if (gen !== generation.current) return;
            setHistory(page);
            setState("ready");
            setRefreshFailed(false);
        } catch (error) {
            if (gen === generation.current) fail(error);
        } finally {
            if (gen === generation.current) firstLoad.current = false;
        }
    }, [sessionId, fail]);

    // The saves since the newest one loaded, on top.
    const loadNewer = useCallback(async () => {
        const loaded = historyRef.current;
        if (!sessionId || unavailable.current) return;
        // Still on its first page, which will include this change; after a
        // failed first load, try again.
        if (!loaded) {
            if (firstLoad.current) return;
            return loadNewestPage();
        }
        const gen = generation.current;
        try {
            const page = await fetchQuestionHistory(sessionId, {
                after: loaded.newest ?? 0,
            });
            if (gen !== generation.current) return;
            // Too many to tell: start again from the newest page.
            if (page.more) return loadNewestPage();
            setHistory((current) =>
                current ? prependNewer(current, page) : current,
            );
            setRefreshFailed(false);
        } catch (error) {
            if (gen !== generation.current) return;
            fail(error);
            setRefreshFailed(true);
        }
    }, [sessionId, fail, loadNewestPage]);

    const loadOlder = useCallback(async () => {
        const before = historyRef.current?.nextBefore;
        if (!sessionId || !before) return;
        const gen = generation.current;
        setOlderState("loading");
        try {
            const page = await fetchQuestionHistory(sessionId, { before });
            if (gen !== generation.current) return;
            // Only below the page it was asked for.
            setHistory((loaded) =>
                loaded?.nextBefore === before
                    ? appendOlderPage(loaded, page)
                    : loaded,
            );
            setOlderState("idle");
        } catch {
            if (gen === generation.current) setOlderState("error");
        }
    }, [sessionId]);

    useEffect(() => {
        unavailable.current = false;
        historyRef.current = null;
        setHistory(null);
        setState("loading");
        void loadNewestPage();
    }, [loadNewestPage]);

    // Keep it current while it's shown: once a change reaches the board, and
    // once this device's own question save has synced.
    useEffect(() => {
        if (!sessionId) return;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let waits = 0;
        const refresh = () => {
            if (hasPendingQuestionSave(sessionId) && waits < MAX_SAVE_WAITS) {
                waits++;
                timer = setTimeout(refresh, REFRESH_DELAY_MS);
                return;
            }
            void loadNewer();
        };
        const stop = questions.listen(() => {
            clearTimeout(timer);
            waits = 0;
            timer = setTimeout(refresh, REFRESH_DELAY_MS);
        });
        return () => {
            clearTimeout(timer);
            stop();
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

    const lines = useMemo(
        () => historyLines(history?.entries ?? [], { selfId, unit }),
        [history, selfId, unit],
    );

    useEffect(() => {
        if (state !== "ready" || olderState !== "idle") return;
        if (lines.length > 0 || !history?.nextBefore) return;
        if (autoOlder.current >= MAX_AUTO_OLDER) return;
        autoOlder.current++;
        void loadOlder();
    }, [state, olderState, lines.length, history, loadOlder]);

    if (state === "loading") return <Note>Loading…</Note>;
    if (state === "unavailable") {
        return <Note>History isn&apos;t available for this session.</Note>;
    }
    if (state === "error") {
        return (
            <div className="flex flex-col items-start gap-2 px-4 py-2 text-sm">
                <p className="text-muted-foreground">
                    Couldn&apos;t load the history.
                </p>
                <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                        setState("loading");
                        void loadNewestPage();
                    }}
                >
                    Try again
                </Button>
            </div>
        );
    }

    const hasOlder = !!history?.nextBefore;
    // Changes not saved yet aren't in the History until they are.
    const unsaved =
        !!sessionId && !$readOnly && hasPendingQuestionSave(sessionId);
    return (
        <div className="flex flex-col pb-2">
            {unsaved && (
                <p className="px-4 py-2 text-xs text-muted-foreground">
                    Your latest changes will show here once they&apos;re saved.
                </p>
            )}
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
                onRestore={(line, targets) => {
                    const { back, alreadyBack } = restoreFromHistory(
                        line,
                        targets,
                        lines,
                    );
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
