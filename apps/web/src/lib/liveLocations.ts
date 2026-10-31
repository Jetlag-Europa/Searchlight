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

// Edits started here so far; a PATCH answer only counts if no newer edit began.
let editSeq = 0;

// Applies the change here at once, then saves it with the session. If saving
// fails, only this change is undone.
async function editPin(
    personId: string,
    change: { shown?: boolean; label?: string | null },
    apply: (
        state: Pick<LiveLocationsState, "shown" | "labels">,
        shown: boolean | undefined,
        label: string | null | undefined,
    ) => Pick<LiveLocationsState, "shown" | "labels">,
): Promise<void> {
    const sessionId = activeSessionId.get();
    if (!sessionId) return;
    const seq = ++editSeq;
    lastPinEdit = Date.now();
    const before = liveLocations.get();
    const wasShown = before.shown.includes(personId);
    const oldLabel = before.labels[personId] ?? null;
    liveLocations.set({
        ...before,
        ...apply(before, change.shown, change.label),
    });
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
        if (seq === editSeq && activeSessionId.get() === sessionId) {
            liveLocations.set({ ...liveLocations.get(), ...pins });
        }
    } catch (e) {
        if (activeSessionId.get() === sessionId) {
            const now = liveLocations.get();
            liveLocations.set({
                ...now,
                ...apply(
                    now,
                    change.shown === undefined ? undefined : wasShown,
                    change.label === undefined ? undefined : oldLabel,
                ),
            });
        }
        throw e;
    }
}

// Sets one person's pin and name in `state`; undefined leaves that part.
function applyPin(
    personId: string,
    state: Pick<LiveLocationsState, "shown" | "labels">,
    shown: boolean | undefined,
    label: string | null | undefined,
): Pick<LiveLocationsState, "shown" | "labels"> {
    let { shown: ids, labels } = state;
    if (shown !== undefined) {
        ids = ids.filter((other) => other !== personId);
        if (shown) ids = [...ids, personId];
    }
    if (label !== undefined) {
        labels = { ...labels };
        if (label) labels[personId] = label;
        else delete labels[personId];
    }
    return { shown: ids, labels };
}

export const setPersonShown = (id: string, shown: boolean) =>
    editPin(id, { shown }, (state, s, l) => applyPin(id, state, s, l));

export const setPersonLabel = (id: string, label: string) =>
    editPin(id, { label: label.trim() || null }, (state, s, l) =>
        applyPin(id, state, s, l),
    );

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
            // Without locations.view, stop until the session changes or the
            // page is shown again.
            if (gen === generation && liveLocations.get().allowed !== false) {
                timer = setTimeout(schedule, POLL_MS);
            }
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
