import { useStore } from "@nanostores/react";
import * as L from "leaflet";
import { ArrowLeft, Pause, Play } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import {
    compiledGameAtom,
    filterSupportedQuestions,
    loadGameDefinition,
} from "@/game-definition/store";
import { verifiedUserId } from "@/lib/activeSession";
import { startCalculation } from "@/lib/calculating";
import {
    hiderMode,
    hidingZoneScale,
    leafletMapContext,
    perQuestionMapData,
    planningModeEnabled,
    polyGeoJSON,
    questions,
} from "@/lib/context";
import { applyGameDefinition, currentGameId } from "@/lib/games";
import { defaultQuestionLabel, questionName } from "@/lib/questionNames";
import {
    askedFrom,
    boardAt,
    condenseReplay,
    type Endgame,
    findEndgame,
    foundAt,
    guessRoles,
    type LoggedPosition,
    positionAt,
    questionPins,
    type Replay,
    type ReplayQuestion,
    replayZoomToRemaining,
    type Role,
    trail,
} from "@/lib/replay";
import { cn } from "@/lib/utils";
import type { StationCircle } from "@/maps/api";
import { filterZoneIndexes } from "@/maps/geo-utils/geometryClient";
import {
    hidingZoneCircles,
    survivingHidingZones,
} from "@/maps/geo-utils/hidingZones";
import { type Question, type Questions, questionSchema } from "@/maps/schema";

// The replay page (tracker stack): a session's questions, as they were asked
// and answered, with the logged positions of the people playing it. It loads
// the session's game into the board's stores without touching the session:
// nothing here is saved, and the map page keeps its own state.

const API_BASE = import.meta.env.PUBLIC_API_BASE as string;
const SPEEDS = [30, 60, 120, 300];
const MARGIN_MS = 5 * 60_000;
// After the last question, how long to look for the seekers meeting the
// hider (the API sends positions this far), and to show after they did.
const FIND_WINDOW_MS = 30 * 60_000;
const AFTER_FOUND_MS = 60_000;
// Without live locations, a question asked this close to the hider's zone
// means the seekers have got there.
const ASKED_NEAR_KM = 0.5;
// Playback pauses this long on each question asked or answered, so its
// planning outline, then its cutout, can be seen.
const HOLD_MS = 2_000;
const TRAIL_MS = 15 * 60_000;
// A position older than this is drawn faded: the phone stopped reporting.
const STALE_MS = 10 * 60_000;
const HIDER_COLOR = "#dc2626";
const SEEKER_COLOR = "#2563eb";
const OTHER_COLOR = "#6b7280";

interface ReplayPerson {
    id: string;
    name: string;
    label: string | null;
    pinned: boolean;
    positions: LoggedPosition[];
}

interface ReplayResponse {
    session: {
        id: string;
        name: string;
        gameId: string;
        gameRevisionId: string;
    };
    snapshots: { at: number; questions: unknown[] }[];
    canSeeLocations: boolean;
    people: ReplayPerson[];
    hider: { lat: number; lng: number } | null;
}

// Leaflet inserts string tooltips as HTML; question names are user input.
const textNode = (text: string): HTMLElement => {
    const span = document.createElement("span");
    span.textContent = text;
    return span;
};

// In the viewer's time zone.
const clock = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
});
const shortClock = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
});

// "measuring-high-speed-rail" → "high speed rail"
const subject = (question: Question): string | null => {
    const type = (question.data as { type?: unknown }).type;
    if (typeof type !== "string") return null;
    return type.replace(new RegExp(`^${question.id}-`), "").replace(/-/g, " ");
};

function answer(question: Question): string | null {
    const d = question.data as Record<string, unknown>;
    switch (question.id) {
        case "radius":
            return `${d.radius} ${d.unit === "meters" ? "m" : d.unit === "miles" ? "mi" : "km"}: ${d.within ? "inside" : "outside"}`;
        case "matching":
            return d.same ? "same" : "different";
        case "measuring":
            return d.hiderCloser ? "hider closer" : "hider further";
        case "thermometer":
            return d.warmer ? "warmer" : "colder";
        case "tentacles": {
            const location = d.location as
                | { properties?: { name?: string } }
                | false
                | undefined;
            return location
                ? (location.properties?.name ?? "answered")
                : "none in reach";
        }
        default:
            return null;
    }
}

function questionTitle(all: Questions, question: Question): string {
    const name = questionName(question.data);
    if (name) return name;
    const label = defaultQuestionLabel(all, question.key);
    const about = subject(question);
    return about ? `${label}: ${about}` : label;
}

function parseSnapshots(snapshots: ReplayResponse["snapshots"]) {
    return snapshots.map(({ at, questions }) => ({
        at,
        questions: questions.flatMap((q) => {
            const parsed = questionSchema.safeParse(q);
            return parsed.success ? [parsed.data] : [];
        }),
    }));
}

type Mark = {
    at: number;
    kind: "asked" | "answered" | "endgame" | "found";
    key?: number;
};

function marksOf(
    replay: Replay,
    endgame: Endgame<unknown> | null,
    found: number | null,
): Mark[] {
    return [
        ...replay.questions.flatMap((q) => [
            { at: q.askedAt, kind: "asked" as const, key: q.question.key },
            {
                at: q.answeredAt,
                kind: "answered" as const,
                key: q.question.key,
            },
        ]),
        ...(endgame ? [{ at: endgame.at, kind: "endgame" as const }] : []),
        ...(found !== null ? [{ at: found, kind: "found" as const }] : []),
    ].sort((a, b) => a.at - b.at);
}

export function ReplayPage() {
    const userId = useStore(verifiedUserId);
    const map = useStore(leafletMapContext);
    const sessionId = useMemo(
        () => new URLSearchParams(location.search).get("session") ?? "",
        [],
    );
    const [data, setData] = useState<ReplayResponse | null>(null);
    const [replay, setReplay] = useState<Replay | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [time, setTime] = useState(0);
    const [playing, setPlaying] = useState(false);
    const [speed, setSpeed] = useState(120);
    // Questions shown unlocked while playback holds on their being asked.
    const [holding, setHolding] = useState<number[]>([]);
    const [showEveryone, setShowEveryone] = useState(false);
    const $zoomToRemaining = useStore(replayZoomToRemaining);
    const [hiderId, setHiderId] = useState<string | null>(null);
    const timeRef = useRef(0);
    // Until when (performance.now()) playback holds on a question; 0 = not.
    const holdUntilRef = useRef(0);
    timeRef.current = time;

    // Load the session's history and its game, once the login is confirmed.
    useEffect(() => {
        if (!userId) return;
        if (!sessionId) {
            setError("No session given.");
            return;
        }
        let cancelled = false;
        (async () => {
            const res = await fetch(
                `${API_BASE}/sessions/${encodeURIComponent(sessionId)}/replay`,
                {
                    credentials: "include",
                },
            );
            if (!res.ok) {
                throw new Error(
                    res.status === 403
                        ? "You aren't in this session."
                        : res.status === 404
                          ? "This session doesn't exist."
                          : `Couldn't load the replay (HTTP ${res.status}).`,
                );
            }
            const body = (await res.json()) as ReplayResponse;
            const condensed = condenseReplay(parseSnapshots(body.snapshots));
            const definition = await loadGameDefinition(
                body.session.gameId,
                body.session.gameRevisionId,
                sessionId,
            );
            if (cancelled) return;
            // Atoms only: switchToGame would also remember the game for the
            // map page.
            questions.set([]);
            hiderMode.set(false);
            planningModeEnabled.set(true);
            currentGameId.set(body.session.gameId);
            applyGameDefinition(definition);
            const pinned = body.people.filter((p) => p.pinned);
            const roles = guessRoles(
                pinned,
                condensed.questions[0]?.askedAt ?? condensed.start,
            );
            setHiderId(
                [...roles].find(([, role]) => role === "hider")?.[0] ?? null,
            );
            setData(body);
            setReplay(condensed);
            setTime(condensed.start - MARGIN_MS);
            document.title = `Replay: ${body.session.name}`;
        })().catch((e: Error) => {
            if (!cancelled) setError(e.message);
        });
        return () => {
            cancelled = true;
        };
    }, [userId, sessionId]);

    // The endgame: when the seekers arrived in the hider's zone (or, without
    // their positions, when the board was cleared).
    const $compiled = useStore(compiledGameAtom);
    const endgame = useMemo(() => {
        if (!replay || !$compiled || !data) return null;
        const pinned = data.people.filter((p) => p.pinned);
        const hider = pinned.find((p) => p.id === hiderId);
        // Without live locations: the session's hider location, and the
        // seekers where they asked from.
        if (!hider && data.hider) {
            const { lat, lng } = data.hider;
            return findEndgame(
                replay,
                hidingZoneCircles($compiled),
                [
                    [replay.start, lat, lng, null],
                    [replay.end, lat, lng, null],
                ],
                [askedFrom(replay)],
                ASKED_NEAR_KM,
            );
        }
        return findEndgame(
            replay,
            hidingZoneCircles($compiled),
            hider?.positions ?? null,
            pinned.filter((p) => p !== hider).map((p) => p.positions),
        );
    }, [replay, $compiled, data, hiderId]);
    // When a seeker walked up to the hider after the last question; the
    // replay runs on until shortly after.
    const found = useMemo(() => {
        if (!replay || !data) return null;
        const pinned = data.people.filter((p) => p.pinned);
        const hider = pinned.find((p) => p.id === hiderId);
        if (!hider) return null;
        return foundAt(
            hider.positions,
            pinned.filter((p) => p !== hider).map((p) => p.positions),
            replay.end,
            replay.end + FIND_WINDOW_MS,
        );
    }, [replay, data, hiderId]);
    const marks = useMemo(
        () => (replay ? marksOf(replay, endgame, found) : []),
        [replay, endgame, found],
    );

    const start = replay ? replay.start - MARGIN_MS : 0;
    const end = replay
        ? Math.max(
              replay.end + MARGIN_MS,
              found === null ? 0 : found + AFTER_FOUND_MS,
          )
        : 0;

    // Playback: advance with the clock, holding on each question asked or
    // answered on the way.
    useEffect(() => {
        if (!playing || !replay) return;
        let frame = 0;
        let last = performance.now();
        const step = (now: number) => {
            const dt = now - last;
            last = now;
            if (now < holdUntilRef.current) {
                frame = requestAnimationFrame(step);
                return;
            }
            if (holdUntilRef.current) {
                holdUntilRef.current = 0;
                setHolding([]);
            }
            const from = timeRef.current;
            let to = Math.min(end, from + dt * speed);
            const crossed = marks.filter((m) => m.at > from && m.at <= to);
            if (crossed.length > 0) {
                to = crossed[0]!.at;
                holdUntilRef.current = now + HOLD_MS;
                setHolding(
                    crossed
                        .filter((m) => m.at === to && m.kind === "asked")
                        .map((m) => m.key!),
                );
            }
            timeRef.current = to;
            setTime(to);
            if (to >= end) {
                setPlaying(false);
                return;
            }
            frame = requestAnimationFrame(step);
        };
        frame = requestAnimationFrame(step);
        return () => {
            cancelAnimationFrame(frame);
            // A speed change or pause ends a hold rather than leaving the
            // question drawn as unanswered.
            holdUntilRef.current = 0;
            setHolding([]);
        };
    }, [playing, replay, speed, marks, end]);

    // The board at this time. From the endgame on it's the hider's zone, cut
    // by the questions asked since; without a zone (no hider position), every
    // question on the play area. The questions atom only changes when a
    // question appears or its lock changes, so the geometry isn't redone
    // every frame.
    const { board, zone } = useMemo(() => {
        if (!replay) return { board: [], zone: null };
        const zone = endgame?.zone ?? null;
        const at = boardAt(replay, time, zone ? endgame!.at : null);
        return {
            zone: at.endgame ? zone : null,
            board: at.questions.map((q) =>
                holding.includes(q.key) && "drag" in q.data && !q.data.drag
                    ? ({ ...q, data: { ...q.data, drag: true } } as Question)
                    : q,
            ),
        };
    }, [replay, time, holding, endgame]);
    const zoneName = zone?.properties.properties.name ?? null;
    const boardKey =
        `${zone ? zone.properties.properties.id : ""}|` +
        board
            .map((q) => `${q.key}:${"drag" in q.data && q.data.drag}`)
            .join(",");
    useEffect(() => {
        if (!replay || !$compiled) return;
        polyGeoJSON.set(
            zone
                ? { type: "FeatureCollection", features: [zone] }
                : $compiled.playArea,
        );
        questions.set(filterSupportedQuestions(board, $compiled));
        // Only when the board's questions, locks or zone change, not every frame.
    }, [boardKey, replay, $compiled]);

    // The hiding zones the answers so far leave, drawn as the map page draws
    // them. Not in the endgame: the board is then the hider's zone.
    const $perQuestionMapData = useStore(perQuestionMapData);
    const $hidingZoneScale = useStore(hidingZoneScale);
    const [zonesLeft, setZonesLeft] = useState<StationCircle[]>([]);
    useEffect(() => {
        if (!$compiled || zone) {
            setZonesLeft([]);
            return;
        }
        let current = true;
        const finish = startCalculation("replay-zones");
        survivingHidingZones(
            $compiled,
            $perQuestionMapData,
            $hidingZoneScale,
            filterZoneIndexes,
            () => current,
        )
            .then((zones) => {
                if (current && zones) setZonesLeft(zones);
            })
            .catch((error) => console.error(error))
            .finally(finish);
        return () => {
            current = false;
        };
    }, [$compiled, $perQuestionMapData, $hidingZoneScale, zone]);
    useEffect(() => {
        if (!map || zonesLeft.length === 0) return;
        // Their own pane, under the board's shading and the question pins.
        if (!map.getPane("replayZones"))
            map.createPane("replayZones").style.zIndex = "390";
        const layer = L.geoJSON(zonesLeft, {
            pane: "replayZones",
            interactive: false,
            style: {
                color: "green",
                fillColor: "green",
                fillOpacity: 0.2,
                weight: 2,
            },
        }).addTo(map);
        return () => {
            layer.remove();
        };
    }, [map, zonesLeft]);

    // The hider's zone, outlined from the start: where they hid, as the
    // endgame found it.
    const hiderZoneShown = endgame?.zone ?? null;
    useEffect(() => {
        if (!map || !hiderZoneShown) return;
        // Above the board's shading, so it shows even where it's cut away.
        if (!map.getPane("replayHiderZone"))
            map.createPane("replayHiderZone").style.zIndex = "450";
        const layer = L.geoJSON(hiderZoneShown, {
            pane: "replayHiderZone",
            interactive: false,
            style: {
                color: HIDER_COLOR,
                weight: 3,
                dashArray: "6 6",
                fill: false,
            },
        }).addTo(map);
        return () => {
            layer.remove();
        };
    }, [map, hiderZoneShown]);

    // People shown, with their roles and names.
    const people = useMemo(() => {
        if (!data) return [];
        return data.people
            .filter((p) => p.pinned || showEveryone)
            .map((p) => {
                const role: Role | null = !p.pinned
                    ? null
                    : p.id === hiderId
                      ? "hider"
                      : "seeker";
                const name = p.label ?? p.name;
                const display = role
                    ? `${role === "hider" ? "Hider" : "Seeker"} · ${name}`
                    : name;
                return { ...p, role, display };
            });
    }, [data, showEveryone, hiderId]);

    // People and question pins go on one layer, moved as time passes.
    const layerRef = useRef<L.LayerGroup | null>(null);
    const markersRef = useRef(
        new globalThis.Map<
            string,
            { marker: L.Marker; line: L.Polyline; look: string }
        >(),
    );
    useEffect(() => {
        if (!map) return;
        const layer = L.layerGroup().addTo(map);
        layerRef.current = layer;
        const markers = markersRef.current;
        return () => {
            layer.remove();
            layerRef.current = null;
            markers.clear();
        };
    }, [map]);

    useEffect(() => {
        const layer = layerRef.current;
        if (!layer) return;
        const markers = markersRef.current;
        const wanted = new Set(people.map((p) => p.id));
        for (const [id, m] of markers) {
            if (wanted.has(id)) continue;
            layer.removeLayer(m.marker);
            layer.removeLayer(m.line);
            markers.delete(id);
        }
        for (const person of people) {
            const color =
                person.role === "hider"
                    ? HIDER_COLOR
                    : person.role === "seeker"
                      ? SEEKER_COLOR
                      : OTHER_COLOR;
            let m = markers.get(person.id);
            if (!m) {
                m = {
                    marker: L.marker([0, 0], {
                        zIndexOffset: 1000,
                        interactive: false,
                    }),
                    line: L.polyline([], {
                        weight: 4,
                        opacity: 0.55,
                        interactive: false,
                    }),
                    look: "",
                };
                m.marker.bindTooltip("", {
                    permanent: true,
                    direction: "bottom",
                    offset: [0, 12],
                });
                markers.set(person.id, m);
            }
            const initial = (person.label ?? person.name)
                .charAt(0)
                .toUpperCase();
            const look = `${color}|${initial}|${person.display}`;
            if (m.look !== look) {
                m.look = look;
                // Names come from Google: set as text, never as HTML.
                const dot = document.createElement("div");
                dot.style.cssText = `width:28px;height:28px;border-radius:50%;background:${color};border:3px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;color:#fff;font:700 13px sans-serif`;
                dot.textContent = initial;
                m.marker.setIcon(
                    L.divIcon({
                        className: "",
                        iconSize: [28, 28],
                        iconAnchor: [14, 14],
                        html: dot,
                    }),
                );
                const label = document.createElement("span");
                label.textContent = person.display;
                label.style.color = color;
                label.style.fontWeight = "600";
                m.marker.setTooltipContent(label);
                m.line.setStyle({ color });
            }
            const at = positionAt(person.positions, time);
            if (!at) {
                layer.removeLayer(m.marker);
                layer.removeLayer(m.line);
                continue;
            }
            if (!layer.hasLayer(m.line)) layer.addLayer(m.line);
            if (!layer.hasLayer(m.marker)) layer.addLayer(m.marker);
            m.marker.setLatLng([at.lat, at.lng]);
            m.marker.setOpacity(time - at.reportedAt > STALE_MS ? 0.45 : 1);
            m.line.setLatLngs(trail(person.positions, time - TRAIL_MS, time));
        }
    }, [people, time, map]);

    // The pins of the questions on the board.
    useEffect(() => {
        const layer = layerRef.current;
        if (!layer || !replay) return;
        const all = replay.questions.map((q) => q.question);
        const pins = board.flatMap((q) =>
            questionPins(q).map((latlng) =>
                L.circleMarker(latlng, {
                    radius: 6,
                    weight: 2,
                    color: "#fff",
                    fillColor: (q.data as { color?: string }).color ?? "#111",
                    fillOpacity: 1,
                }).bindTooltip(textNode(questionTitle(all, q)), {
                    direction: "top",
                }),
            ),
        );
        for (const pin of pins) layer.addLayer(pin);
        return () => {
            for (const pin of pins) layer.removeLayer(pin);
        };
        // Only when the board's questions or locks change.
    }, [boardKey, replay, map]);

    const seek = (at: number) => {
        holdUntilRef.current = 0;
        setHolding([]);
        timeRef.current = at;
        setTime(at);
    };

    if (error) {
        return (
            <div className="fixed inset-0 z-[1050] flex flex-col items-center justify-center gap-4 bg-background text-center">
                <p className="text-lg">{error}</p>
                <a
                    href="/map"
                    className="text-sm underline text-muted-foreground"
                >
                    Back to the map
                </a>
            </div>
        );
    }
    if (!replay || !data) {
        return (
            <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[1050] rounded-full bg-background/90 border px-3 py-1 text-sm">
                Loading the replay…
            </div>
        );
    }

    const all = replay.questions.map((q) => q.question);
    const span = Math.max(1, end - start);
    const pct = (at: number) => `${((at - start) / span) * 100}%`;
    const pinnedPeople = people.filter((p) => p.pinned);

    return (
        <>
            <aside className="absolute top-2 left-2 z-[1040] flex max-h-[calc(100svh-8rem)] w-72 max-w-[calc(100vw-1rem)] flex-col gap-2 overflow-y-auto rounded-lg border bg-background/95 p-3 text-sm shadow backdrop-blur-sm">
                <div className="flex items-center gap-2">
                    <a
                        href="/map"
                        title="Back to the map"
                        className="text-muted-foreground hover:text-foreground"
                    >
                        <ArrowLeft className="h-4 w-4" />
                    </a>
                    <h1 className="font-semibold truncate">
                        Replay: {data.session.name}
                    </h1>
                </div>
                {replay.questions.length === 0 && (
                    <p className="text-muted-foreground">
                        No questions were answered in this session.
                    </p>
                )}
                <ol className="flex flex-col gap-0.5">
                    {replay.questions.map((q: ReplayQuestion) => {
                        const state =
                            time < q.askedAt
                                ? "future"
                                : time < q.answeredAt
                                  ? "asking"
                                  : "answered";
                        const result = answer(q.question);
                        return (
                            <li key={q.question.key}>
                                <button
                                    type="button"
                                    onClick={() => seek(q.askedAt)}
                                    className={cn(
                                        "w-full rounded px-2 py-1 text-left hover:bg-accent",
                                        state === "future" && "opacity-50",
                                        state === "asking" && "bg-amber-500/15",
                                    )}
                                >
                                    <span className="block truncate font-medium">
                                        {questionTitle(all, q.question)}
                                    </span>
                                    <span className="block text-xs text-muted-foreground">
                                        {shortClock.format(q.askedAt)} →{" "}
                                        {shortClock.format(q.answeredAt)}
                                        {result && ` · ${result}`}
                                    </span>
                                </button>
                            </li>
                        );
                    })}
                </ol>
                {data.canSeeLocations && (
                    <div className="flex flex-col gap-1.5 border-t pt-2">
                        {pinnedPeople.length > 1 && (
                            <label className="flex items-center justify-between gap-2">
                                <span>Hider</span>
                                <select
                                    value={hiderId ?? ""}
                                    onChange={(e) =>
                                        setHiderId(e.target.value || null)
                                    }
                                    className="rounded border bg-background px-1 py-0.5"
                                >
                                    {pinnedPeople.map((p) => (
                                        <option key={p.id} value={p.id}>
                                            {p.label ?? p.name}
                                        </option>
                                    ))}
                                </select>
                            </label>
                        )}
                        {pinnedPeople.length === 0 && !showEveryone && (
                            <p className="text-xs text-muted-foreground">
                                Nobody was pinned in this session.
                            </p>
                        )}
                        <label className="flex items-center gap-2 text-xs text-muted-foreground">
                            <input
                                type="checkbox"
                                checked={showEveryone}
                                onChange={(e) =>
                                    setShowEveryone(e.target.checked)
                                }
                            />
                            Everyone sharing their location
                        </label>
                        <label className="flex items-center gap-2 text-xs text-muted-foreground">
                            <input
                                type="checkbox"
                                checked={$zoomToRemaining}
                                onChange={(e) =>
                                    replayZoomToRemaining.set(e.target.checked)
                                }
                            />
                            Zoom to what&apos;s left after each answer
                        </label>
                    </div>
                )}
            </aside>

            <div className="absolute bottom-2 left-2 right-2 z-[1040] flex flex-col gap-1 rounded-lg border bg-background/95 px-3 py-2 shadow backdrop-blur-sm">
                <div className="relative h-5">
                    {marks.map((m, i) => (
                        <span
                            key={i}
                            title={
                                m.kind === "found"
                                    ? "Found: a seeker reached the hider"
                                    : m.kind === "endgame"
                                      ? endgame?.by === "arrival"
                                          ? "Endgame: the seekers reached the hider's zone"
                                          : "Endgame: the board was cleared"
                                      : `${m.kind === "asked" ? "Asked" : "Answered"}: ${questionTitle(all, all.find((q) => q.key === m.key)!)}`
                            }
                            className={cn(
                                "absolute bottom-0 -translate-x-1/2",
                                m.kind === "asked" && "h-2 w-0.5 bg-amber-400",
                                m.kind === "answered" &&
                                    "h-3 w-0.5 bg-green-500",
                                m.kind === "endgame" && "h-5 w-1 bg-red-600",
                                m.kind === "found" && "h-5 w-1 bg-violet-600",
                            )}
                            style={{ left: pct(m.at) }}
                        />
                    ))}
                    {endgame && (
                        <span
                            className="absolute top-0 pl-1.5 text-[10px] leading-none text-red-500"
                            style={{ left: pct(endgame.at) }}
                        >
                            Endgame
                        </span>
                    )}
                    {found !== null && (
                        <span
                            className="absolute top-0 pr-1.5 -translate-x-full text-[10px] leading-none text-violet-500"
                            style={{ left: pct(found) }}
                        >
                            Found
                        </span>
                    )}
                </div>
                <input
                    type="range"
                    aria-label="Time"
                    min={start}
                    max={end}
                    step={1000}
                    value={time}
                    onChange={(e) => seek(Number(e.target.value))}
                    className="w-full"
                />
                <div className="flex items-center gap-3">
                    <button
                        type="button"
                        onClick={() => {
                            if (!playing && time >= end) seek(start);
                            if (playing) setHolding([]);
                            setPlaying(!playing);
                        }}
                        aria-label={playing ? "Pause" : "Play"}
                        className="rounded-full bg-primary p-1.5 text-primary-foreground hover:bg-primary/90"
                    >
                        {playing ? (
                            <Pause className="h-4 w-4" />
                        ) : (
                            <Play className="h-4 w-4" />
                        )}
                    </button>
                    <span className="font-mono tabular-nums">
                        {clock.format(time)}
                        {zoneName && (
                            <span className="ml-2 text-xs font-sans text-red-400">
                                Endgame · {zoneName}
                            </span>
                        )}
                    </span>
                    <select
                        aria-label="Speed"
                        value={speed}
                        onChange={(e) => setSpeed(Number(e.target.value))}
                        className="rounded border bg-background px-1 py-0.5 text-sm"
                    >
                        {SPEEDS.map((s) => (
                            <option key={s} value={s}>
                                {s}×
                            </option>
                        ))}
                    </select>
                    <span className="ml-auto hidden text-xs text-muted-foreground sm:block">
                        <span className="text-amber-400">▍</span> asked{" "}
                        <span className="text-green-500">▍</span> answered
                        {data.canSeeLocations && (
                            <>
                                {" "}
                                <span style={{ color: HIDER_COLOR }}>
                                    ●
                                </span>{" "}
                                hider{" "}
                                <span style={{ color: SEEKER_COLOR }}>●</span>{" "}
                                seeker
                            </>
                        )}
                        {hiderZoneShown && (
                            <>
                                {" "}
                                <span
                                    className="inline-block h-2.5 w-2.5 rounded-full border-2 border-dashed align-middle"
                                    style={{ borderColor: HIDER_COLOR }}
                                />{" "}
                                hider&apos;s zone
                            </>
                        )}
                    </span>
                </div>
            </div>
        </>
    );
}
