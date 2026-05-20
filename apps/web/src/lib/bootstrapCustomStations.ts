import { drawingEnabled } from "@/annotations/hooks/useAnnotationStore";
import {
    applyGameDefaults,
    currentGameId,
    GAMES,
    getGameById,
} from "@/lib/games";

let hasRun = false;

export function bootstrapDefaults(): void {
    if (hasRun) return;
    hasRun = true;

    // Pen mode starts off on every load so the user opts in per-session.
    drawingEnabled.set(false);

    const game = getGameById(currentGameId.get()) ?? GAMES[0];
    applyGameDefaults(game);
}
