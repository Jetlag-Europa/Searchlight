import type { QuestionChange, QuestionHistoryEntry } from "@searchlight/shared";

import { sameQuestion, sameQuestionKey } from "@/lib/questionMerge";
import { questionName } from "@/lib/questionNames";
import {
    PIN_FIELDS,
    pinMoves,
    questionDifferences,
    questionSummaryParts,
    questionTypeLabel,
    summarizeQuestion,
} from "@/lib/questionSummary";
import { SPLIT_ANSWERS } from "@/maps/answerSplit";
import type { Units } from "@/maps/schema";

// A question a line deleted, as needed to put it back.
export interface RemovedQuestion {
    key: number;
    index: number;
    label: string;
    question: unknown;
    /** Keys of the list it was deleted from. */
    order?: number[];
}

export interface HistoryLine {
    /** Stable across refetches: the sequence and position it started at. */
    id: string;
    /** The newest save the line covers, and when it reached the server. */
    sequence: number;
    at: string;
    userId: string;
    /** "You" or the player's name. */
    who: string;
    text: string;
    /** Several questions added or deleted at once, listed under the line. */
    items?: { label: string; removed?: RemovedQuestion }[];
    /** Questions the line deleted, for Restore. */
    removed?: RemovedQuestion[];
    /** Keys of the list before the deletion, where Restore puts them back. */
    order?: number[];
}

export interface HistoryLineOptions {
    /** The player reading it, whose changes say "You". */
    selfId?: string | null;
    unit?: Units;
}

// Typing "2" then "25" into a radius, or nudging a pin, makes one line.
export const COALESCE_WINDOW_MS = 90_000;
// A save adding (or deleting) this many questions, such as a preset, a copied
// session's first save or Delete All, is one line.
const GROUP_AT = 3;

// The field holding each question type's answer: the one its answer toggle
// sets, and the tentacle's chosen place.
const ANSWER_FIELDS: Partial<Record<string, string>> = {
    ...Object.fromEntries(
        Object.entries(SPLIT_ANSWERS).map(([id, answers]) => [
            id,
            Object.keys(answers![0].data)[0],
        ]),
    ),
    tentacles: "location",
};

const PIN_COORDINATES = new Set(PIN_FIELDS.flatMap(([lat, lng]) => [lat, lng]));

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

// Areas and places are left out of the history's changes: both sides read
// { omitted: true }, so whether they changed can't be told from them.
const isOmitted = (value: unknown) => isRecord(value) && value.omitted === true;

// "moved Radius 1 (150 m)", "moved Thermometer 1 (end 111 m)".
const movedPhrase = (
    before: Record<string, unknown>,
    after: Record<string, unknown>,
    id: string,
    unit: Units,
): ((subject: string) => string) => {
    const moves = pinMoves({ id, data: before }, { id, data: after }, { unit })
        .map(({ pin, distance }) =>
            pin === "pin"
                ? (distance ?? "")
                : [pin, distance].filter(Boolean).join(" "),
        )
        .filter(Boolean);
    const how = moves.length > 0 ? ` (${moves.join(", ")})` : "";
    return (subject) => `moved ${subject}${how}`;
};

// What else changed, in the conflict window's words: "radius", "kind", "area".
const otherChanges = (
    fields: readonly string[],
    before: Record<string, unknown>,
    after: Record<string, unknown>,
    id: string,
    unit: Units,
): string[] => {
    const a: Record<string, unknown> = {};
    const b: Record<string, unknown> = {};
    for (const field of fields) {
        a[field] = before[field];
        b[field] = after[field];
        // Listed as changed, yet reads the same: one side blank still names it.
        if (sameQuestion(a[field], b[field])) a[field] = undefined;
    }
    return questionDifferences({ id, data: a }, { id, data: b }, { unit });
};

// What a deleted question asked and its answer, kept short: " (500 m,
// Outside)". Nothing when it would only repeat its type. A number keeps its
// unit on its line: "500" at the end of one and "m" on the next misreads.
const SUMMARY_MAX = 40;
const deletedSummary = (question: unknown, unit: Units): string => {
    const summary = summarizeQuestion(question, { unit }).replace(
        /(\d) (?=\p{L})/gu,
        "$1\u00a0",
    );
    if (!summary || summary === questionTypeLabel(question)) return "";
    const chars = Array.from(summary);
    const short =
        chars.length > SUMMARY_MAX
            ? `${chars
                  .slice(0, SUMMARY_MAX - 1)
                  .join("")
                  .trimEnd()}…`
            : summary;
    return ` (${short})`;
};

const joinParts = (parts: string[]): string =>
    parts.length <= 1
        ? (parts[0] ?? "")
        : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;

const pluralQuestions = (count: number) =>
    count === 1 ? "1 question" : `${count} questions`;

// What a change did, as one phrase per kind of change. The first names the
// question, the rest say "it": "answered Radius 2: Outside and locked it".
export function describeChange(
    change: QuestionChange,
    label: string,
    defaultLabel: string,
    unit: Units = "kilometers",
): string {
    const fields = change.fields ?? [];
    const before = change.before ?? {};
    const after = change.after ?? {};
    const phrases: ((subject: string) => string)[] = [];
    let first = label;

    if (fields.includes("name")) {
        const oldName = questionName(before);
        const newName = questionName(after);
        // A rename says which question it was before.
        first = oldName ?? defaultLabel;
        phrases.push((subject) =>
            newName
                ? `renamed ${subject} to ${newName}`
                : `removed the name ${oldName} from ${defaultLabel}`,
        );
    }
    const answerField = ANSWER_FIELDS[change.id];
    if (answerField && fields.includes(answerField)) {
        // The card's words for it, as the conflict window has them too.
        const word = questionSummaryParts({
            id: change.id,
            data: after,
        }).answer;
        phrases.push((subject) =>
            word
                ? `answered ${subject}: ${word}`
                : `cleared the answer of ${subject}`,
        );
    }
    if (fields.some((field) => PIN_COORDINATES.has(field))) {
        phrases.push(movedPhrase(before, after, change.id, unit));
    }
    const others = otherChanges(
        fields.filter(
            (field) =>
                field !== "name" &&
                field !== answerField &&
                field !== "drag" &&
                field !== "enabled" &&
                !PIN_COORDINATES.has(field),
        ),
        before,
        after,
        change.id,
        unit,
    );
    if (others.length > 0) {
        phrases.push((subject) => `changed ${subject} (${others.join(", ")})`);
    }
    if (fields.includes("drag")) {
        const locked = after.drag === false;
        phrases.push(
            (subject) => `${locked ? "locked" : "unlocked"} ${subject}`,
        );
    }
    // The eye toggle: a question turned off doesn't shape the map.
    if (fields.includes("enabled")) {
        const off = after.enabled === false;
        const state = off ? "off" : "on";
        phrases.push((subject) =>
            subject === "it"
                ? `turned it ${state}`
                : `turned ${state} ${subject}`,
        );
    }
    if (phrases.length === 0) return `changed ${label}`;
    return joinParts(
        phrases.map((phrase, i) => phrase(i === 0 ? first : "it")),
    );
}

// A question's label as its card showed it at the time: its name, or its type
// and place among those of its type ("Radius 2"). Not today's label: after a
// delete, today's "Radius 1" may be another question than the one a line is about.
function labeller() {
    const defaultLabel = (change: QuestionChange) =>
        `${questionTypeLabel({ id: change.id })} ${change.typeIndex}`;
    const label = (change: QuestionChange) => {
        const data = isRecord(change.question)
            ? change.question.data
            : (change.after ?? change.before);
        return (isRecord(data) && questionName(data)) || defaultLabel(change);
    };
    return { label, defaultLabel };
}

const isAnswerChange = (change: QuestionChange) => {
    const field = ANSWER_FIELDS[change.id];
    return field !== undefined && (change.fields ?? []).includes(field);
};

// Several changes to one question in a row, as one: each field from the
// first change that touched it to the last, even where that left it unset,
// and only the fields that end up different.
export function mergeChanges(
    changes: readonly QuestionChange[],
): QuestionChange {
    const touching = (field: string) =>
        changes.filter((c) => (c.fields ?? []).includes(field));
    const fields = [...new Set(changes.flatMap((c) => c.fields ?? []))];
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    for (const field of fields) {
        const touched = touching(field);
        before[field] = touched[0].before?.[field];
        after[field] = touched[touched.length - 1].after?.[field];
    }
    // The name, for the label of a question no longer on the board.
    if (!fields.includes("name")) {
        before.name = changes[0].before?.name;
        after.name = changes[changes.length - 1].after?.name;
    }
    // A moved pin's other coordinate, to measure the move.
    for (const [lat, lng] of PIN_FIELDS) {
        const pair = [lat, lng];
        if (!pair.some((field) => fields.includes(field))) continue;
        for (const field of pair) {
            if (fields.includes(field)) continue;
            const withField = changes.filter(
                (c) => c.before?.[field] !== undefined,
            );
            before[field] = withField[0]?.before?.[field];
            after[field] = withField[withField.length - 1]?.after?.[field];
        }
    }
    return {
        ...changes[changes.length - 1],
        // An area or places can't be compared here, so stay changed.
        fields: fields.filter(
            (field) =>
                isOmitted(after[field]) ||
                !sameQuestion(before[field], after[field]),
        ),
        before,
        after,
    };
}

interface DraftLine extends HistoryLine {
    // The changes a coalescing line spans, oldest first, and when the first
    // was saved: the window counts from there, so steady edits still split.
    changes?: QuestionChange[];
    startedAt?: string;
}

type Labels = ReturnType<typeof labeller>;

// Whether `change`, saved at `at` by `userId`, continues the line: the same
// player, the same question, soon after, and neither an answer.
const continues = (
    line: DraftLine | undefined,
    change: QuestionChange,
    userId: string,
    at: string,
): line is DraftLine & { changes: QuestionChange[] } => {
    const last = line?.changes?.[line.changes.length - 1];
    return (
        !!line &&
        !!last &&
        line.userId === userId &&
        sameQuestionKey(last.key, change.key) &&
        !isAnswerChange(last) &&
        !isAnswerChange(change) &&
        Date.parse(at) - Date.parse(line.startedAt ?? line.at) <=
            COALESCE_WINDOW_MS
    );
};

// The text for the changes a line spans; empty when together they changed nothing.
const describeChanges = (
    changes: readonly QuestionChange[],
    labels: Labels,
    unit: Units,
): string => {
    const change = changes.length === 1 ? changes[0] : mergeChanges(changes);
    if ((change.fields ?? []).length === 0) return "";
    return describeChange(
        change,
        labels.label(change),
        labels.defaultLabel(change),
        unit,
    );
};

// Adds the lines for one save to `lines`, which hold everything older.
function addEntryLines(
    lines: DraftLine[],
    entry: QuestionHistoryEntry,
    who: string,
    labels: Labels,
    unit: Units,
    // Keys of the questions deleted earlier in the history.
    deleted: number[],
) {
    let part = 0;
    const push = (
        line: Pick<
            DraftLine,
            "text" | "items" | "removed" | "order" | "changes" | "startedAt"
        >,
    ) =>
        lines.push({
            id: `${entry.sequence}-${part++}`,
            sequence: entry.sequence,
            at: entry.at,
            userId: entry.userId,
            who,
            ...line,
        });
    // Restore's copy says what it was restored from; Undo may put one back
    // under the key it was deleted with.
    const isRestore = (c: QuestionChange) =>
        c.after?.restoredFrom !== undefined ||
        deleted.some((key) => sameQuestionKey(key, c.key));

    const added = entry.changes.filter((c) => c.kind === "added");
    if (added.length >= GROUP_AT) {
        const restored = added.every(isRestore);
        push({
            text: `${restored ? "restored" : "added"} ${pluralQuestions(added.length)}`,
            items: added.map((c) => ({ label: labels.label(c) })),
        });
    } else {
        for (const c of added) {
            push({
                text: `${isRestore(c) ? "restored" : "added"} ${labels.label(c)}`,
            });
        }
    }

    for (const change of entry.changes) {
        if (change.kind !== "changed") continue;
        const previous = lines[lines.length - 1];
        if (continues(previous, change, entry.userId, entry.at)) {
            previous.changes.push(change);
            previous.sequence = entry.sequence;
            previous.at = entry.at;
            previous.text = describeChanges(previous.changes, labels, unit);
            continue;
        }
        push({
            changes: [change],
            startedAt: entry.at,
            text: describeChanges([change], labels, unit),
        });
    }

    const removedChanges = entry.changes.filter((c) => c.kind === "removed");
    const removed = removedChanges.map(
        (c): RemovedQuestion => ({
            key: c.key,
            index: c.index,
            label: labels.label(c),
            question: c.question,
            order: entry.order,
        }),
    );
    if (removed.length >= GROUP_AT) {
        push({
            text: `deleted ${pluralQuestions(removed.length)}`,
            items: removed.map((q) => ({ label: q.label, removed: q })),
            removed,
            order: entry.order,
        });
    } else {
        removed.forEach((question, i) => {
            const c = removedChanges[i];
            const was = question.question ?? { id: c.id, data: c.before };
            push({
                text: `deleted ${question.label}${deletedSummary(was, unit)}`,
                removed: [question],
                order: entry.order,
            });
        });
    }
    deleted.push(...removedChanges.map((c) => c.key));

    if (entry.reordered) push({ text: "reordered the questions" });
}

/** The history as lines to read, newest first. */
export function historyLines(
    entries: readonly QuestionHistoryEntry[],
    options: HistoryLineOptions,
): HistoryLine[] {
    const labels = labeller();
    const unit = options.unit ?? "kilometers";
    const deleted: number[] = [];
    const lines: DraftLine[] = [];
    for (const entry of [...entries].sort((a, b) => a.sequence - b.sequence)) {
        const who =
            options.selfId && entry.userId === options.selfId
                ? "You"
                : entry.displayName || entry.userId;
        addEntryLines(lines, entry, who, labels, unit, deleted);
    }
    // Newest save first; the lines of one save keep the list's order. Quick
    // edits that undid themselves leave no line.
    return lines
        .filter((line) => line.text)
        .sort((a, b) => b.sequence - a.sequence)
        .map((line) => ({
            id: line.id,
            sequence: line.sequence,
            at: line.at,
            userId: line.userId,
            who: line.who,
            text: line.text,
            ...(line.items && { items: line.items }),
            ...(line.removed && { removed: line.removed }),
            ...(line.order && { order: line.order }),
        }));
}
