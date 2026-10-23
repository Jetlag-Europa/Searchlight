// What a question asks and its answer, in a line, for a player choosing
// between two versions of it. Session questions are stored unparsed and may
// come from other builds, so nothing here trusts a field's shape: anything
// unreadable falls back to the question's type, and nothing throws.

import { sameQuestion, sameQuestionKey } from "@/lib/questionMerge";
import { defaultQuestionLabel, questionName } from "@/lib/questionNames";
import { formatDistance } from "@/lib/utils";
import { formatMultiplier, validMultiplier } from "@/lib/zoneSize";

type Fields = Record<string, unknown>;
type DistanceUnit = "meters" | "kilometers" | "miles";

export interface SummaryOptions {
    // The game's name for a question kind ("Nearest Airport"), from the
    // compiled game; without it the kind's id is tidied up instead.
    kindLabel?: (kind: string) => string | undefined;
    // The player's unit, for how far a pin moved.
    unit?: DistanceUnit;
}

// The same names as the question cards' labels (questionNames.ts).
const TYPE_LABELS: Record<string, string> = {
    radius: "Radius",
    thermometer: "Thermometer",
    tentacles: "Tentacles",
    matching: "Matching",
    measuring: "Measuring",
    "zone-size": "Zone Size",
};

const UNIT_ABBREVIATIONS: Record<DistanceUnit, string> = {
    meters: "m",
    kilometers: "km",
    miles: "mi",
};

const isFields = (value: unknown): value is Fields =>
    !!value && typeof value === "object" && !Array.isArray(value);

const fieldsOf = (value: unknown): Fields => (isFields(value) ? value : {});

const dataOf = (question: unknown): Fields => fieldsOf(fieldsOf(question).data);

const finite = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;

const text = (value: unknown): string | undefined =>
    typeof value === "string" && value.trim() ? value.trim() : undefined;

const unitOf = (value: unknown): DistanceUnit | undefined =>
    value === "meters" || value === "kilometers" || value === "miles"
        ? value
        : undefined;

const typeId = (question: unknown): string | undefined =>
    text(fieldsOf(question).id);

/** "Radius", or "Question" for a type this build doesn't know. */
export function questionTypeLabel(question: unknown): string {
    const id = typeId(question);
    return (id && TYPE_LABELS[id]) || "Question";
}

// "2 km", "500 m", "1.5 mi", as the radius cards' quick picks write them. A
// question saved without its unit reads it in the player's, as the board
// does (schema.ts defaults it so).
function formatLength(
    value: unknown,
    unit: unknown,
    options: SummaryOptions,
): string | undefined {
    const n = finite(value);
    if (n === undefined) return undefined;
    const u = unitOf(unit) ?? options.unit ?? "kilometers";
    if (u === "meters" && n >= 1000 && n % 100 === 0) return `${n / 1000} km`;
    return `${n} ${UNIT_ABBREVIATIONS[u]}`;
}

// "matching-rail-terminus" -> "Rail terminus", for a game that isn't loaded.
function tidyKind(kind: string, prefix: string): string {
    const rest = kind.startsWith(prefix) ? kind.slice(prefix.length) : kind;
    const words = rest.replace(/[-_]+/g, " ").trim();
    return words ? words[0].toUpperCase() + words.slice(1) : kind;
}

const CUSTOM_KINDS: Record<string, string> = {
    custom: "Custom locations",
    "custom-zone": "Custom zone",
    "custom-points": "Custom points",
    "custom-measure": "Custom measure",
};

function kindLabel(
    kind: unknown,
    prefix: string,
    options: SummaryOptions,
): string | undefined {
    const id = text(kind);
    if (!id) return undefined;
    let label: string | undefined;
    try {
        label = text(options.kindLabel?.(id));
    } catch {
        label = undefined;
    }
    return label ?? CUSTOM_KINDS[id] ?? tidyKind(id, prefix);
}

// The card's words: "Not Within" when the hider is near none of them, and
// "Location" for a place without a name.
function tentacleChoice(data: Fields): string {
    const location = data.location;
    if (location === false) return "Not Within";
    if (!isFields(location)) return "None chosen";
    const name = fieldsOf(location.properties).name;
    return text(name) ?? (typeof name === "number" ? String(name) : "Location");
}

export interface QuestionSummary {
    // What it asks: "2 km", "Nearest Airport". Absent when the type says it.
    subject?: string;
    // Its answer, in the card's words: "Inside", "Colder", "Same".
    answer?: string;
    // Shown alongside, such as "Hidden" for a question turned off.
    notes: string[];
}

function summaryParts(
    question: unknown,
    options: SummaryOptions,
): QuestionSummary {
    const data = dataOf(question);
    const notes = data.enabled === false ? ["Hidden"] : [];
    switch (typeId(question)) {
        case "radius":
            return {
                subject: formatLength(data.radius, data.unit, options),
                answer:
                    typeof data.within === "boolean"
                        ? data.within
                            ? "Inside"
                            : "Outside"
                        : undefined,
                notes,
            };
        case "thermometer":
            return {
                answer:
                    typeof data.warmer === "boolean"
                        ? data.warmer
                            ? "Warmer"
                            : "Colder"
                        : undefined,
                notes,
            };
        case "tentacles": {
            const kind = kindLabel(data.locationType, "tentacle-", options)
                // The game calls them "Tentacles: Museums"; the type says that.
                ?.replace(/^tentacles?\b:?\s*/i, "");
            const radius = formatLength(data.radius, data.unit, options);
            return {
                subject: [kind, radius].filter(Boolean).join(" ") || undefined,
                answer: tentacleChoice(data),
                notes,
            };
        }
        case "matching":
            return {
                subject: kindLabel(data.type, "matching-", options),
                answer:
                    typeof data.same === "boolean"
                        ? data.same
                            ? "Same"
                            : "Different"
                        : undefined,
                notes,
            };
        case "measuring":
            return {
                subject: kindLabel(data.type, "measuring-", options),
                answer:
                    typeof data.hiderCloser === "boolean"
                        ? data.hiderCloser
                            ? "Hider Closer"
                            : "Hider Further"
                        : undefined,
                notes,
            };
        case "zone-size":
            return {
                answer: formatMultiplier(validMultiplier(data.multiplier)),
                notes,
            };
        default:
            return { notes };
    }
}

/** A question's summary in parts, for showing its answer apart. */
export function questionSummaryParts(
    question: unknown,
    options: SummaryOptions = {},
): QuestionSummary {
    try {
        return summaryParts(question, options);
    } catch {
        return { notes: [] };
    }
}

/**
 * "2 km, Inside", "Colder", "Museums 1 km: Library", "Nearest Airport:
 * Same", "×1.5". The type label when nothing else can be read.
 */
export function summarizeQuestion(
    question: unknown,
    options: SummaryOptions = {},
): string {
    const { subject, answer, notes } = questionSummaryParts(question, options);
    const type = typeId(question);
    const joiner = type === "radius" ? ", " : ": ";
    const main =
        subject && answer
            ? `${subject}${joiner}${answer}`
            : (subject ?? answer ?? questionTypeLabel(question));
    return [main, ...notes].join(", ");
}

// ── What differs between two versions ───────────────────────────────────────

// Great-circle distance in meters; enough to say how far a pin moved.
function metersBetween(
    lat1: number,
    lng1: number,
    lat2: number,
    lng2: number,
): number {
    const rad = Math.PI / 180;
    const dLat = (lat2 - lat1) * rad;
    const dLng = (lng2 - lng1) * rad;
    const h =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * 6_371_008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Numbers within rounding, and objects whatever their field order, as the
// merge compares them.
const same = (a: unknown, b: unknown): boolean => sameQuestion(a, b);

// Which fields say what. Device fields (folded, locked) and the key aren't
// part of what a question asks, so they're never a difference.
const IGNORED = new Set(["collapsed", "drag"]);
const PIN_FIELDS: [string, string, string][] = [
    ["lat", "lng", "pin"],
    ["latA", "lngA", "start"],
    ["latB", "lngB", "end"],
];
const FIELD_NAMES: Record<string, string> = {
    radius: "radius",
    unit: "radius",
    within: "answer",
    warmer: "answer",
    same: "answer",
    hiderCloser: "answer",
    location: "answer",
    multiplier: "size",
    name: "name",
    enabled: "shown or hidden",
    color: "color",
    colorA: "color",
    colorB: "color",
    locationType: "kind",
    type: "kind",
    featureName: "kind",
    places: "places",
    geo: "area",
};

function moved(
    a: Fields,
    b: Fields,
    lat: string,
    lng: string,
    unit: DistanceUnit,
): string | null | undefined {
    if (same(a[lat], b[lat]) && same(a[lng], b[lng])) return undefined;
    const [aLat, aLng, bLat, bLng] = [a[lat], a[lng], b[lat], b[lng]].map(
        finite,
    );
    if (
        aLat === undefined ||
        aLng === undefined ||
        bLat === undefined ||
        bLng === undefined
    )
        return null;
    return formatDistance(metersBetween(aLat, aLng, bLat, bLng), unit);
}

/**
 * What differs between two versions of a question, in a few words each:
 * "pin moved 300 m", "answer", "radius". Empty when they ask the same and
 * answer the same.
 */
export function questionDifferences(
    a: unknown,
    b: unknown,
    options: SummaryOptions = {},
): string[] {
    try {
        if (!same(typeId(a), typeId(b))) return ["type"];
        const da = dataOf(a);
        const db = dataOf(b);
        const unit = options.unit ?? "kilometers";
        const out: string[] = [];
        const add = (what: string) => {
            if (!out.includes(what)) out.push(what);
        };
        const handled = new Set<string>(IGNORED);
        for (const [lat, lng, what] of PIN_FIELDS) {
            handled.add(lat).add(lng);
            const distance = moved(da, db, lat, lng, unit);
            if (distance === null) add(`${what} moved`);
            else if (distance !== undefined) add(`${what} moved ${distance}`);
        }
        const fields = new Set([...Object.keys(da), ...Object.keys(db)]);
        for (const field of fields) {
            if (handled.has(field) || same(da[field], db[field])) continue;
            add(FIELD_NAMES[field] ?? "other details");
        }
        // Outside data, anything but the key (such as a field another build
        // adds) still makes them differ.
        const fa = fieldsOf(a);
        const fb = fieldsOf(b);
        for (const field of new Set([...Object.keys(fa), ...Object.keys(fb)])) {
            if (field === "key" || field === "data" || field === "id") continue;
            if (!same(fa[field], fb[field])) add("other details");
        }
        return out;
    } catch {
        return ["other details"];
    }
}

// ── A conflict, in words ─────────────────────────────────────────────────────

export interface ConflictLike {
    key: number;
    mine: unknown;
    theirs: unknown;
}

const keyOf = (question: unknown): number | undefined =>
    finite(fieldsOf(question).key);

/**
 * What to call a conflicting question: the player's name for it when it has
 * one, and its label on the board ("Radius 2"). One the board doesn't hold
 * (deleted on one side) has no place to count from, and the board's own
 * "Radius 2" may well be another question, so it's only "Radius (not on the
 * map)".
 */
export function conflictQuestionLabel(
    board: readonly unknown[],
    conflict: ConflictLike,
): { name?: string; label: string } {
    try {
        const onBoard = board.find((q) => {
            const key = keyOf(q);
            return key !== undefined && sameQuestionKey(key, conflict.key);
        });
        const name =
            questionName(dataOf(onBoard)) ??
            questionName(dataOf(conflict.mine)) ??
            questionName(dataOf(conflict.theirs));
        if (!onBoard) {
            const type = questionTypeLabel(conflict.theirs ?? conflict.mine);
            return { name, label: `${type} (not on the map)` };
        }
        const label =
            typeId(onBoard) && TYPE_LABELS[typeId(onBoard)!]
                ? defaultQuestionLabel(
                      board.filter(isFields) as unknown as Parameters<
                          typeof defaultQuestionLabel
                      >[0],
                      keyOf(onBoard)!,
                  )
                : "";
        return { name, label: label || questionTypeLabel(onBoard) };
    } catch {
        return { label: questionTypeLabel(conflict.theirs ?? conflict.mine) };
    }
}

// Raw values, for two versions whose summaries read the same: a 2 km radius
// and a 2000 m one both read "2 km".
function rawValue(
    field: string,
    data: Fields,
    options: SummaryOptions,
): string | undefined {
    const value = data[field];
    if (field === "name")
        return typeof value === "string" && value.trim()
            ? `name "${value.trim()}"`
            : "no name";
    if (field === "radius" || field === "unit") {
        const n = finite(data.radius);
        const unit = unitOf(data.unit) ?? options.unit;
        if (n === undefined) return undefined;
        return `radius ${n}${unit ? ` ${UNIT_ABBREVIATIONS[unit]}` : ""}`;
    }
    if (field === "enabled") return value === false ? "hidden" : "shown";
    if (
        typeof value === "number" ||
        typeof value === "boolean" ||
        (typeof value === "string" && value.length <= 40)
    )
        return `${FIELD_NAMES[field] ?? field} ${String(value)}`;
    if (value === undefined) return `no ${FIELD_NAMES[field] ?? field}`;
    return undefined;
}

/**
 * For each version, the raw values of the simple fields in which the two
 * differ ("radius 2000 m" against "radius 2 km"), to tell apart versions
 * whose summaries read the same. Pins say how far they moved in
 * questionDifferences instead; areas and places have no short form.
 */
export function rawDifferences(
    a: unknown,
    b: unknown,
    options: SummaryOptions = {},
): { a: string[]; b: string[] } {
    const out = { a: [] as string[], b: [] as string[] };
    try {
        const da = dataOf(a);
        const db = dataOf(b);
        const skip = new Set<string>(IGNORED);
        for (const [lat, lng] of PIN_FIELDS) skip.add(lat).add(lng);
        const fields = new Set([...Object.keys(da), ...Object.keys(db)]);
        for (const field of fields) {
            if (skip.has(field) || same(da[field], db[field])) continue;
            const ra = rawValue(field, da, options);
            const rb = rawValue(field, db, options);
            if (ra === undefined || rb === undefined || ra === rb) continue;
            if (!out.a.includes(ra)) out.a.push(ra);
            if (!out.b.includes(rb)) out.b.push(rb);
        }
    } catch {
        return { a: [], b: [] };
    }
    return out;
}

export interface AuthorLike {
    displayName?: unknown;
    self?: unknown;
}

/** Who made their version: "Alex", "you on another device", "another player". */
export function conflictAuthorName(
    author: AuthorLike | null | undefined,
): string {
    if (!author) return "another player";
    if (author.self === true) return "you on another device";
    return text(author.displayName) ?? "another player";
}

/** The same, starting a line or heading a column. */
export const capitalized = (words: string): string =>
    words ? words[0].toUpperCase() + words.slice(1) : words;

/** "you edited it · Alex deleted it"; undefined when both edited it. */
export function conflictDeletionLine(
    kind: string,
    author: AuthorLike | null | undefined,
): string | undefined {
    const them = conflictAuthorName(author);
    if (kind === "they-deleted") return `you edited it · ${them} deleted it`;
    if (kind === "we-deleted") return `you deleted it · ${them} edited it`;
    return undefined;
}

/** The chip's text: "1 question needs a decision". */
export const conflictCountText = (count: number): string =>
    count === 1
        ? "1 question needs a decision"
        : `${count} questions need a decision`;
