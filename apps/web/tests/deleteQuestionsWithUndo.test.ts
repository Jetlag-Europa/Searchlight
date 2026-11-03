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
import { noteQuestionListSent } from "@/lib/eventQueue";
import { isOnBoard } from "@/lib/questionHistory";
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

    test("puts a copy back once a list made since may have landed", () => {
        board(q(1, "a"), q(2, "b"), q(3, "c"));
        const pending = deleteQuestionsWithUndo([2])!;
        sendList(pending.deletedAt);
        const undone = undoQuestionDeletion(pending, () => 0.5)!;
        expect(undone.placed).toEqual([{ from: 2, key: 0.5 }]);
        expect(keys()).toEqual([1, 0.5, 3]);
        expect(labels()).toEqual(["a", "b", "c"]);
        // History's line for the delete knows it's back.
        expect(isOnBoard({ key: 2 }, questions.get())).toBe(true);
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
        // Their copy arrives, folded on their side.
        board(q(1, "a"), q(0.7, "b", { collapsed: true }));
        lastToast().undo!();
        expect(keys()).toEqual([1, 0.7]);
        expect(lastToast().text).toBe("Already on the board");
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
        showRestoredToast([{ label: "Radius 2", key: 0.5 }]);
        const { text, undo } = lastToast();
        expect(text).toBe("Radius 2 is back");
        const shown = toasts.length;
        undo!();
        expect(keys()).toEqual([1, 3]);
        // No delete toast of its own.
        expect(toasts).toHaveLength(shown);
        showRestoredToast([
            { label: "Radius 1", key: 1 },
            { label: "Radius 2", key: 3 },
            { label: "Radius 3", key: 9 },
        ]);
        expect(lastToast().text).toBe("3 questions are back");
    });
});
