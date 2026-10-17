import { atom } from "nanostores";

import { readStorage, removeStorage, writeStorage } from "@/lib/safeStorage";

/** [west, south, east, north] */
export type GameBounds = [number, number, number, number];

/** The bounds the map last framed a game with, and a session playing it. */
export interface GameView {
    gameId: string;
    sessionId?: string;
    bounds: GameBounds;
}

// This tab's current game (currentGameId in games.ts).
export const GAME_SS_KEY = "taibled-current-game-id";
const LAST_GAME_VIEW_KEY = "lastGameView";

export const isGameBounds = (bounds: unknown): bounds is GameBounds =>
    Array.isArray(bounds) &&
    bounds.length === 4 &&
    bounds.every((value) => Number.isFinite(value));

function readGameView(): GameView | null {
    try {
        const view = JSON.parse(
            readStorage("localStorage", LAST_GAME_VIEW_KEY) ?? "null",
        );
        return typeof view?.gameId === "string" && isGameBounds(view.bounds)
            ? view
            : null;
    } catch {
        return null;
    }
}

// A reload opens on this view while the game's definition loads, or if it
// can't. Storage is best-effort: when it is full or blocked, the view is only
// kept for this page.
export const lastGameView = atom<GameView | null>(readGameView());

/** Remember a game's view, keeping the session known to play it. */
export function rememberGameView(
    gameId: string,
    bounds: GameBounds,
    sessionId?: string,
): void {
    const previous = lastGameView.get();
    const view: GameView = {
        gameId,
        bounds,
        sessionId:
            sessionId ??
            (previous?.gameId === gameId ? previous.sessionId : undefined),
    };
    lastGameView.set(view);
    writeStorage("localStorage", LAST_GAME_VIEW_KEY, JSON.stringify(view));
}

/** The saved view of this tab's game, or else of the session being restored. */
export function savedGameView(
    gameId: string,
    sessionId: string,
): GameView | null {
    const view = lastGameView.get();
    if (!view) return null;
    const matches = gameId
        ? view.gameId === gameId
        : Boolean(sessionId) && view.sessionId === sessionId;
    return matches ? view : null;
}

/** Forget the games this browser showed, for the next user of the device. */
export function forgetGameViews(): void {
    lastGameView.set(null);
    removeStorage("localStorage", LAST_GAME_VIEW_KEY);
    removeStorage("sessionStorage", GAME_SS_KEY);
}
