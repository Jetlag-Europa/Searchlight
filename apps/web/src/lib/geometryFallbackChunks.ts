// Used by the build only (astro.config.mjs): which chunks the service worker
// leaves out of its precache. Keep this module free of imports.

/** The fields used here of a Rolldown output chunk. */
export interface OutputChunk {
    fileName: string;
    isEntry: boolean;
    imports: string[];
    dynamicImports: string[];
    moduleIds: string[];
}

const hasModule = (chunk: OutputChunk, module: string) =>
    chunk.moduleIds.some((id) => id.replaceAll("\\", "/").endsWith(module));

/**
 * The chunks only `fallback` needs: those reachable from the chunks holding
 * it but not from any entry without passing through them. Throws if a page
 * could need one of them without `loader` loading `fallback` first (an entry
 * holding it, a chunk importing one of them statically, or a dynamic import
 * of one from anywhere else): leaving those out of the precache would break
 * that page offline, unnoticed. Rolldown may well merge `fallback` into a
 * chunk the pages share, or a page start importing it.
 */
export function geometryFallbackChunks(
    chunks: Iterable<OutputChunk>,
    fallback: string,
    loader: string,
): Set<string> {
    const byName = new Map<string, OutputChunk>();
    for (const chunk of chunks) byName.set(chunk.fileName, chunk);
    const own = new Set(
        [...byName.values()]
            .filter((chunk) => hasModule(chunk, fallback))
            .map((chunk) => chunk.fileName),
    );
    if (own.size === 0) return new Set();

    const reachable = (start: Iterable<string>, blocked: Set<string>) => {
        const seen = new Set<string>();
        const todo = [...start];
        while (todo.length > 0) {
            const name = todo.pop() as string;
            if (seen.has(name) || blocked.has(name)) continue;
            seen.add(name);
            const chunk = byName.get(name);
            if (chunk) todo.push(...chunk.imports, ...chunk.dynamicImports);
        }
        return seen;
    };
    const entries = [...byName.values()]
        .filter((chunk) => chunk.isEntry)
        .map((chunk) => chunk.fileName);
    const pages = reachable(entries, own);

    const problems: string[] = [];
    for (const name of own) {
        if (byName.get(name)?.isEntry) problems.push(`${name} is an entry`);
    }
    for (const name of pages) {
        const chunk = byName.get(name);
        if (!chunk) continue;
        for (const target of chunk.imports.filter((i) => own.has(i)))
            problems.push(`${name} imports ${target} statically`);
        if (hasModule(chunk, loader)) continue;
        for (const target of chunk.dynamicImports.filter((i) => own.has(i)))
            problems.push(`${name} imports ${target}, not through ${loader}`);
    }
    if (problems.length > 0) {
        const shown = problems.slice(0, 5).join("; ");
        const more =
            problems.length > 5 ? ` (and ${problems.length - 5} more)` : "";
        throw new Error(
            `Pages may need the chunks holding ${fallback}, which the precache leaves out: ${shown}${more}. ` +
                `Load it only through the dynamic import in ${loader}, or update the precache in astro.config.mjs.`,
        );
    }

    const only = new Set<string>();
    for (const name of reachable(own, new Set())) {
        if (!pages.has(name)) only.add(name);
    }
    return only;
}
