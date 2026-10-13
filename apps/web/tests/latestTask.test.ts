import { describe, expect, it } from "vitest";
import { createLatestTask } from "../src/lib/latestTask";

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

describe("latest map refresh scheduling", () => {
    it("starts the latest update without waiting for obsolete IO and never publishes stale work", async () => {
        const queue = createLatestTask();
        const started = deferred();
        const release = deferred();
        const executed: string[] = [];
        const published: string[] = [];
        const completion = queue.request(async (isCurrent) => {
            executed.push("old");
            started.resolve();
            await release.promise;
            if (isCurrent()) published.push("old");
        });
        await started.promise;
        queue.request(async () => {
            executed.push("intermediate");
        });
        queue.request(async (isCurrent) => {
            executed.push("latest");
            if (isCurrent()) published.push("latest");
        });
        await completion;
        expect(executed).toEqual(["old", "latest"]);
        expect(published).toEqual(["latest"]);
        release.resolve();
        await Promise.resolve();
        expect(published).toEqual(["latest"]);
    });

    it("cancels pending and active publication on unmount and permits a new setup", async () => {
        const queue = createLatestTask();
        const started = deferred();
        const release = deferred();
        const published: string[] = [];
        const completion = queue.request(async (isCurrent) => {
            started.resolve();
            await release.promise;
            if (isCurrent()) published.push("unmounted");
        });
        await started.promise;
        queue.request(async () => {
            published.push("pending");
        });
        queue.cancel();
        release.resolve();
        await completion;
        expect(published).toEqual([]);
        await queue.request(async (isCurrent) => {
            if (isCurrent()) published.push("remounted");
        });
        expect(published).toEqual(["remounted"]);
    });
});
