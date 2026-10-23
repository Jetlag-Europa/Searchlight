import type { ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * Puts a chip in its slot in map.astro's chip stack, in the map's top-right
 * corner. The stack sits inside the map area, so it moves aside when the zone
 * sidebar opens, and each chip sits under the ones before it. Pages without
 * the slot, such as /games, show the chip in the window's top-right corner.
 */
export function StatusChip({
    slot,
    children,
}: {
    slot: "user" | "session" | "conflicts";
    children: ReactNode;
}) {
    const el = document.getElementById(`${slot}-chip-slot`);
    if (el) return createPortal(children, el);
    return <div className="fixed top-2 right-14 z-[1041]">{children}</div>;
}
