type Task = (isCurrent: () => boolean) => Promise<void>;

/** Coalesce synchronous updates and let a newer state bypass obsolete awaited IO. */
export function createLatestTask() {
    let generation = 0;
    let pending: { task: Task; generation: number } | undefined;
    let running: Promise<void> | undefined;
    let interrupt: (() => void) | undefined;

    async function drain() {
        try {
            while (pending) {
                const next = pending;
                pending = undefined;
                let wake!: () => void;
                const interrupted = new Promise<void>((resolve) => {
                    wake = resolve;
                });
                interrupt = wake;
                // The obsolete task still finishes its current IO. Its isCurrent
                // guard prevents publication, but it no longer delays the next job.
                const work = Promise.resolve().then(() =>
                    next.task(() => next.generation === generation),
                );
                try {
                    await Promise.race([work, interrupted]);
                } catch (error) {
                    if (next.generation === generation) throw error;
                } finally {
                    if (interrupt === wake) interrupt = undefined;
                }
            }
        } finally {
            running = undefined;
        }
    }

    return {
        request(task: Task): Promise<void> {
            pending = { task, generation: ++generation };
            interrupt?.();
            // A microtask coalesces updates in the same render.
            return (running ??= Promise.resolve().then(drain));
        },
        cancel() {
            generation++;
            pending = undefined;
            interrupt?.();
        },
    };
}
