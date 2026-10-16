import { persistentAtom } from "@nanostores/persistent";
import type { FeatureCollection, MultiPolygon, Polygon } from "geojson";
import type { Map as LeafletMap } from "leaflet";
import { atom, onSet } from "nanostores";

import { radarRadii } from "@/game-definition/compile";
import { compiledGameAtom, isQuestionSupported } from "@/game-definition/store";
import type { StationCircle } from "@/maps/api";
import { extractStationLabel } from "@/maps/geo-utils";
import {
    type DeepPartial,
    type Question,
    type Questions,
    questionSchema,
    type Units,
} from "@/maps/schema";

export const permanentOverlay = persistentAtom<FeatureCollection | null>(
    "permanentOverlay",
    null,
    {
        encode: JSON.stringify,
        decode: JSON.parse,
        listen: false,
    },
);

// The game's play area, set when its definition is applied. Not persisted:
// until a game loads, there is none.
export const mapGeoJSON = atom<FeatureCollection<
    Polygon | MultiPolygon
> | null>(null);
export const polyGeoJSON = atom<FeatureCollection<
    Polygon | MultiPolygon
> | null>(null);

// Questions are server-backed and restored on session selection.
export const questions = atom<Questions>([]);
// Player-drawn variants, allowed in every game (see isQuestionSupported).
const playerCustomData = (family: string): Record<string, unknown> =>
    family === "tentacle"
        ? { locationType: "custom", places: [] }
        : { type: family === "matching" ? "custom-points" : "custom-measure" };
export const addQuestion = (question: DeepPartial<Question>) => {
    // Every question belongs to a game: none can be added until its
    // definition has loaded.
    const compiled = compiledGameAtom.get();
    if (!compiled) throw new Error("The game has not loaded yet");
    const candidate: any = {
        ...question,
        data: { ...((question as any).data ?? {}) },
    };
    const family =
        candidate.id === "tentacles"
            ? "tentacle"
            : candidate.id === "matching" || candidate.id === "measuring"
              ? candidate.id
              : undefined;
    if (family) {
        const idField = family === "tentacle" ? "locationType" : "type";
        if (candidate.data[idField] === undefined) {
            const first = compiled.questions.find((q) => q.family === family);
            // A game with no layer for this family still allows custom ones.
            if (first) candidate.data[idField] = first.id;
            else {
                for (const [key, value] of Object.entries(
                    playerCustomData(family),
                ))
                    candidate.data[key] ??= value;
            }
        }
    }
    // A game's radar starts at its first declared radius, not the schema's
    // generic default.
    if (candidate.id === "radius" && candidate.data.radius === undefined) {
        const [radius] = radarRadii(compiled);
        if (radius) {
            candidate.data.radius = radius.value;
            candidate.data.unit = radius.unit;
        }
    }
    const parsed = questionSchema.parse(candidate);
    if (!isQuestionSupported(parsed, compiled)) {
        throw new Error("This question is not part of the active game");
    }
    questionModified(questions.get().push(parsed));
};
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export const questionModified = (..._: any[]) => {
    if (autoSave.get()) {
        questions.set([...questions.get()]);
    } else {
        triggerLocalRefresh.set(Math.random());
    }
};

export const leafletMapContext = atom<LeafletMap | null>(null);

export const defaultUnit = persistentAtom<Units>("defaultUnit", "kilometers", {
    listen: false,
});
// Not persisted to localStorage — the DB is the source of truth (restored on session load).
export const hiderMode = atom<false | { latitude: number; longitude: number }>(
    false,
);
export const triggerLocalRefresh = atom<number>(0);
export const displayHidingZones = persistentAtom<boolean>(
    "displayHidingZones",
    false,
    {
        encode: JSON.stringify,
        decode: JSON.parse,
        listen: false,
    },
);
export const displayHidingZonesStyle = persistentAtom<
    "zones" | "stations" | "no-overlap" | "no-display"
>("displayHidingZonesStyle", "zones", { listen: false });
export const showZoneNames = persistentAtom<boolean>("showZoneNames", false, {
    encode: JSON.stringify,
    decode: JSON.parse,
});
export const questionFinishedMapData = atom<any>(null);

// Per-question standalone "still-possible" regions, used for dodge-aware hiding
// zone survival (a zone survives if it overlaps EACH question's region
// independently). See computePerQuestionRegions / DissapearingAct.
export const perQuestionMapData = atom<{ question: any; region: any }[]>([]);

export const trainStations = atom<StationCircle[]>([]);
onSet(trainStations, ({ newValue }) => {
    newValue.sort((a, b) => {
        const aName = (extractStationLabel(a.properties) || "") as string;
        const bName = (extractStationLabel(b.properties) || "") as string;
        return aName.localeCompare(bName);
    });
});

export const animateMapMovements = persistentAtom<boolean>(
    "animateMapMovements",
    false,
    {
        encode: JSON.stringify,
        decode: JSON.parse,
    },
);
export const disabledStations = persistentAtom<string[]>(
    "disabledStations",
    [],
    {
        encode: JSON.stringify,
        decode: JSON.parse,
        listen: false,
    },
);
export const autoSave = persistentAtom<boolean>("autoSave", true, {
    encode: JSON.stringify,
    decode: JSON.parse,
});
export const warningAlarm = persistentAtom<boolean>("warningAlarm2", false, {
    encode: JSON.stringify,
    decode: JSON.parse,
});
export const save = () => {
    questions.set([...questions.get()]);
    const $hiderMode = hiderMode.get();

    if ($hiderMode !== false) {
        hiderMode.set({ ...$hiderMode });
    }
};

/* Presets for custom questions (savable / sharable / editable) */
export type CustomPreset = {
    id: string;
    name: string;
    type: string;
    data: any;
    createdAt: string;
};

export const customPresets = persistentAtom<CustomPreset[]>(
    "customPresets",
    [],
    {
        encode: JSON.stringify,
        decode: JSON.parse,
    },
);
onSet(customPresets, ({ newValue }) => {
    newValue.sort((a, b) => a.name.localeCompare(b.name));
});

export const saveCustomPreset = (
    preset: Omit<CustomPreset, "id" | "createdAt">,
) => {
    const id =
        typeof crypto !== "undefined" &&
        typeof (crypto as any).randomUUID === "function"
            ? (crypto as any).randomUUID()
            : String(Date.now());
    const p: CustomPreset = {
        ...preset,
        id,
        createdAt: new Date().toISOString(),
    };
    customPresets.set([...customPresets.get(), p]);
    return p;
};

export const updateCustomPreset = (
    id: string,
    updates: Partial<CustomPreset>,
) => {
    customPresets.set(
        customPresets
            .get()
            .map((p) => (p.id === id ? { ...p, ...updates } : p)),
    );
};

export const deleteCustomPreset = (id: string) => {
    customPresets.set(customPresets.get().filter((p) => p.id !== id));
};

// True once the session's game definition has been applied: false before the
// first game loads, from the start of a game switch, and after loading failed.
// The map must not evaluate questions meanwhile: a game's questions have no
// definition to be answered from yet.
export const gameDefinitionReady = atom<boolean>(false);

export const drawingQuestionKey = atom<number>(-1);
// ID of the single hiding-zone the user has focused via a "View" button,
// or "" for the all-zones overview. Lifted to a shared atom so the
// bottom-bar "All Zones" button can clear it from outside the sidebar.
export const hidingZoneFocusedStationID = atom<string>("");
export const planningModeEnabled = atom<boolean>(false);
export const autoZoom = persistentAtom<boolean>("autoZoom", true, {
    encode: JSON.stringify,
    decode: JSON.parse,
});

export const isLoading = atom<boolean>(false);
const loadingScopeCounts = new Map<string | symbol, number>();

export function setScopedLoading(
    scope: string | symbol,
    active: boolean,
): void {
    const current = loadingScopeCounts.get(scope) ?? 0;
    if (active) {
        loadingScopeCounts.set(scope, current + 1);
    } else {
        const next = Math.max(0, current - 1);
        if (next === 0) {
            loadingScopeCounts.delete(scope);
        } else {
            loadingScopeCounts.set(scope, next);
        }
    }
    let total = 0;
    for (const count of loadingScopeCounts.values()) {
        total += count;
    }
    isLoading.set(total > 0);
}

export function resetScopedLoading(scope?: string | symbol): void {
    if (scope) {
        loadingScopeCounts.delete(scope);
    } else {
        loadingScopeCounts.clear();
    }
    let total = 0;
    for (const count of loadingScopeCounts.values()) {
        total += count;
    }
    isLoading.set(total > 0);
}
/** Release one operation exactly once, including when its view unmounts. */
export function acquireScopedLoading(scope: string | symbol): () => void {
    setScopedLoading(scope, true);
    let released = false;
    return () => {
        if (released) return;
        released = true;
        setScopedLoading(scope, false);
    };
}

export const baseTileLayer = persistentAtom<
    "voyager" | "light" | "dark" | "transport" | "neighbourhood" | "osmcarto"
>("baseTileLayer", "voyager");
export const thunderforestApiKey = persistentAtom<string>(
    "thunderforestApiKey",
    "",
    {
        encode: (value: string) => value,
        decode: (value: string) => value,
    },
);
export const followMe = persistentAtom<boolean>("followMe", false, {
    encode: JSON.stringify,
    decode: JSON.parse,
});
export const defaultCustomQuestions = persistentAtom<boolean>(
    "defaultCustomQuestions",
    false,
    {
        encode: JSON.stringify,
        decode: JSON.parse,
    },
);

export const customInitPreference = persistentAtom<"ask" | "blank" | "prefill">(
    "customInitPreference",
    "ask",
    {
        encode: JSON.stringify,
        decode: JSON.parse,
    },
);

export const allowGooglePlusCodes = persistentAtom<boolean>(
    "allowGooglePlusCodes",
    false,
    {
        encode: JSON.stringify,
        decode: JSON.parse,
    },
);
export const autoLockQuestions = persistentAtom<boolean>(
    "autoLockQuestions",
    false,
    {
        encode: JSON.stringify,
        decode: JSON.parse,
    },
);

// Shared sidebar context atoms — kept here so all islands (client:load and
// client:only) resolve the same module instance and therefore the same atom.
export type SidebarContextType = {
    state: "expanded" | "collapsed";
    open: boolean;
    setOpen: (open: boolean) => void;
    openMobile: boolean;
    setOpenMobile: (open: boolean) => void;
    isMobile: boolean;
    toggleSidebar: () => void;
};

const _defaultSidebarCtx: SidebarContextType = {
    state: "expanded",
    open: true,
    setOpen: () => {},
    openMobile: false,
    setOpenMobile: () => {},
    isMobile: false,
    toggleSidebar: () => {},
};

export const sidebarContextL = atom<SidebarContextType>({
    ..._defaultSidebarCtx,
});
export const sidebarContextR = atom<SidebarContextType>({
    ..._defaultSidebarCtx,
});

// ── Sync status ───────────────────────────────────────────────────────────────

export type SyncStatus = "synced" | "syncing" | "offline" | "live";
export const syncStatus = atom<SyncStatus>("synced");
export const pendingEventCount = atom<number>(0);

// ── Presence ─────────────────────────────────────────────────────────────────

export type PresenceUser = {
    userId: string;
    displayName: string;
    avatarUrl: string;
};
export const connectedUsers = atom<PresenceUser[]>([]);

// ── Cross-island session load request ─────────────────────────────────────────
// InviteDrawer sets this to a sessionId; SessionManager listens and loads it.
export const pendingSessionLoad = atom<string | null>(null);
// Whether the session picker covers the map; what it covers is inert.
export const sessionPickerOpen = atom<boolean>(false);
