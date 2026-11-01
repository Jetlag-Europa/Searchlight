import type { Question, Questions } from "@/maps/schema";

// Session replays (tracker stack). A session's history is its question list
// after every change, and most changes are noise: pins being placed, drafts
// deleted again, questions unlocked to fix a detail. A replay keeps only the
// questions that were really asked, each with when it was asked and answered.

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
            if (!question.data.drag && track.answeredAt === null)
                track.answeredAt = at;
        }
        const gone = [...onBoard].filter((key) => !now.has(key));
        const cleared = questions.length === 0 && gone.length > 0;
        if (cleared) clears.push(at);
        for (const key of gone)
            tracks.get(key)!.removed = cleared ? "cleared" : "deleted";
        onBoard = now;
    }

    const asked: ReplayQuestion[] = [];
    for (const track of tracks.values()) {
        if (
            track.removed === "deleted" ||
            track.question.data.drag ||
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
            return q.question.data.drag === drag
                ? q.question
                : ({
                      ...q.question,
                      data: { ...q.question.data, drag },
                  } as Question);
        });
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
