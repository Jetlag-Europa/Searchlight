import { useStore } from "@nanostores/react";
import {
    CASUAL_SERVER_ID,
    type GameDefinition,
    type GameImportResponse,
    resolveGameDefinitionId,
} from "@searchlight/shared";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { importGameDefinitionAPI } from "@/game-definition/api";
import { verifiedUserId } from "@/lib/activeSession";

const API_BASE = import.meta.env.PUBLIC_API_BASE as string;

// Import errors meaning the preview is out of date: the game was created,
// changed or deleted since, so the preview is redone.
const STALE_PREVIEW_CODES = [
    "GAME_EXISTS",
    "GAME_ID_TAKEN",
    "GAME_DELETED",
    "REVISION_CHANGED",
];

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
 * The import step of the import page: where the game goes, confirming it
 * replaces an existing one, and the import itself. `definition` is the file
 * as it will be sent, after any fixes made on the page.
 */
export function ImportPanel({
    definition,
    noServer,
    busy,
    blocked,
}: {
    definition: GameDefinition;
    /** The file names no server, so one must be picked here. */
    noServer: boolean;
    /**
     * The page is still checking a changed file, or the layers marked
     * noOverlaps.
     */
    busy: boolean;
    /** Why the file can't be imported as it is, if it can't. */
    blocked: string | null;
}) {
    const userId = useStore(verifiedUserId);
    const [servers, setServers] = useState<ServerOption[] | null>(null);
    // The file's own server comes first, as it did in the import dialog,
    // then the one the games page sent the user here for.
    const [serverId, setServerId] = useState<string>(
        () =>
            (noServer ? null : definition.serverId) ?? requestedServer() ?? "",
    );
    const [unlisted, setUnlisted] = useState(false);
    const [dryRun, setDryRun] = useState<GameImportResponse | null>(null);
    const [previewing, setPreviewing] = useState(false);
    // The preview's error code, e.g. GAME_ID_TAKEN when the file's id is
    // another game's that the user can't edit.
    const [previewCode, setPreviewCode] = useState<string | null>(null);
    // Replacing a game the file looks unrelated to needs a second yes.
    const [confirmReplace, setConfirmReplace] = useState(false);
    // The preview's error, and the import's. The import's stays while the
    // preview it outdated is redone, until the file or server changes.
    const [error, setError] = useState<string | null>(null);
    const [importError, setImportError] = useState<string | null>(null);
    const [importing, setImporting] = useState(false);
    const [imported, setImported] = useState<GameImportResponse | null>(null);
    // Bumped to redo the preview for the same file and server.
    const [previewRefresh, setPreviewRefresh] = useState(0);
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

    useEffect(() => setImportError(null), [definition, serverId]);

    // What importing would do, redone whenever the file or server change.
    // It may update, so an existing game is reported rather than refused.
    useEffect(() => {
        setImported(null);
        setConfirmReplace(false);
        if (!serverId) return;
        const run = ++latestDryRun.current;
        setDryRun(null);
        setPreviewing(true);
        importGameDefinitionAPI(toSend, true, true)
            .then((result) => {
                if (run !== latestDryRun.current) return;
                setDryRun(result);
                setConfirmReplace(false);
                setPreviewCode(null);
                setError(null);
            })
            .catch((err: Error & { code?: string }) => {
                if (run !== latestDryRun.current) return;
                setError(err.message);
                setPreviewCode(err.code ?? null);
            })
            .finally(() => {
                if (run === latestDryRun.current) setPreviewing(false);
            });
        // toSend changes with definition and serverId.
    }, [definition, serverId, previewRefresh]);

    const casual = serverId === CASUAL_SERVER_ID;
    const updating = dryRun?.status === "updated";
    const existing = updating ? dryRun.existing : undefined;
    const needsConfirm = !!existing?.likelyMistake && !confirmReplace;

    const handleImport = async () => {
        // A result for a file or server that has changed since is dropped.
        const run = latestDryRun.current;
        setImporting(true);
        setError(null);
        setImportError(null);
        try {
            // Updates only the game the preview showed, at the revision it
            // showed. Without a preview, an existing game is refused rather
            // than replaced.
            const result = await importGameDefinitionAPI(
                toSend,
                false,
                updating,
                unlisted && !casual,
                existing?.revision,
            );
            if (run === latestDryRun.current) setImported(result);
        } catch (err: any) {
            if (run !== latestDryRun.current) return;
            setImportError(err.message || "Import failed");
            if (STALE_PREVIEW_CODES.includes(err.code)) {
                setPreviewCode(err.code);
                setPreviewRefresh((n) => n + 1);
            }
        } finally {
            setImporting(false);
        }
    };

    // The redone preview may report the import's error again.
    const errors = [...new Set([importError, error])].filter(
        (e): e is string => !!e,
    );

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
                        disabled={importing}
                    >
                        {unknownServer && (
                            <option value={unknownServer}>
                                {unknownServer} (from{" "}
                                {!noServer &&
                                unknownServer === definition.serverId
                                    ? "file"
                                    : "link"}
                                )
                            </option>
                        )}
                        {servers.map((s) => (
                            <option key={s.id} value={s.id}>
                                {/* Casual's note says who sees it */}
                                {s.id === CASUAL_SERVER_ID
                                    ? s.name
                                    : `${s.name} (${s.id})`}
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

            {updating &&
                (existing?.likelyMistake ? (
                    <div className="space-y-2 rounded-md border border-destructive/50 bg-destructive/10 p-2 text-xs text-destructive">
                        <p>
                            <span className="font-semibold">
                                This file may be a different game.
                            </span>{" "}
                            ID <code>{gameId}</code> already belongs to{" "}
                            <span className="font-medium">{existing.name}</span>{" "}
                            (revision {existing.revision}).
                        </p>
                        {existing.differences.length > 0 && (
                            <ul className="list-disc pl-4">
                                {existing.differences.map((d) => (
                                    <li key={d}>{d}</li>
                                ))}
                            </ul>
                        )}
                        <p>
                            If this is a new game, change <code>id</code> in the
                            file. Importing replaces {existing.name} as revision{" "}
                            {dryRun.revision}; running sessions keep their
                            revision.
                        </p>
                        <label className="flex cursor-pointer items-start gap-2 font-medium">
                            <input
                                type="checkbox"
                                checked={confirmReplace}
                                onChange={(e) =>
                                    setConfirmReplace(e.target.checked)
                                }
                                className="mt-0.5 h-4 w-4 rounded border-input"
                            />
                            <span>Replace {existing.name} anyway</span>
                        </label>
                    </div>
                ) : (
                    <p className="rounded-md border border-amber-500/50 bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-300">
                        A game with ID <code>{gameId}</code> already exists
                        {existing && (
                            <>
                                :{" "}
                                <span className="font-medium">
                                    {existing.name}
                                </span>
                                , revision {existing.revision}
                            </>
                        )}
                        .
                        {existing?.createdByYou === false &&
                            " Someone else created it."}{" "}
                        Importing replaces it as revision {dryRun.revision};
                        running sessions keep their revision.
                    </p>
                ))}

            {/* Listing applies to new games; existing ones change it on the
                games page. Casual games are always unlisted. */}
            {casual ? (
                <p className="text-xs text-muted-foreground">
                    Only you and global admins see Casual games. Sessions start
                    from a game link you create on the games page.
                </p>
            ) : (
                dryRun?.status === "created" && (
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
                )
            )}

            {errors.map((e) => (
                <p
                    key={e}
                    className="rounded-md border border-destructive/50 bg-destructive/10 p-2 text-xs text-destructive"
                >
                    {e}
                </p>
            ))}

            {blocked && (
                <p className="rounded-md border border-destructive/50 bg-destructive/10 p-2 text-xs text-destructive">
                    {blocked}
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
                    // A failed preview doesn't stop the import: as with the
                    // old dialog, the import reports its own errors. A taken
                    // id would only be refused again.
                    disabled={
                        !serverId ||
                        importing ||
                        busy ||
                        !!blocked ||
                        previewing ||
                        needsConfirm ||
                        previewCode === "GAME_ID_TAKEN"
                    }
                >
                    {importing
                        ? "Importing…"
                        : updating
                          ? "Update game"
                          : "Import game"}
                </Button>
            )}
        </section>
    );
}
