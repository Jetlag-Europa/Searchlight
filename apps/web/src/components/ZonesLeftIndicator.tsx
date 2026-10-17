import { useStore } from "@nanostores/react";

import { showCalculating } from "@/lib/calculating";
import { zonesLeft } from "@/lib/zonesLeft";

/**
 * How many hiding zones are left, without opening the zone sidebar. It sits
 * where the "Calculating…" pill shows and gives way to it, as the count is
 * about to change.
 */
export function ZonesLeftIndicator() {
    const $zonesLeft = useStore(zonesLeft);
    const $showCalculating = useStore(showCalculating);
    if (!$zonesLeft || $showCalculating) return null;
    return (
        <div
            role="status"
            className="fixed top-[72px] md:top-10 left-1/2 -translate-x-1/2 z-[1041] flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs bg-background/90 border border-border shadow-sm backdrop-blur-sm pointer-events-none whitespace-nowrap"
        >
            <span className="text-muted-foreground">
                {$zonesLeft.left} of {$zonesLeft.total} zones left
            </span>
        </div>
    );
}
