import { useStore } from "@nanostores/react";

import { showCalculating } from "@/lib/calculating";
import { sidebarContextL, sidebarContextR } from "@/lib/context";
import { zonesLeft } from "@/lib/zonesLeft";

/**
 * How many hiding zones are left, without opening the zone sidebar. map.astro
 * puts it in the chip stack in the map's top-right corner, under the session
 * chip. It hides while the "Calculating…" pill shows, as the count is about
 * to change. On a phone, a sidebar covers the map, so the pill steps aside
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
    if (!$zonesLeft || $showCalculating || sidebarCoversMap) return null;
    return (
        <div
            role="status"
            className="pointer-events-none flex w-max items-center gap-1.5 rounded-full px-2.5 py-1 text-xs bg-background/90 border border-border shadow-sm backdrop-blur-sm whitespace-nowrap"
        >
            <span className="text-muted-foreground">
                {$zonesLeft.left} of {$zonesLeft.total} zones left
            </span>
        </div>
    );
}
