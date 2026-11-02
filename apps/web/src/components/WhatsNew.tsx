import { useStore } from "@nanostores/react";
import { lazy, Suspense, useEffect, useState } from "react";

import { gameDefinitionReady, sessionPickerOpen } from "@/lib/context";
import { preferencesLoaded } from "@/lib/preferencesSync";
import {
    checkReleaseNotes,
    currentNotesVersion,
    markReleaseNotesSeen,
    releaseNotesOpen,
} from "@/lib/releaseNotes";

// Loaded only when the notes are shown, with the notes themselves.
const ReleaseNotesDialog = lazy(() => import("./ReleaseNotesDialog"));

/**
 * Shows the notes of a new major or minor release once, on the board after
 * the player's session has loaded, and again when the map menu asks.
 */
export function WhatsNew() {
    const open = useStore(releaseNotesOpen);
    const loaded = useStore(preferencesLoaded);
    const gameReady = useStore(gameDefinitionReady);
    const pickerOpen = useStore(sessionPickerOpen);
    // Stays mounted once shown, so closing animates.
    const [shown, setShown] = useState(false);
    const [checked, setChecked] = useState(false);

    // Wait for the account's preferences, which say what it saw on other
    // devices, and for the board, so the notes don't cover the session
    // picker or a game that is still loading.
    useEffect(() => {
        if (checked || !loaded || !gameReady || pickerOpen) return;
        setChecked(true);
        if (checkReleaseNotes()) releaseNotesOpen.set(true);
    }, [checked, loaded, gameReady, pickerOpen]);

    useEffect(() => {
        if (open) setShown(true);
    }, [open]);

    if (!currentNotesVersion || !shown) return null;
    return (
        <Suspense fallback={null}>
            <ReleaseNotesDialog
                notes={currentNotesVersion}
                open={open}
                onClose={() => {
                    releaseNotesOpen.set(false);
                    markReleaseNotesSeen();
                }}
            />
        </Suspense>
    );
}
