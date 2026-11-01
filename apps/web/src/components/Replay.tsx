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
import {
    hiderMode,
    leafletMapContext,
    planningModeEnabled,
    questions,
} from "@/lib/context";
import { applyGameDefinition, currentGameId } from "@/lib/games";
import { defaultQuestionLabel, questionName } from "@/lib/questionNames";
import {
    condenseReplay,
    guessRoles,
    type LoggedPosition,
    positionAt,
    questionsAt,
    type Replay,
    type ReplayQuestion,
    type Role,
    trail,
} from "@/lib/replay";
import { cn } from "@/lib/utils";
import { type Question, type Questions, questionSchema } from "@/maps/schema";

// The replay page (tracker stack): a session's questions, as they were asked
// and answered, with the logged positions of the people playing it. It loads
// the session's game into the board's stores without touching the session:
// nothing here is saved, and the map page keeps its own state.

const API_BASE = import.meta.env.PUBLIC_API_BASE as string;
const SPEEDS = [30, 60, 120, 300];
const MARGIN_MS = 5 * 60_000;
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
}

const clock = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Amsterdam",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
});
const shortClock = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Amsterdam",
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

// Where a question's pins are: most have one, the thermometer two.
function questionPins(question: Question): [number, number][] {
    const d = question.data as Record<string, unknown>;
    if (typeof d.latA === "number" && typeof d.lngA === "number") {
        const pins: [number, number][] = [[d.latA, d.lngA]];
        if (typeof d.latB === "number" && typeof d.lngB === "number")
            pins.push([d.latB, d.lngB]);
        return pins;
    }
    if (typeof d.lat === "number" && typeof d.lng === "number")
        return [[d.lat, d.lng]];
    return [];
}

type Mark = {
    at: number;
    kind: "asked" | "answered" | "endgame";
    key?: number;
};

function marksOf(replay: Replay): Mark[] {
    return [
        ...replay.questions.flatMap((q) => [
            { at: q.askedAt, kind: "asked" as const, key: q.question.key },
            {
                at: q.answeredAt,
                kind: "answered" as const,
                key: q.question.key,
            },
        ]),
        ...replay.clears.map((at) => ({ at, kind: "endgame" as const })),
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
    const [hiderId, setHiderId] = useState<string | null>(null);
    const timeRef = useRef(0);
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
                `${API_BASE}/sessions/${sessionId}/replay`,
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

    const marks = useMemo(() => (replay ? marksOf(replay) : []), [replay]);
    const start = replay ? replay.start - MARGIN_MS : 0;
    const end = replay ? replay.end + MARGIN_MS : 0;

    // Playback: advance with the clock, holding on each question asked or
    // answered on the way.
    useEffect(() => {
        if (!playing || !replay) return;
        let frame = 0;
        let last = performance.now();
        let holdUntil = 0;
        const step = (now: number) => {
            const dt = now - last;
            last = now;
            if (now < holdUntil) {
                frame = requestAnimationFrame(step);
                return;
            }
            if (holdUntil) {
                holdUntil = 0;
                setHolding([]);
            }
            const from = timeRef.current;
            let to = Math.min(end, from + dt * speed);
            const crossed = marks.filter((m) => m.at > from && m.at <= to);
            if (crossed.length > 0) {
                to = crossed[0]!.at;
                holdUntil = now + HOLD_MS;
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
        return () => cancelAnimationFrame(frame);
    }, [playing, replay, speed, marks, end]);

    // The board at this time. The questions atom only changes when a question
    // appears or its lock changes, so the geometry isn't redone every frame.
    const board = useMemo(() => {
        if (!replay) return [];
        return questionsAt(replay, time).map((q) =>
            holding.includes(q.key) && "drag" in q.data && !q.data.drag
                ? ({ ...q, data: { ...q.data, drag: true } } as Question)
                : q,
        );
    }, [replay, time, holding]);
    const boardKey = board
        .map((q) => `${q.key}:${"drag" in q.data && q.data.drag}`)
        .join(",");
    useEffect(() => {
        if (!replay) return;
        const compiled = compiledGameAtom.get();
        questions.set(
            compiled ? filterSupportedQuestions(board, compiled) : board,
        );
        // Only when the board's questions or locks change, not every frame.
    }, [boardKey, replay]);

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
                }).bindTooltip(questionTitle(all, q), { direction: "top" }),
            ),
        );
        for (const pin of pins) layer.addLayer(pin);
        return () => {
            for (const pin of pins) layer.removeLayer(pin);
        };
        // Only when the board's questions or locks change.
    }, [boardKey, replay, map]);

    const seek = (at: number) => {
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
                    </div>
                )}
            </aside>

            <div className="absolute bottom-2 left-2 right-2 z-[1040] flex flex-col gap-1 rounded-lg border bg-background/95 px-3 py-2 shadow backdrop-blur-sm">
                <div className="relative h-5">
                    {marks.map((m, i) => (
                        <span
                            key={i}
                            title={
                                m.kind === "endgame"
                                    ? "Endgame"
                                    : `${m.kind === "asked" ? "Asked" : "Answered"}: ${questionTitle(all, all.find((q) => q.key === m.key)!)}`
                            }
                            className={cn(
                                "absolute bottom-0 -translate-x-1/2",
                                m.kind === "asked" && "h-2 w-0.5 bg-amber-400",
                                m.kind === "answered" &&
                                    "h-3 w-0.5 bg-green-500",
                                m.kind === "endgame" && "h-5 w-1 bg-red-600",
                            )}
                            style={{ left: pct(m.at) }}
                        />
                    ))}
                    {replay.clears.map((at) => (
                        <span
                            key={at}
                            className="absolute top-0 pl-1.5 text-[10px] leading-none text-red-500"
                            style={{ left: pct(at) }}
                        >
                            Endgame
                        </span>
                    ))}
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
                    </span>
                </div>
            </div>
        </>
    );
}
