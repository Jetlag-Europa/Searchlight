import { describe, expect, it } from "vitest";

import { createJobQueue, type WorkerJob } from "@/maps/geo-utils/workerQueue";

type Job = WorkerJob<string>;

function harness() {
    const log: string[] = [];
    // Messages "posted" while the worker is busy, delivered when it yields.
    const inbox: Job[] = [];
    let enqueue!: (job: Job) => void;
    const done = new Promise<void>((resolve) => {
        enqueue = createJobQueue<string>({
            run: async ({ request }) => {
                log.push(`run ${request}`);
                if (request === "last") resolve();
            },
            skip: ({ request }) => log.push(`skip ${request}`),
            receivePending: async () => {
                while (inbox.length) enqueue(inbox.shift()!);
            },
        });
    });
    return { log, inbox, enqueue: (job: Job) => enqueue(job), done };
}

describe("geometry worker queue", () => {
    it("skips a waiting request once a newer one for the same question arrives", async () => {
        const { log, inbox, enqueue, done } = harness();
        enqueue({ id: 1, request: "clip" });
        enqueue({ id: 2, request: "q1 at A", supersede: "question:1" });
        enqueue({ id: 3, request: "q2 at A", supersede: "question:2" });
        inbox.push(
            { id: 4, request: "q1 at B", supersede: "question:1" },
            { id: 5, request: "q1 at C", supersede: "question:1" },
            { id: 6, request: "last" },
        );
        await done;
        expect(log).toEqual([
            "run clip",
            "skip q1 at A",
            "run q2 at A",
            "skip q1 at B",
            "run q1 at C",
            "run last",
        ]);
    });

    it("keeps serving the queue after a job fails", async () => {
        const log: string[] = [];
        let finish!: () => void;
        const done = new Promise<void>((resolve) => (finish = resolve));
        const enqueue = createJobQueue<string>({
            run: async ({ request }) => {
                log.push(request);
                if (request === "bad") throw new Error("boom");
                finish();
            },
            skip: () => {},
            receivePending: async () => {},
        });
        enqueue({ id: 1, request: "bad" });
        enqueue({ id: 2, request: "good" });
        await done;
        expect(log).toEqual(["bad", "good"]);
    });
});
