import { useStore } from "@nanostores/react";
import { useEffect, useId, useRef } from "react";

import { Button } from "@/components/ui/button";
import { editingInOtherTab } from "@/lib/activeSession";
import { sessionPickerOpen } from "@/lib/context";

/**
 * Over the board while another tab or window of this browser edits the
 * session (see editSessionHere). Use here reloads the page, which takes the
 * session back with what the other tab saved (offline too: from the copy
 * kept here).
 */
export function OtherTabNotice() {
    const shown = useStore(editingInOtherTab);
    const titleId = useId();
    const buttonRef = useRef<HTMLButtonElement>(null);
    // The board's controls are out of reach, as under the picker.
    useEffect(() => {
        const board = document.getElementById("map-board");
        if (!shown || !board) return;
        board.inert = true;
        buttonRef.current?.focus();
        return () => {
            board.inert = sessionPickerOpen.get();
        };
    }, [shown]);
    if (!shown) return null;
    return (
        <div className="fixed inset-0 z-[9000] flex items-center justify-center bg-background/60 p-4">
            <div
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
                className="w-full max-w-sm rounded-xl border border-border bg-card p-5 shadow-xl"
            >
                <h1 id={titleId} className="text-base font-semibold">
                    This session is open in another tab
                </h1>
                <p className="mt-1 mb-4 text-sm text-muted-foreground">
                    It can be changed in one tab at a time.
                </p>
                <Button
                    ref={buttonRef}
                    size="sm"
                    onClick={() => window.location.reload()}
                >
                    Use here
                </Button>
            </div>
        </div>
    );
}
