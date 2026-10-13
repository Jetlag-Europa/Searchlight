/** A request as the geometry worker receives it. */
export interface WorkerJob<R> {
    id: number;
    request: R;
    /** A later job with the same key makes this one obsolete. */
    supersede?: string;
}

/**
 * Runs the geometry worker's jobs one at a time, in the order they arrive.
 * Before a job that can be superseded starts, messages already sent are let
 * in, and the job is skipped when a newer one with the same key is waiting:
 * a seeker dragged several times then waits for one buffer, not every one.
 */
export function createJobQueue<R>({
    run,
    skip,
    receivePending,
}: {
    run: (job: WorkerJob<R>) => Promise<void>;
    skip: (job: WorkerJob<R>) => void;
    /** Resolves once messages already posted to the worker have arrived. */
    receivePending: () => Promise<void>;
}): (job: WorkerJob<R>) => void {
    const queue: WorkerJob<R>[] = [];
    let draining = false;
    const drain = async () => {
        draining = true;
        try {
            while (queue.length) {
                if (queue[0].supersede !== undefined) await receivePending();
                const job = queue.shift()!;
                if (
                    job.supersede !== undefined &&
                    queue.some((later) => later.supersede === job.supersede)
                ) {
                    skip(job);
                    continue;
                }
                try {
                    await run(job);
                } catch {
                    // run reports its own errors; keep serving the queue.
                }
            }
        } finally {
            draining = false;
        }
    };
    return (job) => {
        queue.push(job);
        if (!draining) void drain();
    };
}
