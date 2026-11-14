import { atom } from "nanostores";

// Another tab or window of this browser took the active session over (see
// tabLock): this board shows it, but saves and sends nothing for it. On its
// own, for the service worker's script on every page (see serviceWorker.tsx).
export const editingInOtherTab = atom(false);
