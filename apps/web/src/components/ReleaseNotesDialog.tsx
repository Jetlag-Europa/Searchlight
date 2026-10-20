import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { type Inline, parseNotes } from "@/lib/markdownNotes";
import { loadReleaseNotes, releaseName } from "@/lib/releaseNotes";

function InlineText({ content }: { content: Inline[] }) {
    return content.map((part, i) => {
        switch (part.type) {
            case "strong":
                return <strong key={i}>{part.text}</strong>;
            case "code":
                return (
                    <code key={i} className="rounded bg-muted px-1 text-xs">
                        {part.text}
                    </code>
                );
            case "link":
                return (
                    <a
                        key={i}
                        href={part.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="underline underline-offset-2"
                    >
                        {part.text}
                    </a>
                );
            default:
                return part.text;
        }
    });
}

export default function ReleaseNotesDialog({
    notes,
    open,
    onClose,
}: {
    notes: string;
    open: boolean;
    onClose: () => void;
}) {
    const [markdown, setMarkdown] = useState<string | null>(null);
    useEffect(() => {
        loadReleaseNotes(notes).then(setMarkdown, (e) =>
            console.warn("[searchlight] release notes failed to load", e),
        );
    }, [notes]);
    const blocks = useMemo(() => parseNotes(markdown ?? ""), [markdown]);

    return (
        <Dialog
            open={open && markdown !== null}
            onOpenChange={(next) => !next && onClose()}
        >
            {/* Above the map's status chips, which cover the title on phones. */}
            <DialogContent
                className="z-[1042] flex max-h-[85svh] max-w-md flex-col"
                aria-describedby={undefined}
            >
                <DialogHeader>
                    <DialogTitle>
                        What&apos;s new in Searchlight {releaseName(notes)}
                    </DialogTitle>
                </DialogHeader>
                <div className="-mx-6 min-h-0 space-y-3 overflow-y-auto px-6 text-sm">
                    {blocks.map((block, i) => {
                        if (block.type === "heading") {
                            return (
                                <h3 key={i} className="pt-1 font-semibold">
                                    <InlineText content={block.content} />
                                </h3>
                            );
                        }
                        if (block.type === "list") {
                            return (
                                <ul
                                    key={i}
                                    className="list-disc space-y-1 pl-5 text-muted-foreground"
                                >
                                    {block.items.map((item, j) => (
                                        <li key={j}>
                                            <InlineText content={item} />
                                        </li>
                                    ))}
                                </ul>
                            );
                        }
                        return (
                            <p key={i} className="text-muted-foreground">
                                <InlineText content={block.content} />
                            </p>
                        );
                    })}
                </div>
                {/* The whole notes are above: the repository's release pages
                    are private, so most players couldn't open them. */}
                <DialogFooter>
                    <Button onClick={onClose}>Got it</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
