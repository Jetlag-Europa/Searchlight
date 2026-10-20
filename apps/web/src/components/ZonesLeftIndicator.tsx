import { useStore } from "@nanostores/react";

import { showCalculating } from "@/lib/calculating";
import { sidebarContextL, sidebarContextR } from "@/lib/context";
import { zonesLeft } from "@/lib/zonesLeft";

/**
 * How many hiding zones are left, without opening the zone sidebar. It sits
 * in the top-right corner under the session chip, out of the way of the map,
 * and hides while the "Calculating…" pill shows, as the count is about to
 * change. On a phone, a sidebar covers the map, so the pill steps aside
 * rather than cover the sidebar's controls.
 */
export function ZonesLeftIndicator() {
    const $zonesLeft = useStore(zonesLeft);
    const $showCalculating = useStore(showCalculating);
    const left = useStore(sidebarContextL);
    const right = useStore(sidebarContextR);
    const sidebarCoversMap =
        (left.isMobile && left.openMobile) ||
        (right.isMobile && right.openMobile);
    // Line up with the user and session chips, which make room for the zone
    // sidebar when it is open.
    const rightOffset = right.open ? "calc(16rem + 3.5rem)" : "3.5rem";
    if (!$zonesLeft || $showCalculating || sidebarCoversMap) return null;
    return (
        <div
            role="status"
            className="fixed top-[72px] z-[1041] flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs bg-background/90 border border-border shadow-sm backdrop-blur-sm pointer-events-none whitespace-nowrap transition-[right] duration-200 ease-linear"
            style={{ right: rightOffset }}
        >
            <span className="text-muted-foreground">
                {$zonesLeft.left} of {$zonesLeft.total} zones left
            </span>
        </div>
    );
}
