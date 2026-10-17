import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}

// crypto.randomUUID() requires a secure context (HTTPS/localhost).
// This works on plain HTTP (e.g. local network IP).
export function randomUUID(): string {
    const b = new Uint8Array(16);
    crypto.getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
    return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}

export const mapToObj = <T, K extends string, V>(
    arr: T[],
    fn: (item: T) => [K, V],
) => Object.fromEntries(arr.map(fn));

/**
 * A distance for display in the player's unit: "850 m" or "12.34 km" in
 * kilometres, "0.53 mi" or "420 ft" in miles, "12,345 m" in meters.
 */
export function formatDistance(
    meters: number,
    unit: "meters" | "kilometers" | "miles",
): string {
    if (unit === "miles") {
        const miles = meters / 1609.344;
        if (miles < 0.1) return `${Math.round(meters / 0.3048)} ft`;
        return `${miles.toFixed(2)} mi`;
    }
    if (unit === "meters" || meters < 1000) {
        return `${Math.round(meters).toLocaleString("en")} m`;
    }
    return `${(meters / 1000).toFixed(2)} km`;
}
