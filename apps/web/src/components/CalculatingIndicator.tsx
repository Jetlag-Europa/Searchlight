import { useStore } from "@nanostores/react";
import { Loader2 } from "lucide-react";

import { showCalculating } from "@/lib/calculating";

/**
 * Says the map is still working out question results. The spinner is a CSS
 * transform animation, which keeps turning while geometry work holds up the
 * main thread.
 */
export function CalculatingIndicator() {
    if (!useStore(showCalculating)) return null;
    return (
        <div
            role="status"
            className="fixed top-[72px] left-1/2 -translate-x-1/2 z-[1041] flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs bg-background/90 border border-border shadow-sm backdrop-blur-sm pointer-events-none"
        >
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
            <span className="text-muted-foreground">Calculating…</span>
        </div>
    );
}
