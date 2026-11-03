import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    get length() {
        return store.size;
    },
    key: (i: number) => [...store.keys()][i] ?? null,
});
vi.stubGlobal("window", new EventTarget());
// Lists sent are never answered: these tests read what was queued.
vi.stubGlobal("fetch", () => new Promise(() => {}));

// The toasts: the Undo ones are rendered by hand to read and press them.
type Rendered = {
    props: {
        children: [
            { props: { children: string } },
            { props: { onClick: () => void } },
        ];
    };
};
const toasts: Array<string | ((p: { closeToast: () => void }) => Rendered)> =
    [];
vi.mock("react-toastify", () => ({
    toast: Object.assign(
        (content: (typeof toasts)[number]) => {
            toasts.push(content);
            return `toast-${toasts.length}`;
        },
        { dismiss: () => {} },
    ),
}));

import type { PendingEvent } from "@/lib/eventQueue";
import { activeSessionId, activeSessionRole } from "@/lib/activeSession";
import { questions } from "@/lib/context";
import {
    deleteQuestionsWithUndo,
    showRestoredToast,
    undoQuestionDeletion,
} from "@/lib/deleteQuestionsWithUndo";
import { getPendingEvents, noteQuestionListSent } from "@/lib/eventQueue";
import {
    questionConflicts,
    recordQuestionConflicts,
    setQuestionDecisionsPossible,
} from "@/lib/questionConflicts";
import {
    hasScheduledQuestionSave,
    saveQuestionsDebounced,
} from "@/lib/sessionState";
import type { Questions } from "@/maps/schema";

let sid = 0;
const q = (key: number, label: string, extra: object = {}) => ({
    id: "radius",
    key,
    data: { label, ...extra },
});
const board = (...list: ReturnType<typeof q>[]) =>
    questions.set(list as unknown as Questions);
const labels = () =>
    questions.get().map((x) => (x.data as unknown as { label: string }).label);
const keys = () => questions.get().map((x) => x.key);
// A question list made at `at` is sent: what changed before may land.
const sendList = (at: number) =>
    noteQuestionListSent({
        sessionId: activeSessionId.get(),
        createdAt: at,
    } as PendingEvent);
const lastToast = () => {
    const content = toasts.at(-1)!;
    if (typeof content === "string") return { text: content, undo: null };
    const rendered = content({ closeToast: () => {} });
    return {
        text: rendered.props.children[0].props.children,
        undo: rendered.props.children[1].props.onClick,
    };
};

beforeEach(() => {
    // A session of its own each time: what was sent is per session.
    activeSessionId.set(`undo-${++sid}`);
    activeSessionRole.set("member");
});
afterEach(() => {
    setQuestionDecisionsPossible(false);
    questions.set([]);
    toasts.length = 0;
});

describe("undoing a delete", () => {
    test("puts the same key back while nothing since has been sent", () => {
        board(q(1, "a"), q(2, "b"), q(3, "c"));
        const pending = deleteQuestionsWithUndo([2])!;
        // A list made before the delete went out: it can't hold the delete.
        sendList(pending.deletedAt - 1);
        expect(undoQuestionDeletion(pending)).toEqual({
            placed: [{ from: 2, key: 2 }],
            alreadyBack: 0,
        });
        expect(keys()).toEqual([1, 2, 3]);
    });

    test("puts the undone board in place of the delete's list still waiting", () => {
        board(q(1, "a"), q(2, "b"), q(3, "c"));
        const sessionId = activeSessionId.get();
        // The board's edits are saved (SessionManager says so).
        setQuestionDecisionsPossible(true);
        const pending = deleteQuestionsWithUndo([2])!;
        // As the board's save does once it has redrawn without it.
        saveQuestionsDebounced(sessionId, questions.get());
        undoQuestionDeletion(pending);
        // Not left to send the delete in a moment: queued with it back.
        expect(hasScheduledQuestionSave(sessionId)).toBe(false);
        const queued = getPendingEvents(sessionId).filter(
            (event) => event.type === "questions.replace",
        );
        expect(queued).toHaveLength(1);
        const sent = queued[0].payloadJson as {
            questions: { payloadJson: { key: number } }[];
        };
        expect(sent.questions.map((x) => x.payloadJson.key)).toEqual([1, 2, 3]);
    });

    test("puts a copy back once a list made since may have landed", () => {
        board(q(1, "a"), q(2, "b"), q(3, "c"));
        const pending = deleteQuestionsWithUndo([2])!;
        sendList(pending.deletedAt);
        const undone = undoQuestionDeletion(pending, () => 0.5)!;
        expect(undone.placed).toEqual([{ from: 2, key: 0.5 }]);
        expect(keys()).toEqual([1, 0.5, 3]);
        expect(labels()).toEqual(["a", "b", "c"]);
        // Every History knows it's back: it says what it was restored from.
        expect(questions.get()[1].data).toMatchObject({ restoredFrom: 2 });
    });

    test("puts all of a Delete All back in order, as copies", () => {
        board(q(1, "a"), q(2, "b"), q(3, "c"), q(4, "d"));
        const pending = deleteQuestionsWithUndo([1, 2, 3])!;
        sendList(pending.deletedAt + 5);
        let next = 10;
        undoQuestionDeletion(pending, () => next++);
        expect(labels()).toEqual(["a", "b", "c", "d"]);
        expect(keys()).toEqual([10, 11, 12, 4]);
    });

    test("doesn't add a second copy of one a teammate restored", () => {
        board(q(1, "a"), q(2, "b"));
        const pending = deleteQuestionsWithUndo([2])!;
        sendList(pending.deletedAt);
        // Their copy arrives, edited on their side.
        board(q(1, "a"), q(0.7, "b moved", { restoredFrom: 2 }));
        lastToast().undo!();
        expect(keys()).toEqual([1, 0.7]);
        expect(lastToast().text).toBe("Already on the board");
    });

    test("still puts one back when a question like it was added meanwhile", () => {
        board(q(1, "a"), q(2, "b"));
        const pending = deleteQuestionsWithUndo([2])!;
        sendList(pending.deletedAt);
        // A teammate's new question, not a restore of it.
        board(q(1, "a"), q(0.7, "b"));
        undoQuestionDeletion(pending, () => 0.5);
        expect(keys()).toEqual([1, 0.5, 0.7]);
    });

    test("takes back a delete held for a decision: the teammate's edit stands", () => {
        board(q(1, "a"), q(2, "b"), q(3, "c"));
        const sessionId = activeSessionId.get();
        setQuestionDecisionsPossible(true);
        const pending = deleteQuestionsWithUndo([2])!;
        sendList(pending.deletedAt);
        // The delete met a teammate's edit of it: held, theirs kept on the
        // server, not shown here yet.
        recordQuestionConflicts(
            sessionId,
            [
                {
                    key: 2,
                    kind: "we-deleted",
                    mine: null,
                    theirs: q(2, "b edited") as unknown as Questions[number],
                    base: q(2, "b") as unknown as Questions[number],
                    theirsAfterKey: 1,
                },
            ],
            { baseSequence: 1, theirsSequence: 2 },
        );
        expect(questionConflicts.get()).toHaveLength(1);
        lastToast().undo!();
        // Not a stale copy beside it, nor a decision about a delete taken back.
        expect(labels()).toEqual(["a", "b edited", "c"]);
        expect(keys()).toEqual([1, 2, 3]);
        expect(questionConflicts.get()).toEqual([]);
    });

    test("still puts one back that has a twin which was never deleted", () => {
        board(q(1, "same"), q(2, "same"));
        const pending = deleteQuestionsWithUndo([2])!;
        expect(undoQuestionDeletion(pending)!.placed).toHaveLength(1);
        expect(keys()).toEqual([1, 2]);
    });

    test("names the question in the toast, as its card did", () => {
        board(q(1, "a"), q(2, "b"), q(3, "c", { name: "Airport" }));
        deleteQuestionsWithUndo([2]);
        expect(lastToast().text).toBe("Radius 2 deleted");
        deleteQuestionsWithUndo([3]);
        expect(lastToast().text).toBe("Airport deleted");
        board(q(1, "a"), q(2, "b"));
        deleteQuestionsWithUndo([1, 2]);
        expect(lastToast().text).toBe("2 questions deleted");
    });
});

describe("the toast after Restore", () => {
    test("says what's back, and its Undo takes exactly those copies", () => {
        board(q(1, "a"), q(0.5, "b"), q(3, "c"));
        showRestoredToast([
            { label: "Radius 2", key: 0.5, question: q(0.5, "b") },
        ]);
        const { text, undo } = lastToast();
        expect(text).toBe("Radius 2 is back");
        const shown = toasts.length;
        undo!();
        expect(keys()).toEqual([1, 3]);
        // No delete toast of its own.
        expect(toasts).toHaveLength(shown);
        showRestoredToast([
            { label: "Radius 1", key: 1, question: q(1, "a") },
            { label: "Radius 2", key: 3, question: q(3, "c") },
            { label: "Radius 3", key: 9, question: q(9, "d") },
        ]);
        expect(lastToast().text).toBe("3 questions are back");
    });

    test("its Undo leaves a copy changed since, and says so", () => {
        board(q(1, "a"), q(0.5, "b"), q(0.75, "c"));
        showRestoredToast([
            { label: "Radius 2", key: 0.5, question: q(0.5, "b") },
            { label: "Radius 3", key: 0.75, question: q(0.75, "c") },
        ]);
        const { undo } = lastToast();
        // Moved by a teammate meanwhile; folding doesn't count.
        board(q(1, "a"), q(0.5, "b", { collapsed: true }), q(0.75, "c moved"));
        undo!();
        expect(keys()).toEqual([1, 0.75]);
        expect(lastToast().text).toBe(
            "Radius 2 was changed meanwhile, so it stays",
        );
    });
});
