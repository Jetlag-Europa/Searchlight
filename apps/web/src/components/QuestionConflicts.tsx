import { useStore } from "@nanostores/react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { TriangleAlert, X } from "lucide-react";
import {
    type ComponentPropsWithoutRef,
    type RefObject,
    useEffect,
    useRef,
    useState,
} from "react";
import { createPortal } from "react-dom";
import { Drawer as DrawerPrimitive } from "vaul";

import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import {
    Drawer,
    DrawerDescription,
    DrawerHeader,
    DrawerTitle,
} from "@/components/ui/drawer";
import { compiledGameAtom } from "@/game-definition/store";
import { useIsMobile } from "@/hooks/use-mobile";
import { activeSessionId } from "@/lib/activeSession";
import { showCalculating } from "@/lib/calculating";
import {
    defaultUnit,
    gameDefinitionReady,
    questions,
    sessionPickerOpen,
    sidebarContextL,
    sidebarContextR,
} from "@/lib/context";
import {
    isConflictVersionSupported,
    lookUpConflictAuthors,
    type QuestionConflict,
    questionConflictArrivals,
    questionConflicts,
    questionDecisionsPossible,
    resolveAllQuestionConflicts,
    resolveQuestionConflict,
} from "@/lib/questionConflicts";
import {
    capitalized,
    conflictAuthorName,
    conflictCountText,
    conflictDeletionLine,
    conflictQuestionLabel,
    questionDifferences,
    questionSummaryParts,
    questionTypeLabel,
    rawDifferences,
    summarizeQuestion,
    type SummaryOptions,
} from "@/lib/questionSummary";
import { cn } from "@/lib/utils";

import { StatusChip } from "./StatusChip";

// The element in full screen, if any: the map's container, when the player
// put the map in full screen. Only it shows then.
function useFullscreenElement(): Element | null {
    const [element, setElement] = useState(() => document.fullscreenElement);
    useEffect(() => {
        const sync = () => setElement(document.fullscreenElement);
        document.addEventListener("fullscreenchange", sync);
        return () => document.removeEventListener("fullscreenchange", sync);
    }, []);
    return element;
}

/**
 * Asks the player to decide between their version of a question and
 * another player's, when edits they made offline (or on a stale board) met
 * someone else's. Nothing waits on it: the server's version is saved and
 * shown meanwhile, so closing it just leaves a chip in the map's corner to
 * come back to. It opens by itself when new conflicts arrive while the page
 * is in view, or as soon as it comes back into view.
 */
export function QuestionConflicts() {
    const sessionId = useStore(activeSessionId);
    // The store leaves out conflicts neither version of which the game has.
    const shown = useStore(questionConflicts);
    const arrivals = useStore(questionConflictArrivals);
    const pickerOpen = useStore(sessionPickerOpen);
    const calculating = useStore(showCalculating);
    const left = useStore(sidebarContextL);
    const right = useStore(sidebarContextR);
    const isMobile = useIsMobile();
    const fullscreen = useFullscreenElement();
    const [open, setOpen] = useState(false);
    const chipRef = useRef<HTMLButtonElement>(null);

    // Another session's conflicts didn't just arrive: they wait for the chip.
    // Declared before the arrivals below, which it mustn't undo: conflicts
    // recorded for a session before it was opened arrive as it opens.
    const lastSessionId = useRef(sessionId);
    useEffect(() => {
        if (sessionId === lastSessionId.current) return;
        lastSessionId.current = sessionId;
        setOpen(false);
        openWhenVisible.current = false;
    }, [sessionId]);

    // Arrivals start at 0 and count new conflicts recorded in this page, so
    // any count above the last one seen is news, even one from before this
    // mounted. A hidden page opens it when it's next looked at. Arrivals the
    // window has nothing to show for (their game doesn't have either
    // version) don't open it, now or later.
    const seenArrivals = useRef(0);
    const openWhenVisible = useRef(false);
    useEffect(() => {
        if (arrivals === seenArrivals.current) return;
        seenArrivals.current = arrivals;
        if (shown.length === 0) return;
        if (document.visibilityState === "visible") setOpen(true);
        else openWhenVisible.current = true;
    }, [arrivals]);
    useEffect(() => {
        const onVisibility = () => {
            if (
                document.visibilityState === "visible" &&
                openWhenVisible.current
            ) {
                openWhenVisible.current = false;
                setOpen(true);
            }
        };
        document.addEventListener("visibilitychange", onVisibility);
        return () =>
            document.removeEventListener("visibilitychange", onVisibility);
    }, []);

    // Once every one is decided (here, or by an edit that settled it), it
    // closes, and only new arrivals open it again.
    useEffect(() => {
        if (shown.length > 0) return;
        setOpen(false);
        openWhenVisible.current = false;
    }, [shown.length]);

    const visible = open && !pickerOpen && shown.length > 0;

    // Who made the other versions, looked up while they're on screen. Only
    // when the set still missing a name changes, so a lookup that can't
    // answer (offline) isn't retried on every render.
    const missing = shown
        .filter((c) => c.author === undefined)
        .map((c) => `${c.key}@${c.theirsSequence}`)
        .join(",");
    useEffect(() => {
        if (!visible || !sessionId || !missing) return;
        void lookUpConflictAuthors(sessionId).catch(() => {});
    }, [visible, sessionId, missing]);

    // On a phone an open sidebar covers the map, and the chip would cover
    // the sidebar's controls; the "Calculating…" pill sits where the chip
    // does, and steps aside for nothing (the zones-left pill hides for it
    // too). The chip stays mounted while hidden, so focus can go back to it
    // when the window closes.
    const sidebarCoversMap =
        (left.isMobile && left.openMobile) ||
        (right.isMobile && right.openMobile);
    const chipHidden =
        visible || sidebarCoversMap || (isMobile && calculating && !fullscreen);

    const chip = (
        // As small as the chips above it, but a thumb's height to tap: the
        // hit area reaches into the gap above and below it, where the
        // zones-left pill lets taps through.
        <button
            ref={chipRef}
            type="button"
            inert={pickerOpen}
            hidden={chipHidden}
            onClick={() => setOpen(true)}
            className="relative flex w-max items-center gap-1.5 rounded-full border border-amber-400/70 bg-background/90 px-3 py-1.5 text-xs font-medium shadow-sm backdrop-blur-sm hover:bg-accent after:absolute after:inset-x-0 after:-top-1 after:-bottom-3 after:content-[''] [&[hidden]]:hidden"
        >
            <TriangleAlert
                aria-hidden="true"
                className="size-3.5 text-amber-400"
            />
            {conflictCountText(shown.length)}
        </button>
    );

    return (
        <>
            {shown.length > 0 &&
                (fullscreen ? (
                    // In full screen the corner's chips are hidden with the
                    // rest of the page, so it goes in the map, where they'd
                    // be.
                    createPortal(
                        <div className="fixed top-2 right-14 z-[1041]">
                            {chip}
                        </div>,
                        fullscreen,
                    )
                ) : (
                    <StatusChip slot="conflicts">{chip}</StatusChip>
                ))}
            <ConflictWindow
                open={visible}
                onClose={() => setOpen(false)}
                chipRef={chipRef}
                sessionId={sessionId}
                conflicts={shown}
            />
        </>
    );
}

const TITLE = "Choose which version to keep";
// Short, so a small phone has room for the questions themselves.
const DESCRIPTION =
    "Someone else changed these too. Theirs stays until you choose.";

// Above the map's corner chips (z 1041) and the sync pill (1042), which
// would otherwise cover the drawer's handle, its title or the dialog's
// close button. Toasts, the session picker and the loading overlay stay
// above it.
const LAYER = "z-[1043]";

// DrawerContent's look, portalled to the body rather than into the map. A
// phone's question or zone sidebar is a modal sheet in the body, which hides
// everything else from screen readers, the map included; this window can
// open over it (when conflicts arrive), and inside the map it would be
// hidden with the rest. Opened later, in the body, it isn't, and it hides
// the sheet in turn while it's open. In full screen only the map shows (and
// no sidebar), so it goes in the map then.
function BodyDrawerContent({
    className,
    children,
    ...props
}: ComponentPropsWithoutRef<typeof DrawerPrimitive.Content>) {
    const fullscreen = useFullscreenElement();
    return (
        <DrawerPrimitive.Portal container={fullscreen ?? document.body}>
            <DrawerPrimitive.Overlay
                className={cn("fixed inset-0 bg-black/80", LAYER)}
            />
            <DrawerPrimitive.Content
                className={cn(
                    "fixed inset-x-0 bottom-0 mt-24 flex h-auto flex-col rounded-t-[10px] border bg-background",
                    LAYER,
                    className,
                )}
                {...props}
            >
                <div className="mx-auto mt-4 h-2 w-[100px] rounded-full bg-muted" />
                {children}
            </DrawerPrimitive.Content>
        </DrawerPrimitive.Portal>
    );
}

// DialogContent's look and place (in the map), one layer up: see LAYER.
function MapDialogContent({
    className,
    children,
    ...props
}: ComponentPropsWithoutRef<typeof DialogPrimitive.Content>) {
    return (
        <DialogPrimitive.Portal
            container={document.querySelector(
                "#map-modal-dialog-container-leaflet",
            )}
        >
            <DialogPrimitive.Overlay
                className={cn(
                    "fixed inset-0 bg-black/80 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
                    LAYER,
                )}
            />
            <DialogPrimitive.Content
                className={cn(
                    "fixed left-[50%] top-[50%] grid w-full max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 border bg-background p-6 shadow-lg duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%] sm:rounded-lg",
                    LAYER,
                    className,
                )}
                {...props}
            >
                {children}
                <DialogPrimitive.Close className="absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none">
                    <X className="h-4 w-4" />
                    <span className="sr-only">Close</span>
                </DialogPrimitive.Close>
            </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
    );
}

// Whether a modal other than this window is still open behind it: the
// question sidebar's sheet on a phone, or a dialog such as Add Question.
function otherModalOpen(): boolean {
    return [
        ...document.querySelectorAll(
            '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]',
        ),
    ].some((el) => !el.hasAttribute("data-question-conflicts"));
}

// A bottom drawer on a phone, with room for thumbs; a dialog on a desktop.
function ConflictWindow({
    open,
    onClose,
    chipRef,
    sessionId,
    conflicts,
}: {
    open: boolean;
    onClose: () => void;
    chipRef: RefObject<HTMLButtonElement | null>;
    sessionId: string;
    conflicts: QuestionConflict[];
}) {
    const isMobile = useIsMobile();
    const onOpenChange = (next: boolean) => {
        if (!next) onClose();
    };

    // Focus would land on the first "Keep mine", where a stray Enter decides
    // a question unasked. It goes to the title instead, so it leaves what was
    // focused behind (a card's name field) and screen readers start there.
    const titleRef = useRef<HTMLHeadingElement>(null);
    const returnFocus = useRef<Element | null>(null);
    const focusTitle = (event: Event) => {
        event.preventDefault();
        returnFocus.current = document.activeElement;
        titleRef.current?.focus();
    };
    // On closing, focus goes back where it was (a field in the sidebar
    // behind, say), or else to the chip, which stands for the window.
    const restoreFocus = (event: Event) => {
        event.preventDefault();
        const before = returnFocus.current;
        returnFocus.current = null;
        if (
            before instanceof HTMLElement &&
            before !== document.body &&
            before.isConnected
        ) {
            before.focus();
            if (document.activeElement === before) return;
        }
        chipRef.current?.focus();
    };

    // The drawer turns the page's taps back on as it closes, though a modal
    // it opened over (the sidebar's sheet, a dialog) still has them off.
    // Turn them off again, after the drawer's own reset, until that one
    // closes and puts them back.
    const wasOpen = useRef(open);
    useEffect(() => {
        if (open || !wasOpen.current) {
            wasOpen.current = open;
            return;
        }
        wasOpen.current = false;
        const keepOff = () => {
            if (otherModalOpen()) document.body.style.pointerEvents = "none";
        };
        const frame = requestAnimationFrame(keepOff);
        // And once it's gone, in case its unmount resets them too.
        const timer = window.setTimeout(keepOff, 600);
        return () => {
            cancelAnimationFrame(frame);
            window.clearTimeout(timer);
        };
    }, [open]);

    if (isMobile) {
        return (
            <Drawer open={open} onOpenChange={onOpenChange}>
                <BodyDrawerContent
                    data-question-conflicts=""
                    className="max-h-[92svh]"
                    onOpenAutoFocus={focusTitle}
                    onCloseAutoFocus={restoreFocus}
                >
                    <DrawerHeader className="pb-2 text-left">
                        <DrawerTitle
                            ref={titleRef}
                            tabIndex={-1}
                            className="text-xl focus:outline-none"
                        >
                            {TITLE}
                        </DrawerTitle>
                        <DrawerDescription className="text-base">
                            {DESCRIPTION}
                        </DrawerDescription>
                    </DrawerHeader>
                    <ConflictList
                        sessionId={sessionId}
                        conflicts={conflicts}
                        onLater={onClose}
                        large
                    />
                </BodyDrawerContent>
            </Drawer>
        );
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <MapDialogContent
                data-question-conflicts=""
                className="flex max-h-[85vh] max-w-2xl flex-col gap-0 p-0"
                onOpenAutoFocus={focusTitle}
                onCloseAutoFocus={restoreFocus}
            >
                <DialogHeader className="p-6 pb-3">
                    <DialogTitle
                        ref={titleRef}
                        tabIndex={-1}
                        className="focus:outline-none"
                    >
                        {TITLE}
                    </DialogTitle>
                    <DialogDescription>{DESCRIPTION}</DialogDescription>
                </DialogHeader>
                <ConflictList
                    sessionId={sessionId}
                    conflicts={conflicts}
                    onLater={onClose}
                />
            </MapDialogContent>
        </Dialog>
    );
}

function ConflictList({
    sessionId,
    conflicts,
    onLater,
    large = false,
}: {
    sessionId: string;
    conflicts: QuestionConflict[];
    onLater: () => void;
    large?: boolean;
}) {
    const board = useStore(questions);
    const compiled = useStore(compiledGameAtom);
    // Which versions can be kept follows the game the board shows.
    useStore(gameDefinitionReady);
    const unit = useStore(defaultUnit);
    // While the session loads, or its edits can't be saved yet, a choice
    // would go nowhere: the store ignores it, so the buttons wait.
    const possible = useStore(questionDecisionsPossible);
    const options: SummaryOptions = {
        kindLabel: (kind) => compiled?.questionMap.get(kind)?.label,
        unit,
    };
    const size = large ? "lg" : "default";
    // "Keep all" leaves out the versions that can't be kept (the store
    // skips them); those stay listed.
    const canKeepAll = (choice: "mine" | "theirs") =>
        possible &&
        conflicts.some((c) => isConflictVersionSupported(c, choice));

    return (
        <>
            <ul
                className={cn(
                    "min-h-0 flex-1 space-y-3 overflow-y-auto px-4",
                    !large && "px-6",
                )}
            >
                {conflicts.map((conflict) => (
                    <ConflictItem
                        key={conflict.key}
                        conflict={conflict}
                        possible={possible}
                        board={board}
                        options={options}
                        large={large}
                        onChoose={(choice) =>
                            resolveQuestionConflict(
                                sessionId,
                                conflict.key,
                                choice,
                            )
                        }
                    />
                ))}
            </ul>
            {/* On a phone the two "Keep all" share a row, so a small screen
                keeps its height for the list. */}
            <div
                className={cn(
                    "shrink-0 gap-2 border-t",
                    large
                        ? "grid grid-cols-2 p-3"
                        : "flex flex-row flex-wrap justify-end px-6 py-4",
                )}
            >
                {!possible && (
                    <p
                        role="status"
                        className={cn(
                            "text-sm text-amber-400",
                            large ? "col-span-2" : "basis-full text-right",
                        )}
                    >
                        Can&apos;t save a choice yet: the session is loading, or
                        offline. It can wait.
                    </p>
                )}
                {conflicts.length > 1 && (
                    <>
                        <Button
                            size={size}
                            variant="secondary"
                            className={cn(large && "px-2")}
                            disabled={!canKeepAll("mine")}
                            onClick={() =>
                                resolveAllQuestionConflicts(sessionId, "mine")
                            }
                        >
                            Keep all mine
                        </Button>
                        <Button
                            size={size}
                            variant="secondary"
                            className={cn(large && "px-2")}
                            disabled={!canKeepAll("theirs")}
                            onClick={() =>
                                resolveAllQuestionConflicts(sessionId, "theirs")
                            }
                        >
                            Keep all theirs
                        </Button>
                    </>
                )}
                <Button
                    size={size}
                    variant="ghost"
                    className={cn(large && "col-span-2")}
                    onClick={onLater}
                >
                    Decide later
                </Button>
            </div>
        </>
    );
}

function ConflictItem({
    conflict,
    possible,
    board,
    options,
    large,
    onChoose,
}: {
    conflict: QuestionConflict;
    possible: boolean;
    board: readonly unknown[];
    options: SummaryOptions;
    large: boolean;
    onChoose: (choice: "mine" | "theirs") => void;
}) {
    const { name, label } = conflictQuestionLabel(board, conflict);
    const them = conflictAuthorName(conflict.author);
    const deletion = conflictDeletionLine(conflict.kind, conflict.author);
    const differences =
        conflict.mine && conflict.theirs
            ? questionDifferences(conflict.mine, conflict.theirs, options)
            : [];
    // Two versions that read the same ("2 km" from 2 km and from 2000 m)
    // show the values that differ under each.
    const raw =
        conflict.mine &&
        conflict.theirs &&
        summarizeQuestion(conflict.mine, options) ===
            summarizeQuestion(conflict.theirs, options)
            ? rawDifferences(conflict.mine, conflict.theirs, options)
            : { a: [], b: [] };

    return (
        <li className="rounded-lg border bg-card p-3">
            <div className="mb-2 min-w-0">
                {name ? (
                    <>
                        <p
                            className="truncate text-base font-semibold"
                            title={name}
                        >
                            {name}
                        </p>
                        <p className="truncate text-sm text-muted-foreground">
                            {label}
                        </p>
                    </>
                ) : (
                    <p className="text-base font-semibold">{label}</p>
                )}
                {deletion && (
                    <p className="text-sm text-muted-foreground">{deletion}</p>
                )}
                {conflict.changedAgain && (
                    <p className="text-sm text-amber-400">
                        {capitalized(them)} changed it again since.
                    </p>
                )}
            </div>
            <div className="grid grid-cols-2 gap-2">
                <VersionColumn
                    heading="Yours"
                    question={conflict.mine}
                    details={raw.a}
                    supported={isConflictVersionSupported(conflict, "mine")}
                    possible={possible}
                    options={options}
                    action="Keep mine"
                    large={large}
                    onChoose={() => onChoose("mine")}
                />
                <VersionColumn
                    heading={capitalized(them)}
                    question={conflict.theirs}
                    details={raw.b}
                    supported={isConflictVersionSupported(conflict, "theirs")}
                    possible={possible}
                    options={options}
                    action="Keep theirs"
                    large={large}
                    onChoose={() => onChoose("theirs")}
                />
            </div>
            {differences.length > 0 && (
                <p className="mt-2 text-sm text-muted-foreground">
                    Differs in: {differences.join(", ")}
                </p>
            )}
        </li>
    );
}

function VersionColumn({
    heading,
    question,
    details,
    supported,
    possible,
    options,
    action,
    large,
    onChoose,
}: {
    heading: string;
    question: unknown;
    details: string[];
    // A version from another revision of the game can't be kept: the board
    // leaves out what the game doesn't have, so keeping it would delete it.
    supported: boolean;
    possible: boolean;
    options: SummaryOptions;
    action: string;
    large: boolean;
    onChoose: () => void;
}) {
    const summary = question ? questionSummaryParts(question, options) : null;
    const answer =
        summary?.answer ?? summary?.subject ?? questionTypeLabel(question);
    const subject = summary?.answer ? summary.subject : undefined;

    return (
        <div className="flex min-w-0 flex-col gap-2 rounded-md bg-muted/40 p-2">
            <p
                className="truncate text-xs font-medium uppercase tracking-wide text-muted-foreground"
                title={heading}
            >
                {heading}
            </p>
            <div className="min-w-0 flex-1">
                {!question ? (
                    <p className="text-lg font-semibold italic text-muted-foreground">
                        Deleted
                    </p>
                ) : (
                    <>
                        {subject && (
                            <p className="break-words text-sm text-muted-foreground">
                                {subject}
                            </p>
                        )}
                        <p className="break-words text-lg font-semibold leading-snug">
                            {answer}
                        </p>
                        {summary && summary.notes.length > 0 && (
                            <p className="text-sm text-muted-foreground">
                                {summary.notes.join(", ")}
                            </p>
                        )}
                        {details.length > 0 && (
                            <p className="break-words text-sm text-muted-foreground">
                                {details.join(", ")}
                            </p>
                        )}
                    </>
                )}
            </div>
            {supported ? (
                <Button
                    size={large ? "lg" : "default"}
                    variant="outline"
                    className={cn("w-full", large && "px-2")}
                    disabled={!possible}
                    onClick={onChoose}
                >
                    {action}
                </Button>
            ) : (
                <p className="text-sm text-amber-400">
                    Not in this game&apos;s current version, so it can&apos;t be
                    kept.
                </p>
            )}
        </div>
    );
}
