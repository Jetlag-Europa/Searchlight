import { atom, computed } from "nanostores";

import { activeSessionId } from "@/lib/activeSession";

// Live positions from Google Maps location sharing, which the API relays from
// the location tracker for the Google account of the session's server. Which
// people are pinned, and what their pins are called, is saved with the
// session, so everyone in it who may see live locations sees the same pins.

const API_BASE = import.meta.env.PUBLIC_API_BASE as string;
const POLL_MS = 15_000;

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
    // Whether the user may see live locations in this session (locations.view
    // on its server); null until the server has said.
    allowed: boolean | null;
    // The server's Google account; null when it has none.
    account: string | null;
    // false until the first answer, and while the tracker is unreachable.
    reachable: boolean;
    // Whether the tracker's last read from Google worked.
    ok: boolean;
    error: string | null;
    updatedAt: number | null;
    people: LivePerson[];
    // The session's pins: who shows on the map, and renamed pins.
    shown: string[];
    labels: Record<string, string>;
}

const EMPTY: LiveLocationsState = {
    allowed: null,
    account: null,
    reachable: false,
    ok: false,
    error: null,
    updatedAt: null,
    people: [],
    shown: [],
    labels: {},
};

export const liveLocations = atom<LiveLocationsState>(EMPTY);

export const displayName = (
    person: LivePerson,
    labels: Record<string, string>,
): string => labels[person.id] ?? person.name;

export const shownPeople = computed(liveLocations, (state) =>
    state.people.filter((p) => state.shown.includes(p.id)),
);

let generation = 0;
// When pins last changed here. Poll answers requested before that may carry
// the old pins, so they keep the local ones.
let lastPinEdit = 0;

async function poll(sessionId: string, gen: number): Promise<void> {
    const requestedAt = Date.now();
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
                ...(res.status === 403 && { allowed: false, people: [] }),
                reachable: false,
                ok: false,
                error: body?.message ?? body?.error ?? `HTTP ${res.status}`,
            });
            return;
        }
        const body = (await res.json()) as Omit<
            LiveLocationsState,
            "allowed" | "reachable"
        >;
        if (gen !== generation) return;
        const current = liveLocations.get();
        const keepPins = requestedAt <= lastPinEdit;
        liveLocations.set({
            ...body,
            allowed: true,
            reachable: true,
            shown: keepPins ? current.shown : body.shown,
            labels: keepPins ? current.labels : body.labels,
        });
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

// Applies the change here at once, then saves it with the session; puts the
// pins back if saving fails.
async function editPin(
    personId: string,
    change: { shown?: boolean; label?: string | null },
    local: (state: LiveLocationsState) => Partial<LiveLocationsState>,
): Promise<void> {
    const sessionId = activeSessionId.get();
    if (!sessionId) return;
    lastPinEdit = Date.now();
    const before = liveLocations.get();
    liveLocations.set({ ...before, ...local(before) });
    try {
        const res = await fetch(
            `${API_BASE}/sessions/${sessionId}/live-locations`,
            {
                method: "PATCH",
                credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ personId, ...change }),
            },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const pins = (await res.json()) as Pick<
            LiveLocationsState,
            "shown" | "labels"
        >;
        lastPinEdit = Date.now();
        if (activeSessionId.get() === sessionId) {
            liveLocations.set({ ...liveLocations.get(), ...pins });
        }
    } catch (e) {
        if (activeSessionId.get() === sessionId) {
            liveLocations.set({
                ...liveLocations.get(),
                shown: before.shown,
                labels: before.labels,
            });
        }
        throw e;
    }
}

export const setPersonShown = (id: string, shown: boolean) =>
    editPin(id, { shown }, (s) => ({
        shown: shown
            ? [...s.shown.filter((other) => other !== id), id]
            : s.shown.filter((other) => other !== id),
    }));

export const setPersonLabel = (id: string, label: string) => {
    const trimmed = label.trim();
    return editPin(id, { label: trimmed || null }, (s) => {
        const labels = { ...s.labels };
        if (trimmed) labels[id] = trimmed;
        else delete labels[id];
        return { labels };
    });
};

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
        liveLocations.set(EMPTY);
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
