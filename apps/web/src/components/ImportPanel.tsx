import { useStore } from "@nanostores/react";
import {
    type GameDefinition,
    type GameImportResponse,
    resolveGameDefinitionId,
} from "@searchlight/shared";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { importGameDefinitionAPI } from "@/game-definition/api";
import { verifiedUserId } from "@/lib/activeSession";

const API_BASE = import.meta.env.PUBLIC_API_BASE as string;

type ServerOption = { id: string; name: string; permissions?: string[] };

// The import API accepts any of these (games.create for new games,
// games.edit for updates, server.admin for both).
const IMPORT_PERMISSIONS = ["games.create", "games.edit", "server.admin"];
const canImportTo = (server: ServerOption) =>
    !server.permissions ||
    server.permissions.some((p) => IMPORT_PERMISSIONS.includes(p));

/** The server the games page sent the user here for, if any. */
const requestedServer = () =>
    new URLSearchParams(window.location.search).get("server");

/**
 * The import step of the import page: where the game goes, whether it may
 * replace an existing one, and the import itself. `definition` is the file
 * as it will be sent, after any fixes made on the page.
 */
export function ImportPanel({
    definition,
    noServer,
}: {
    definition: GameDefinition;
    /** The file names no server, so one must be picked here. */
    noServer: boolean;
}) {
    const userId = useStore(verifiedUserId);
    const [servers, setServers] = useState<ServerOption[] | null>(null);
    const [serverId, setServerId] = useState<string>(
        () => requestedServer() ?? (noServer ? "" : definition.serverId) ?? "",
    );
    const [allowUpdate, setAllowUpdate] = useState(true);
    const [unlisted, setUnlisted] = useState(false);
    const [dryRun, setDryRun] = useState<GameImportResponse | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [importing, setImporting] = useState(false);
    const [imported, setImported] = useState<GameImportResponse | null>(null);
    const latestDryRun = useRef(0);

    // Load once AuthGuard has verified the login.
    useEffect(() => {
        if (!userId) return;
        fetch(`${API_BASE}/servers`, { credentials: "include" })
            .then((r) => (r.ok ? r.json() : null))
            .then((data) => {
                const importable = (
                    (data?.servers ?? []) as ServerOption[]
                ).filter(canImportTo);
                setServers(importable);
                setServerId((current) => current || importable[0]?.id || "");
            })
            .catch(() => setServers([]));
    }, [userId]);

    const toSend = { ...definition, serverId };

    // What importing would do, redone whenever the file or options change.
    useEffect(() => {
        setImported(null);
        if (!serverId) return;
        const run = ++latestDryRun.current;
        setDryRun(null);
        importGameDefinitionAPI(toSend, true, allowUpdate)
            .then((result) => {
                if (run !== latestDryRun.current) return;
                setDryRun(result);
                setError(null);
            })
            .catch((err: Error) => {
                if (run === latestDryRun.current) setError(err.message);
            });
        // toSend changes with definition and serverId.
    }, [definition, serverId, allowUpdate]);

    const handleImport = async () => {
        setImporting(true);
        setError(null);
        try {
            setImported(
                await importGameDefinitionAPI(
                    toSend,
                    false,
                    allowUpdate,
                    unlisted,
                ),
            );
        } catch (err: any) {
            setError(err.message || "Import failed");
        } finally {
            setImporting(false);
        }
    };

    const gameId = resolveGameDefinitionId(definition);
    // The file's server may not be one the user can import to; show it
    // anyway so the selector matches where the import is sent.
    const unknownServer =
        servers && serverId && !servers.some((s) => s.id === serverId)
            ? serverId
            : null;

    return (
        <section className="space-y-3 rounded-lg border border-border p-3 text-sm">
            <div className="flex items-center justify-between gap-2">
                <h2 className="text-base font-semibold">Import</h2>
                {dryRun && !imported && (
                    <span
                        className={`rounded px-2 py-0.5 text-xs font-semibold uppercase ${
                            dryRun.status === "created"
                                ? "bg-emerald-500/20 text-emerald-600 dark:text-emerald-400"
                                : dryRun.status === "updated"
                                  ? "bg-blue-500/20 text-blue-600 dark:text-blue-400"
                                  : "bg-slate-500/20 text-slate-600 dark:text-slate-400"
                        }`}
                    >
                        {dryRun.status === "created"
                            ? "New game"
                            : dryRun.status === "updated"
                              ? `Update (rev ${dryRun.revision})`
                              : "Identical"}
                    </span>
                )}
            </div>

            {servers === null ? (
                <p className="text-xs text-muted-foreground">
                    Loading your servers…
                </p>
            ) : servers.length === 0 && !unknownServer ? (
                <p className="text-xs text-destructive">
                    You can&apos;t import games to any server.
                </p>
            ) : (
                <div>
                    <label
                        htmlFor="import-server"
                        className="mb-1 block text-xs font-medium text-muted-foreground"
                    >
                        Server
                    </label>
                    <select
                        id="import-server"
                        className="w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-sm"
                        value={serverId}
                        onChange={(e) => setServerId(e.target.value)}
                    >
                        {unknownServer && (
                            <option value={unknownServer}>
                                {unknownServer} (from file)
                            </option>
                        )}
                        {servers.map((s) => (
                            <option key={s.id} value={s.id}>
                                {s.name} (
                                {s.id === "home-games" ? "Virtual" : s.id})
                            </option>
                        ))}
                    </select>
                    {unknownServer && (
                        <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                            Not one of the servers you can import to. The import
                            will be refused unless you have game permissions
                            there.
                        </p>
                    )}
                </div>
            )}

            <label className="flex cursor-pointer items-start gap-2 text-xs">
                <input
                    type="checkbox"
                    checked={allowUpdate}
                    onChange={(e) => setAllowUpdate(e.target.checked)}
                    className="mt-0.5 h-4 w-4 rounded border-input"
                />
                <span>
                    Allow updating if a game with ID <code>{gameId}</code>{" "}
                    already exists
                </span>
            </label>

            {/* Listing applies to new games; existing ones change it on the games page */}
            {dryRun?.status === "created" && (
                <label className="flex cursor-pointer items-start gap-2 text-xs">
                    <input
                        type="checkbox"
                        checked={unlisted}
                        onChange={(e) => setUnlisted(e.target.checked)}
                        className="mt-0.5 h-4 w-4 rounded border-input"
                    />
                    <span>
                        <span className="font-medium">Unlisted</span>
                        <span className="block text-muted-foreground">
                            Not offered when creating a session, for anyone.
                            Sessions start from game links; it stays on the
                            games page.
                        </span>
                    </span>
                </label>
            )}

            {error && (
                <p className="rounded-md border border-destructive/50 bg-destructive/10 p-2 text-xs text-destructive">
                    {error}
                </p>
            )}

            {imported ? (
                <p className="rounded-md border border-emerald-500/50 bg-emerald-500/10 p-2 text-xs text-emerald-700 dark:text-emerald-300">
                    {imported.status === "unchanged"
                        ? "Already up to date."
                        : `Imported as revision ${imported.revision}.`}{" "}
                    <a href="/games" className="underline">
                        Back to the games page
                    </a>
                </p>
            ) : (
                <Button
                    className="w-full"
                    onClick={handleImport}
                    disabled={!serverId || !dryRun || importing}
                >
                    {importing
                        ? "Importing…"
                        : dryRun?.status === "updated"
                          ? "Update game"
                          : "Import game"}
                </Button>
            )}
        </section>
    );
}
