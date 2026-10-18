import { useStore } from "@nanostores/react";
import { EyeIcon, EyeOffIcon, LockIcon, UnlockIcon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { VscChevronDown, VscShare, VscTrash } from "react-icons/vsc";

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
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
} from "@/components/ui/dialog";
import { RawInput } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
    SidebarGroup,
    SidebarGroupContent,
    SidebarGroupLabel,
    SidebarMenu,
    SidebarMenuItem,
} from "@/components/ui/sidebar-l";
import { isLoading, questions } from "@/lib/context";
import { deleteQuestionsWithUndo } from "@/lib/deleteQuestionsWithUndo";
import {
    normalizeQuestionName,
    QUESTION_NAME_MAX_LENGTH,
} from "@/lib/questionNames";
import { cn } from "@/lib/utils";

export const QuestionCard = ({
    children,
    questionKey,
    className,
    label,
    sub,
    name,
    setName,
    collapsed,
    locked,
    setLocked,
    enabled,
    setEnabled,
    setCollapsed,
}: {
    children: React.ReactNode;
    questionKey: number;
    className?: string;
    label?: string;
    sub?: string;
    name?: string;
    setName?: (name: string | undefined) => void;
    collapsed?: boolean;
    locked?: boolean;
    setLocked?: (locked: boolean) => void;
    enabled?: boolean;
    setEnabled?: (enabled: boolean) => void;
    setCollapsed?: (collapsed: boolean) => void;
}) => {
    const [isCollapsed, setIsCollapsed] = useState(collapsed ?? false);
    const $questions = useStore(questions);
    const $isLoading = useStore(isLoading);
    const copyButtonRef = useRef<HTMLButtonElement>(null);

    const deleteTarget = name ? `"${name}"` : "the question";

    const toggleCollapse = () => {
        if (setCollapsed) {
            setCollapsed(!isCollapsed);
        }
        setIsCollapsed((prevState) => !prevState);
    };

    return (
        <>
            <SidebarGroup className={cn(className, enabled === false && "opacity-50")}>
                <div className="relative">
                    <button
                        onClick={toggleCollapse}
                        className={cn(
                            "absolute top-2 left-2 text-white border rounded-md transition-all duration-500",
                            isCollapsed && "-rotate-90",
                        )}
                    >
                        <VscChevronDown />
                    </button>
                    <SidebarGroupLabel
                        className={cn(
                            "ml-8 mr-8 cursor-pointer",
                            name &&
                                "h-auto min-h-8 flex-col items-start justify-center",
                        )}
                        onClick={toggleCollapse}
                        title={name}
                    >
                        {name ? (
                            <>
                                <span className="max-w-full truncate text-sm font-semibold text-sidebar-foreground">
                                    {name}
                                </span>
                                <span className="max-w-full truncate">
                                    {label} {sub && `(${sub})`}
                                </span>
                            </>
                        ) : (
                            <>
                                {label} {sub && `(${sub})`}
                            </>
                        )}
                    </SidebarGroupLabel>
                    <SidebarGroupContent
                        className={cn(
                            "overflow-hidden transition-all duration-1000 max-h-[100rem]", // 100rem is arbitrary
                            isCollapsed && "max-h-0",
                        )}
                    >
                        <SidebarMenu>
                            {setName && (
                                <QuestionNameInput
                                    name={name}
                                    onCommit={setName}
                                />
                            )}
                            {children}
                        </SidebarMenu>
                        <div className="flex gap-2 pt-2 px-2 justify-center">
                            <Dialog>
                                <DialogTrigger asChild>
                                    <Button variant="outline" size="sm">
                                        <VscShare />
                                    </Button>
                                </DialogTrigger>
                                <DialogContent aria-describedby={undefined}>
                                    <DialogHeader>
                                        <DialogTitle className="text-2xl">
                                            Share this Question!
                                        </DialogTitle>
                                        <DialogDescription>
                                            Below you can access the JSON
                                            representing the question. Send this
                                            to another player for them to copy.
                                            They can then click &ldquo;Paste
                                            Question&rdquo; at the bottom of the
                                            &ldquo;Questions&rdquo; sidebar.
                                        </DialogDescription>
                                    </DialogHeader>
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        className="mb-2 sm:mb-0 transition-colors"
                                        ref={copyButtonRef}
                                        onClick={() => {
                                            navigator.clipboard
                                                .writeText(
                                                    JSON.stringify(
                                                        $questions.find(
                                                            (q) =>
                                                                q.key ===
                                                                questionKey,
                                                        ),
                                                        null,
                                                        4,
                                                    ),
                                                )
                                                .then(() => {
                                                    if (copyButtonRef.current) {
                                                        copyButtonRef.current.textContent =
                                                            "Copied!";
                                                        copyButtonRef.current.classList.add(
                                                            "bg-green-500",
                                                        );
                                                        setTimeout(() => {
                                                            if (
                                                                copyButtonRef.current
                                                            ) {
                                                                copyButtonRef.current.textContent =
                                                                    "Copy to Clipboard";
                                                                copyButtonRef.current.classList.remove(
                                                                    "bg-green-500",
                                                                );
                                                            }
                                                        }, 2000);
                                                    }
                                                })
                                                .catch(() => {
                                                    if (copyButtonRef.current) {
                                                        copyButtonRef.current.textContent =
                                                            "Failed to Copy";
                                                        copyButtonRef.current.classList.add(
                                                            "bg-red-500",
                                                        );
                                                        setTimeout(() => {
                                                            if (
                                                                copyButtonRef.current
                                                            ) {
                                                                copyButtonRef.current.textContent =
                                                                    "Copy to Clipboard";
                                                                copyButtonRef.current.classList.remove(
                                                                    "bg-red-500",
                                                                );
                                                            }
                                                        }, 2000);
                                                    }
                                                });
                                        }}
                                    >
                                        Copy to Clipboard
                                    </Button>
                                    <QuestionJson questionKey={questionKey} />
                                </DialogContent>
                            </Dialog>
                            <AlertDialog>
                                <AlertDialogTrigger asChild>
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        disabled={$isLoading}
                                    >
                                        <VscTrash />
                                    </Button>
                                </AlertDialogTrigger>
                                <AlertDialogContent aria-describedby={undefined}>
                                    <AlertDialogHeader>
                                        <AlertDialogTitle>
                                            Are you absolutely sure?
                                        </AlertDialogTitle>
                                        <AlertDialogDescription>
                                            This will delete {deleteTarget} for
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
                                                deleteQuestionsWithUndo([
                                                    questionKey,
                                                ])
                                            }
                                        >
                                            Delete Question
                                        </AlertDialogAction>
                                    </AlertDialogFooter>
                                </AlertDialogContent>
                            </AlertDialog>
                            {locked !== undefined && (
                                <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => setLocked!(!locked)}
                                    disabled={$isLoading}
                                >
                                    {locked ? <LockIcon /> : <UnlockIcon />}
                                </Button>
                            )}
                            {enabled !== undefined && (
                                <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => setEnabled!(!enabled)}
                                    disabled={$isLoading}
                                >
                                    {enabled ? <EyeIcon /> : <EyeOffIcon />}
                                </Button>
                            )}
                        </div>
                    </SidebarGroupContent>
                </div>
            </SidebarGroup>
            <Separator className="h-1" />
        </>
    );
};

// Rendered only while the share dialog is open. As an inline prop it serialized
// the question (including any custom geometry) on every render of every card.
const QuestionJson = ({ questionKey }: { questionKey: number }) => {
    const $questions = useStore(questions);
    return (
        <textarea
            className="w-full h-[300px] bg-slate-900 text-white rounded-md p-2"
            readOnly
            value={JSON.stringify(
                $questions.find((q) => q.key === questionKey),
                null,
                4,
            )}
        ></textarea>
    );
};

// Saves on blur, Enter or unmount (a marker's dialog can close mid-edit), not
// per keystroke: every saved change re-renders the map and syncs the session.
// Never disabled: the name changes no answer, and the field would lose focus
// whenever the map recalculates.
const QuestionNameInput = ({
    name,
    onCommit,
}: {
    name?: string;
    onCommit: (name: string | undefined) => void;
}) => {
    const id = useId();
    const [draft, setDraft] = useState(name ?? "");
    const draftRef = useRef(draft);
    // The draft when the field was focused; null when it isn't being edited.
    const startRef = useRef<string | null>(null);
    const latest = useRef({ name, onCommit });
    latest.current = { name, onCommit };

    const update = (value: string) => {
        draftRef.current = value;
        setDraft(value);
    };

    // A rename elsewhere (the other card, another player) shows up unless
    // this one is mid-edit.
    useEffect(() => {
        if (startRef.current === null) update(name ?? "");
    }, [name]);

    // Only an actual edit is saved, so focusing and leaving the field can't
    // overwrite a rename made meanwhile.
    const commit = (): string | undefined => {
        const start = startRef.current;
        startRef.current = null;
        if (start === null || draftRef.current === start)
            return latest.current.name;
        const next = normalizeQuestionName(draftRef.current);
        if (next !== latest.current.name) latest.current.onCommit(next);
        return next;
    };

    useEffect(
        () => () => {
            commit();
        },
        [],
    );

    return (
        <SidebarMenuItem className="flex gap-2 items-center px-2 pt-1">
            <Label htmlFor={id} className="min-w-12">
                Name
            </Label>
            <RawInput
                id={id}
                className="h-8 placeholder:text-muted-foreground/60"
                value={draft}
                placeholder="Add a name"
                maxLength={QUESTION_NAME_MAX_LENGTH}
                autoComplete="off"
                onFocus={() => {
                    startRef.current = draftRef.current;
                }}
                onChange={(e) => update(e.target.value)}
                onBlur={() => update(commit() ?? "")}
                onKeyDown={(e) => {
                    if (e.key === "Enter") e.currentTarget.blur();
                }}
            />
        </SidebarMenuItem>
    );
};
