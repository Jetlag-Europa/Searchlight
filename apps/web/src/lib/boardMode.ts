import { atom, computed } from "nanostores";

export type BoardMode = "online" | "local";

/**
 * Metadata for the active local-only session on `/local`.
 * Kept separate from `activeSessionData` so online-only UI (ShareDrawer,
 * InviteDrawer, SessionUpgradeBanner, SyncIndicator) never activates in
 * local mode.
 */
export interface ActiveLocalSessionInfo {
  id: string;
  name: string;
  gameId: string;
  gameName: string;
}

function detectInitialBoardMode(): BoardMode {
  if (
    typeof window !== "undefined" &&
    typeof window.location?.pathname === "string" &&
    /^\/local(?:\/|$)/.test(window.location.pathname)
  ) {
    return "local";
  }
  return "online";
}

/**
 * Whether the current page is the synced `/map` board or the browser-local
 * `/local` board. Initialized from the URL so Astro islands hydrating in any
 * order agree on the mode from their very first render.
 */
export const boardMode = atom<BoardMode>(detectInitialBoardMode());

export const isLocalBoard = computed(boardMode, (mode) => mode === "local");

export const activeLocalSession = atom<ActiveLocalSessionInfo | null>(null);
