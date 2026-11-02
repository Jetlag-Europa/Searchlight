import * as turf from "@turf/turf";
import type { BBox, Feature, MultiPolygon, Polygon } from "geojson";
import { atom } from "nanostores";

import type { Question, Questions } from "@/maps/schema";

// Session replays (tracker stack). A session's history is its question list
// after every change, and most changes are noise: pins being placed, drafts
// deleted again, questions unlocked to fix a detail. A replay keeps only the
// questions that were really asked, each with when it was asked and answered.

// Whether the replay's map zooms to what's left after each answer, instead of
// the app's auto-zoom setting. In memory only.
export const replayZoomToRemaining = atom(true);

export interface ReplaySnapshot {
    // When the server received the change, in ms.
    at: number;
    questions: Questions;
}

export interface ReplayQuestion {
    // The question as it was last, locked (its final answer).
    question: Question;
    // When it first appeared on the board.
    askedAt: number;
    // When it was first locked, i.e. answered.
    answeredAt: number;
}

export interface Replay {
    questions: ReplayQuestion[];
    // When every question was removed at once, as when the endgame starts.
    clears: number[];
    start: number;
    end: number;
}

// Questions without pins (zone size) have no lock: they count as locked.
const unlocked = (question: Question): boolean =>
    "drag" in question.data && question.data.drag;

interface Track {
    question: Question;
    askedAt: number;
    answeredAt: number | null;
    // How it left the board: individually (a mistake or a replaced draft) or
    // in a clear; null while it is still there.
    removed: "deleted" | "cleared" | null;
}

/**
 * Keeps the questions that were answered: locked the last time they were seen,
 * and either still on the board at the end or removed in a clear. Questions
 * deleted on their own, or never locked, are noise. Questions cleared away
 * still count: clearing the board doesn't unask them.
 */
export function condenseReplay(snapshots: ReplaySnapshot[]): Replay {
    const tracks = new Map<number, Track>();
    const clears: number[] = [];
    let onBoard = new Set<number>();
    // The questions the last clear removed, until the next change shows it
    // stuck (an undo brings them back).
    let lastCleared: number[] = [];

    for (const { at, questions } of snapshots) {
        const now = new Set<number>();
        for (const question of questions) {
            now.add(question.key);
            let track = tracks.get(question.key);
            if (!track) {
                track = {
                    question,
                    askedAt: at,
                    answeredAt: null,
                    removed: null,
                };
                tracks.set(question.key, track);
            }
            track.question = question;
            track.removed = null;
            if (!unlocked(question) && track.answeredAt === null)
                track.answeredAt = at;
        }
        if (lastCleared.some((key) => now.has(key))) clears.pop();
        lastCleared = [];
        const gone = [...onBoard].filter((key) => !now.has(key));
        // A clear takes several answered questions off at once; deleting the
        // last question on the board is just a deletion.
        const cleared =
            questions.length === 0 &&
            gone.filter((key) => !unlocked(tracks.get(key)!.question)).length >=
                2;
        if (cleared) {
            clears.push(at);
            lastCleared = gone;
        }
        for (const key of gone)
            tracks.get(key)!.removed = cleared ? "cleared" : "deleted";
        onBoard = now;
    }

    const asked: ReplayQuestion[] = [];
    for (const track of tracks.values()) {
        if (
            track.removed === "deleted" ||
            unlocked(track.question) ||
            track.answeredAt === null
        )
            continue;
        asked.push({
            question: track.question,
            askedAt: track.askedAt,
            answeredAt: track.answeredAt,
        });
    }
    asked.sort((a, b) => a.askedAt - b.askedAt);

    return {
        questions: asked,
        clears,
        start: snapshots[0]?.at ?? 0,
        end: snapshots[snapshots.length - 1]?.at ?? 0,
    };
}

/**
 * The board at `time`: every question asked by then, unlocked (shown as a
 * planning outline) until it was answered, then locked (cut out).
 */
export function questionsAt(replay: Replay, time: number): Questions {
    return replay.questions
        .filter((q) => q.askedAt <= time)
        .map((q) => {
            const drag = q.answeredAt > time;
            return !("drag" in q.question.data) || unlocked(q.question) === drag
                ? q.question
                : ({
                      ...q.question,
                      data: { ...q.question.data, drag },
                  } as Question);
        });
}

export interface Board {
    questions: Questions;
    // Whether the endgame has started: the board is then the hider's zone
    // and only the endgame's questions cut it.
    endgame: boolean;
}

/**
 * The board at `time`. Before the endgame (from `endgameAt`), every question
 * asked before it, on the game's play area; from then on, only the questions
 * asked since, which cut the hider's zone.
 */
export function boardAt(
    replay: Replay,
    time: number,
    endgameAt: number | null,
): Board {
    const questions = questionsAt(replay, time);
    if (endgameAt === null) return { questions, endgame: false };
    const endgame = time >= endgameAt;
    return {
        questions: questions.filter(
            (q) => askedAt(replay, q) >= endgameAt === endgame,
        ),
        endgame,
    };
}

const askedAt = (replay: Replay, question: Question): number =>
    replay.questions.find((q) => q.question.key === question.key)!.askedAt;

const boxes = new WeakMap<Feature, BBox>();
const boxOf = (zone: Feature): BBox => {
    let box = boxes.get(zone);
    if (!box) {
        box = turf.bbox(zone);
        boxes.set(zone, box);
    }
    return box;
};

/**
 * The zone the hider was in: the one containing their position, the nearest
 * by its centre if several do, or else the nearest within `maxKm` (a GPS fix
 * can land just outside). Null if none is that close.
 */
export function hiderZone<T extends Feature<Polygon | MultiPolygon>>(
    zones: T[],
    position: { lat: number; lng: number },
    maxKm = 1,
): T | null {
    const point = turf.point([position.lng, position.lat]);
    // Only zones whose box, grown by maxKm, holds the point can be close.
    const dLat = maxKm / 111;
    const dLng = dLat / Math.cos((position.lat * Math.PI) / 180);
    const candidates = zones.filter((zone) => {
        const [west, south, east, north] = boxOf(zone);
        return (
            position.lat >= south - dLat &&
            position.lat <= north + dLat &&
            position.lng >= west - dLng &&
            position.lng <= east + dLng
        );
    });
    const distance = (zone: T) =>
        turf.distance(point, turf.centroid(zone), { units: "kilometers" });
    const byDistance = (a: T, b: T) => distance(a) - distance(b);
    const containing = candidates
        .filter((zone) => turf.booleanPointInPolygon(point, zone))
        .sort(byDistance);
    if (containing.length > 0) return containing[0]!;
    const nearest = candidates
        .map((zone) => ({
            zone,
            km: turf.pointToPolygonDistance(point, zone, {
                units: "kilometers",
            }),
        }))
        .sort((a, b) => a.km - b.km)[0];
    return nearest && nearest.km <= maxKm ? nearest.zone : null;
}

/** Where a question's pins are: most have one, the thermometer two. */
export function questionPins(question: Question): [number, number][] {
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

// A seeker has arrived in the hider's zone once they've stayed this long,
// not counting dips outside shorter than DIP_MS (GPS jitter, the zone's
// edge); a train passing through doesn't count.
const STAY_MS = 5 * 60_000;
const DIP_MS = 3 * 60_000;
// Questions asked this long before the seekers arrived, from this close to
// the zone, already cut it down: the endgame starts with them.
const LEAD_MS = 15 * 60_000;
const NEAR_KM = 2;

export interface Endgame<T> {
    // When it started: the seekers arriving in the hider's zone, or the
    // first question asked as they got there.
    at: number;
    // The hider's zone; null if the hider's positions don't show it.
    zone: T | null;
    // What showed it: the seekers' positions, or (without those) the board
    // being cleared.
    by: "arrival" | "clear";
}

/**
 * The zone the hider spent the most time in from `from` to `to`, by their
 * reports there; null if none is near them.
 */
export function mainZone<T extends Feature<Polygon | MultiPolygon>>(
    zones: T[],
    positions: LoggedPosition[],
    from: number,
    to: number,
): T | null {
    const counts = new Map<T, number>();
    for (const [t, lat, lng] of positions) {
        if (t < from || t > to) continue;
        const zone = hiderZone(zones, { lat, lng });
        if (zone) counts.set(zone, (counts.get(zone) ?? 0) + 1);
    }
    let best: T | null = null;
    for (const [zone, count] of counts)
        if (best === null || count > counts.get(best)!) best = zone;
    return best;
}

/**
 * When someone arrived in `zone` to stay, between `from` and `to`: the start
 * of their first stay of at least STAY_MS, or of a stay their reports end in.
 */
export function arrivedAt(
    positions: LoggedPosition[],
    zone: Feature<Polygon | MultiPolygon>,
    from: number,
    to: number,
): number | null {
    let since: number | null = null;
    let outSince: number | null = null;
    for (const [t, lat, lng] of positions) {
        if (t < from) continue;
        if (t > to) break;
        if (turf.booleanPointInPolygon(turf.point([lng, lat]), zone)) {
            // Out too long since leaving: a new stay.
            if (since === null || (outSince !== null && t - outSince >= DIP_MS))
                since = t;
            outSince = null;
            if (t - since >= STAY_MS) return since;
        } else if (since !== null) {
            outSince ??= t;
            if (t - outSince >= DIP_MS) since = outSince = null;
        }
    }
    return outSince === null ? since : null;
}

/**
 * When the endgame started, and where. It starts when the first seeker
 * arrives in the hider's zone (the one the hider spent the game in), or
 * earlier with a question asked as they got there: shortly before, with its
 * pin near the zone. Without positions to tell, the first clear of the board
 * marks it.
 */
export function findEndgame<T extends Feature<Polygon | MultiPolygon>>(
    replay: Replay,
    zones: T[],
    hider: LoggedPosition[] | null,
    seekers: LoggedPosition[][],
): Endgame<T> | null {
    const from = replay.questions[0]?.askedAt ?? replay.start;
    const zone = hider ? mainZone(zones, hider, from, replay.end) : null;
    if (zone) {
        const arrivals = seekers
            .map((positions) => arrivedAt(positions, zone, from, replay.end))
            .filter((at): at is number => at !== null);
        if (arrivals.length > 0) {
            const arrived = Math.min(...arrivals);
            const near = (lat: number, lng: number) =>
                turf.pointToPolygonDistance(turf.point([lng, lat]), zone, {
                    units: "kilometers",
                }) <= NEAR_KM;
            const lead = replay.questions.filter(
                (q) =>
                    q.askedAt >= arrived - LEAD_MS &&
                    q.askedAt < arrived &&
                    questionPins(q.question).some(([lat, lng]) =>
                        near(lat, lng),
                    ),
            );
            return {
                at: Math.min(arrived, ...lead.map((q) => q.askedAt)),
                zone,
                by: "arrival",
            };
        }
    }
    const cleared = replay.clears[0];
    if (cleared === undefined) return null;
    const position =
        hider && (positionAt(hider, cleared) ?? positionAt(hider, Infinity));
    return {
        at: cleared,
        zone: zone ?? (position ? hiderZone(zones, position) : null),
        by: "clear",
    };
}

// [time ms, lat, lng, accuracy m]
export type LoggedPosition = [number, number, number, number | null];

export interface PositionAt {
    lat: number;
    lng: number;
    accuracy: number | null;
    // When the phone last reported, at or before `time`.
    reportedAt: number;
}

/**
 * Where someone was at `time`, between the reports around it. Before the first
 * report there's nothing; after the last one, the last position.
 */
export function positionAt(
    positions: LoggedPosition[],
    time: number,
): PositionAt | null {
    if (positions.length === 0 || time < positions[0]![0]) return null;
    let lo = 0;
    let hi = positions.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (positions[mid]![0] <= time) lo = mid;
        else hi = mid - 1;
    }
    const [t0, lat0, lng0, acc0] = positions[lo]!;
    const next = positions[lo + 1];
    if (!next) return { lat: lat0, lng: lng0, accuracy: acc0, reportedAt: t0 };
    const [t1, lat1, lng1] = next;
    const f = t1 > t0 ? (time - t0) / (t1 - t0) : 0;
    return {
        lat: lat0 + (lat1 - lat0) * f,
        lng: lng0 + (lng1 - lng0) * f,
        accuracy: acc0,
        reportedAt: t0,
    };
}

/** The reports in [from, to], plus the interpolated end, for a trail. */
export function trail(
    positions: LoggedPosition[],
    from: number,
    to: number,
): [number, number][] {
    const points: [number, number][] = positions
        .filter(([t]) => t >= from && t <= to)
        .map(([, lat, lng]) => [lat, lng]);
    const end = positionAt(positions, to);
    if (end) points.push([end.lat, end.lng]);
    return points;
}

export type Role = "hider" | "seeker";

// Rough distance in km, plenty for comparing how far people roam.
function km(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const x = (lng2 - lng1) * Math.cos(((lat1 + lat2) / 2) * (Math.PI / 180));
    return Math.hypot(x, lat2 - lat1) * 111.32;
}

/**
 * Tells the hider from the seekers: once questions start, the hider stays in
 * their zone while the seekers travel. The person whose positions from `from`
 * on lie closest around their own middle is the hider; everyone else seeks.
 * People with no positions from then on get no role.
 */
export function guessRoles(
    people: { id: string; positions: LoggedPosition[] }[],
    from: number,
): Map<string, Role> {
    const spreads = people
        .map(({ id, positions }) => {
            const after = positions.filter(([t]) => t >= from);
            if (after.length === 0) return null;
            const lat = after.reduce((sum, p) => sum + p[1], 0) / after.length;
            const lng = after.reduce((sum, p) => sum + p[2], 0) / after.length;
            const spread =
                after.reduce((sum, p) => sum + km(p[1], p[2], lat, lng), 0) /
                after.length;
            return { id, spread };
        })
        .filter((s): s is { id: string; spread: number } => s !== null);
    const roles = new Map<string, Role>();
    if (spreads.length < 2) return roles;
    const hider = spreads.reduce((a, b) => (b.spread < a.spread ? b : a));
    for (const { id } of spreads)
        roles.set(id, id === hider.id ? "hider" : "seeker");
    return roles;
}
