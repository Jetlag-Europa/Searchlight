import { afterEach, beforeEach, expect, test, vi } from "vitest";

// The History's effects, run by hand: what it asks the server for, and when.
const effects = vi.hoisted(() => [] as (() => unknown)[]);
vi.mock("react", async (importOriginal) => ({
    ...(await importOriginal<typeof import("react")>()),
    useState: (value: unknown) => [
        typeof value === "function" ? (value as () => unknown)() : value,
        () => {},
    ],
    useRef: (value: unknown) => ({ current: value }),
    useCallback: (callback: unknown) => callback,
    useMemo: (make: () => unknown) => make(),
    useEffect: (effect: () => unknown) => void effects.push(effect),
}));
vi.mock("@nanostores/react", () => ({
    useStore: (store: { get: () => unknown }) => store.get(),
}));
vi.mock("@/components/ui/button", () => ({ Button: () => null }));
vi.mock("react-toastify", () => ({
    toast: Object.assign(vi.fn(), { dismiss: vi.fn() }),
}));

import { QuestionHistory } from "@/components/QuestionHistory";
import {
    activeSessionId,
    activeSessionRole,
    verifiedUserId,
} from "@/lib/activeSession";
import { questions } from "@/lib/context";
import { setCachedSession } from "@/lib/eventQueue";
import { setQuestionDecisionsPossible } from "@/lib/questionConflicts";
import { loadedHistory } from "@/lib/questionHistory";
import { saveQuestionsDebounced } from "@/lib/sessionState";
import { questionSchema } from "@/maps/schema";

const SID = "history-refresh";
const store = new Map<string, string>();
let cleanups: unknown[] = [];

beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("localStorage", {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
        key: (i: number) => [...store.keys()][i] ?? null,
        get length() {
            return store.size;
        },
    });
    vi.stubGlobal("window", new EventTarget());
    vi.stubGlobal(
        "document",
        Object.assign(new EventTarget(), { visibilityState: "visible" }),
    );
    vi.stubGlobal("navigator", { onLine: true });
    activeSessionId.set(SID);
    activeSessionRole.set("member");
    verifiedUserId.set("u1");
    setQuestionDecisionsPossible(true);
});

afterEach(() => {
    for (const cleanup of cleanups) {
        if (typeof cleanup === "function") cleanup();
    }
    cleanups = [];
    effects.length = 0;
    setQuestionDecisionsPossible(false);
    activeSessionId.set("");
    verifiedUserId.set(null);
    questions.set([]);
    loadedHistory.set(null);
    store.clear();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

test("refreshes once a slow save of ours is through", async () => {
    const radar = (radius: number) =>
        questionSchema.parse({
            id: "radius",
            key: 0.1,
            data: { lat: 52, lng: 4, radius, color: "blue" },
        });
    const [first, edit] = [radar(2), radar(3)];
    questions.set([first]);
    setCachedSession({
        sessionId: SID,
        userId: "u1",
        questions: [first],
        strokes: [],
        lastSequence: 1,
        lastSyncedAt: Date.now(),
        serverQuestions: { sequence: 1, questions: [first] },
    });
    loadedHistory.set({
        sessionId: SID,
        history: { entries: [], newest: 1, nextBefore: null },
        refreshFailed: false,
    });
    // The save hangs until answered; the History has it once it's in.
    let answer = (_: Response) => {};
    let saved = false;
    const asked: number[] = [];
    vi.stubGlobal(
        "fetch",
        vi.fn((_url: string, init?: RequestInit) => {
            if (init?.method === "PUT") {
                return new Promise<Response>((resolve) => (answer = resolve));
            }
            asked.push(Date.now());
            return Promise.resolve(
                new Response(
                    JSON.stringify({
                        entries: [],
                        newest: saved ? 2 : null,
                        nextBefore: null,
                    }),
                ),
            );
        }),
    );
    QuestionHistory();
    cleanups = effects.map((effect) => effect());
    await vi.advanceTimersByTimeAsync(0);

    questions.set([edit]);
    saveQuestionsDebounced(SID, [edit]);
    // Far slower than the History used to wait for it.
    await vi.advanceTimersByTimeAsync(20_000);
    saved = true;
    const before = asked.length;
    answer(
        new Response(JSON.stringify({ sequence: 2 }), {
            headers: { "Content-Type": "application/json" },
        }),
    );
    await vi.advanceTimersByTimeAsync(5_000);
    expect(asked.length).toBeGreaterThan(before);
    expect(loadedHistory.get()?.history.newest).toBe(2);
});
