import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogTitle,
} from "@/components/ui/dialog";

export interface PastePrompt {
    title: string;
    description?: string;
    placeholder?: string;
}

// The clipboard's text, or null when the browser won't hand it over: no
// Clipboard API (insecure context, old browser), permission denied, the user
// dismissed Firefox/Safari's "Paste" bubble, or nothing to read.
export const readClipboardText = async (): Promise<string | null> => {
    try {
        const text = await navigator.clipboard?.readText();
        return text ? text : null;
    } catch {
        return null;
    }
};

// Reads text the user copied for a paste button. Tries the Clipboard API
// first; when the browser refuses, opens a field to paste into instead, which
// needs no permission. Resolves null if the user cancels. Render pasteDialog
// next to the button.
export const usePasteText = () => {
    const [prompt, setPrompt] = useState<PastePrompt | null>(null);
    const resolveRef = useRef<((text: string | null) => void) | null>(null);

    const finish = useCallback((text: string | null) => {
        resolveRef.current?.(text);
        resolveRef.current = null;
        setPrompt(null);
    }, []);

    const readPaste = useCallback(
        async (fallback: PastePrompt): Promise<string | null> => {
            const text = await readClipboardText();
            if (text !== null) return text;
            // A second paste click while the field is open replaces it.
            resolveRef.current?.(null);
            return new Promise((resolve) => {
                resolveRef.current = resolve;
                setPrompt(fallback);
            });
        },
        [],
    );

    // Don't leave a caller waiting forever if the button goes away.
    useEffect(() => () => resolveRef.current?.(null), []);

    const pasteDialog = <PasteFallbackDialog prompt={prompt} onDone={finish} />;

    return { readPaste, pasteDialog };
};

const PasteFallbackDialog = ({
    prompt,
    onDone,
}: {
    prompt: PastePrompt | null;
    onDone: (text: string | null) => void;
}) => {
    const [text, setText] = useState("");
    // Keep showing the last prompt while the dialog animates closed.
    const shown = useRef(prompt);
    if (prompt) shown.current = prompt;

    useEffect(() => {
        if (prompt) setText("");
    }, [prompt]);

    return (
        <Dialog
            open={prompt !== null}
            onOpenChange={(open) => {
                if (!open) onDone(null);
            }}
        >
            <DialogContent>
                <DialogTitle>{shown.current?.title}</DialogTitle>
                <DialogDescription>
                    {shown.current?.description ??
                        "Your browser blocked reading the clipboard. Paste here instead."}
                </DialogDescription>
                <textarea
                    autoFocus
                    rows={4}
                    value={text}
                    placeholder={shown.current?.placeholder ?? "Paste here"}
                    onChange={(e) => setText(e.target.value)}
                    // A paste is the whole point of the field, so use it right
                    // away instead of making the user confirm.
                    onPaste={(e) => {
                        const pasted = e.clipboardData.getData("text/plain");
                        if (pasted.trim() === "") return;
                        e.preventDefault();
                        onDone(pasted);
                    }}
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-base ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 md:text-sm"
                />
                <DialogFooter className="gap-2">
                    <Button variant="ghost" onClick={() => onDone(null)}>
                        Cancel
                    </Button>
                    <Button
                        disabled={text.trim() === ""}
                        onClick={() => onDone(text)}
                    >
                        Use text
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
};
