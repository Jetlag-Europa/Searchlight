import { atom, computed } from "nanostores";

import { activeSessionId } from "@/lib/activeSession";
import { readStorage, writeStorage } from "@/lib/safeStorage";

// Live positions from Google Maps location sharing, which the API relays from
// the location tracker. Which people show is a per-device choice, saved for
// each session.

const API_BASE = import.meta.env.PUBLIC_API_BASE as string;
const POLL_MS = 15_000;
const STORAGE_PREFIX = "searchlight-live-locations:";

export interface LivePerson {
    id: string;
    name: string;
    photoUrl: string | null;
    lat: number;
    lng: number;
    accuracy: number | null;
    timestamp: number | null;
    battery: number | null;
    charging: boolean | null;
}

export interface LiveLocationsState {
    // false until the first answer, and while the tracker is unreachable.
    reachable: boolean;
    // Whether the tracker's last read from Google worked.
    ok: boolean;
    error: string | null;
    updatedAt: number | null;
    people: LivePerson[];
}

export const liveLocations = atom<LiveLocationsState>({
    reachable: false,
    ok: false,
    error: null,
    updatedAt: null,
    people: [],
});

function readShown(sessionId: string): string[] {
    try {
        const ids = JSON.parse(
            readStorage("localStorage", STORAGE_PREFIX + sessionId) ?? "[]",
        );
        return Array.isArray(ids)
            ? ids.filter((id) => typeof id === "string")
            : [];
    } catch {
        return [];
    }
}

// The IDs of the people this device shows in the active session.
export const shownPersonIds = atom<string[]>(readShown(activeSessionId.get()));
activeSessionId.listen((sessionId) => shownPersonIds.set(readShown(sessionId)));

export function setPersonShown(id: string, shown: boolean): void {
    const sessionId = activeSessionId.get();
    const ids = shownPersonIds.get().filter((other) => other !== id);
    if (shown) ids.push(id);
    shownPersonIds.set(ids);
    if (sessionId) {
        writeStorage(
            "localStorage",
            STORAGE_PREFIX + sessionId,
            JSON.stringify(ids),
        );
    }
}

export const shownPeople = computed(
    [liveLocations, shownPersonIds],
    (state, ids) => state.people.filter((p) => ids.includes(p.id)),
);

let generation = 0;

async function poll(sessionId: string, gen: number): Promise<void> {
    try {
        const res = await fetch(
            `${API_BASE}/sessions/${sessionId}/live-locations`,
            { credentials: "include" },
        );
        if (gen !== generation) return;
        if (!res.ok) {
            const body = await res.json().catch(() => null);
            liveLocations.set({
                ...liveLocations.get(),
                reachable: false,
                ok: false,
                error: body?.error ?? `HTTP ${res.status}`,
            });
            return;
        }
        const body = (await res.json()) as Omit<
            LiveLocationsState,
            "reachable"
        >;
        if (gen !== generation) return;
        liveLocations.set({ ...body, reachable: true });
    } catch {
        if (gen !== generation) return;
        liveLocations.set({
            ...liveLocations.get(),
            reachable: false,
            ok: false,
            error: "Can't reach the server",
        });
    }
}

/**
 * Polls while a session is active and the page is visible. Returns a stop
 * function.
 */
export function startLiveLocations(): () => void {
    let timer: ReturnType<typeof setTimeout> | undefined;

    const schedule = () => {
        clearTimeout(timer);
        const sessionId = activeSessionId.get();
        if (!sessionId || document.visibilityState !== "visible") return;
        const gen = generation;
        void poll(sessionId, gen).finally(() => {
            if (gen === generation) timer = setTimeout(schedule, POLL_MS);
        });
    };
    const restart = () => {
        generation++;
        schedule();
    };

    const unlisten = activeSessionId.listen(() => {
        liveLocations.set({
            reachable: false,
            ok: false,
            error: null,
            updatedAt: null,
            people: [],
        });
        restart();
    });
    document.addEventListener("visibilitychange", restart);
    restart();

    return () => {
        generation++;
        clearTimeout(timer);
        unlisten();
        document.removeEventListener("visibilitychange", restart);
    };
}
