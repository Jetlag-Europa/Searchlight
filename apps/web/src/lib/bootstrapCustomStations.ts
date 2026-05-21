import { drawingEnabled } from "@/annotations/hooks/useAnnotationStore";

let hasRun = false;

export function bootstrapDefaults(): void {
    if (hasRun) return;
    hasRun = true;

    // Pen mode starts off on every load so the user opts in per-session.
    drawingEnabled.set(false);

    // Game defaults are now applied by SessionManager when a session is selected.
    // No game bootstrap here.
}
