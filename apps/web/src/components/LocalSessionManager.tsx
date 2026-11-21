import { useStore } from "@nanostores/react";
import type { GameDefinition, ValidationIssue } from "@searchlight/shared";
import {
    AlertTriangle,
    FileUp,
    FolderOpen,
    Globe,
    HardDrive,
    Pencil,
    Plus,
    RefreshCw,
    Trash2,
    Upload,
} from "lucide-react";
import {
    useCallback,
    useEffect,
    useId,
    useRef,
    useState,
} from "react";
import { toast } from "react-toastify";

import { strokes } from "@/annotations/hooks/useAnnotationStore";
import { OtherTabNotice } from "@/components/OtherTabNotice";
import { StatusChip } from "@/components/StatusChip";
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
    activeSessionId,
    activeSessionRole,
    editingInOtherTab,
    STORED_USER_KEY,
} from "@/lib/activeSession";
import {
    activeLocalSession,
    boardMode,
} from "@/lib/boardMode";
import {
    disabledStations,
    hiderMode,
    planningModeEnabled,
    questions,
    sessionPickerOpen,
    sidebarContextL,
    sidebarContextR,
} from "@/lib/context";
import { applyLocalGameDefinition, clearLocalGame } from "@/lib/games";
import {
    loadLocalGameFromFile,
    loadLocalGameFromLink,
    loadLocalGameFromUrl,
    validateExternalGameUrl,
} from "@/lib/localGameLoader";
import {
    clearLastLocalSessionId,
    createLocalSession,
    deleteLocalGame,
    deleteLocalSession,
    getLocalGameDefinition,
    getLocalSession,
    isLocalStoragePersistent,
    listLocalGames,
    listLocalSessions,
    type LocalGameMeta,
    type LocalGameSource,
    type LocalSessionPatch,
    type LocalSessionRecord,
    type LocalSessionSummary,
    LocalStorageFullError,
    readLastLocalSessionId,
    saveLocalGame,
    updateLocalSession,
    writeLastLocalSessionId,
} from "@/lib/localStore";
import {
    acquireLocalSessionLock,
    releaseLocalSessionLock,
} from "@/lib/localTabLock";
import { readStorage } from "@/lib/safeStorage";

const API_BASE = (import.meta.env.PUBLIC_API_BASE ?? "") as string;
const SAVE_DEBOUNCE_MS = 200;

interface LoadErrorState {
    message: string;
    issues?: ValidationIssue[];
}

interface PendingExternalUrl {
    url: URL;
    sessionName: string;
}

interface PendingLinkLoad {
    token: string;
    sessionName?: string;
}

function formatUpdated(iso: string): string {
    try {
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return "";
        return d.toLocaleDateString(undefined, {
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
        });
    } catch {
        return "";
    }
}

function stripLocalQueryParams(): void {
    if (typeof window === "undefined") return;
    if (window.location.search) {
        window.history.replaceState({}, "", window.location.pathname);
    }
}

function sourceLabel(source: LocalGameSource): string {
    switch (source.kind) {
        case "file":
            return source.label;
        case "url":
            return source.label;
        case "game-link":
            return "Game link";
    }
}

export function LocalSessionManager() {
    const active = useStore(activeLocalSession);
    const [pickerOpen, setPickerOpen] = useState(false);
    const [booting, setBooting] = useState(true);
    const [persistent, setPersistent] = useState(true);

    const [sessions, setSessions] = useState<LocalSessionSummary[]>([]);
    const [games, setGames] = useState<LocalGameMeta[]>([]);
    const [loadingCatalog, setLoadingCatalog] = useState(false);

    const [urlInput, setUrlInput] = useState("");
    const [busyLabel, setBusyLabel] = useState<string | null>(null);
    const [loadError, setLoadError] = useState<LoadErrorState | null>(null);
    const [dragOver, setDragOver] = useState(false);

    // Confirmation prompt for `/local?url=https://...` so external fetches
    // never fire silently on page load.
    const [pendingUrl, setPendingUrl] = useState<PendingExternalUrl | null>(null);

    // Loading state for `/local?link=<token>` coming from `/play`.
    const [pendingLink, setPendingLink] = useState<PendingLinkLoad | null>(null);
    const [linkError, setLinkError] = useState<{
        message: string;
        invalidLink?: boolean;
    } | null>(null);

    // Inline session rename / new-session-from-game / delete confirms
    const [renamingId, setRenamingId] = useState<string | null>(null);
    const [renameDraft, setRenameDraft] = useState("");
    const [newSessionGame, setNewSessionGame] = useState<LocalGameMeta | null>(null);
    const [newSessionName, setNewSessionName] = useState("");
    const [deleteSessionTarget, setDeleteSessionTarget] =
        useState<LocalSessionSummary | null>(null);
    const [deleteGameTarget, setDeleteGameTarget] =
        useState<LocalGameMeta | null>(null);
    const [unsavedError, setUnsavedError] = useState<string | null>(null);

    const fileInputRef = useRef<HTMLInputElement>(null);
    const dialogRef = useRef<HTMLDivElement>(null);
    const titleId = useId();

    // Persistence state refs: pending patches are keyed by sessionId and kept
    // until their IndexedDB write commits so a failed save never discards edits.
    const activeSessionIdRef = useRef<string | null>(null);
    const suppressSaveRef = useRef(true);
    const pendingPatchesRef = useRef(new Map<string, LocalSessionPatch>());
    const inFlightFlushRef = useRef<Promise<Set<string>> | null>(null);
    const saveTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const openGenerationRef = useRef(0);

    // Keep global boardMode pinned to "local" while mounted.
    useEffect(() => {
        boardMode.set("local");
        activeSessionRole.set("creator");
    }, []);

    // Keep sessionPickerOpen & #map-board inert state in sync.
    const overlayOpen =
        pickerOpen || Boolean(pendingUrl) || Boolean(pendingLink) || booting;
    useEffect(() => {
        sessionPickerOpen.set(overlayOpen);
        const board = document.getElementById("map-board");
        if (board) {
            (board as HTMLElement & { inert: boolean }).inert = overlayOpen;
        }
        if (overlayOpen) {
            sidebarContextL.get().setOpenMobile(false);
            sidebarContextR.get().setOpenMobile(false);
        }
        return () => {
            sessionPickerOpen.set(false);
            const el = document.getElementById("map-board");
            if (el) (el as HTMLElement & { inert: boolean }).inert = false;
        };
    }, [overlayOpen]);

    const refreshCatalog = useCallback(async () => {
        setLoadingCatalog(true);
        try {
            const [nextSessions, nextGames] = await Promise.all([
                listLocalSessions(),
                listLocalGames(),
            ]);
            setSessions(nextSessions);
            setGames(nextGames);
        } catch (err) {
            console.warn("[searchlight:local] failed to list local data:", err);
        } finally {
            setLoadingCatalog(false);
        }
    }, []);

    const flushSave = useCallback(async (targetSessionId?: string) => {
        if (saveTimerRef.current !== undefined) {
            clearTimeout(saveTimerRef.current);
            saveTimerRef.current = undefined;
        }

        // Wait for any already in-flight IndexedDB write to settle before
        // draining remaining patches so callers never race an active save.
        while (inFlightFlushRef.current) {
            const prevFailed = await inFlightFlushRef.current;
            const relevantFailure = targetSessionId
                ? prevFailed.has(targetSessionId)
                : prevFailed.size > 0;
            if (relevantFailure) {
                return false;
            }
        }

        const failedIds = new Set<string>();
        const run = (async (): Promise<Set<string>> => {
            // Drain in a loop so edits arriving during an IndexedDB write are
            // also committed before returning, without retrying ids that failed.
            while (true) {
                if (saveTimerRef.current !== undefined && !targetSessionId) {
                    clearTimeout(saveTimerRef.current);
                    saveTimerRef.current = undefined;
                }
                const ids = (
                    targetSessionId
                        ? [targetSessionId]
                        : [...pendingPatchesRef.current.keys()]
                ).filter(
                    (id) =>
                        !failedIds.has(id) &&
                        pendingPatchesRef.current.has(id),
                );
                if (ids.length === 0) break;

                for (const sessionId of ids) {
                    const patch = pendingPatchesRef.current.get(sessionId);
                    if (!patch) continue;
                    // Remove before awaiting so edits made during the write collect in
                    // a fresh patch; on failure we merge `patch` back underneath them.
                    pendingPatchesRef.current.delete(sessionId);
                    try {
                        await updateLocalSession(sessionId, patch);
                    } catch (err) {
                        failedIds.add(sessionId);
                        const newer = pendingPatchesRef.current.get(sessionId);
                        pendingPatchesRef.current.set(sessionId, {
                            ...patch,
                            ...(newer ?? {}),
                        });
                        const message =
                            err instanceof LocalStorageFullError
                                ? err.message
                                : "Couldn't save your latest changes to browser storage.";
                        setUnsavedError(message);
                        toast.error(message, { toastId: "local-save-failed" });
                        console.warn(
                            "[searchlight:local] failed to save session:",
                            err,
                        );
                    }
                }
            }

            if (failedIds.size === 0 && pendingPatchesRef.current.size === 0) {
                setUnsavedError(null);
            }
            return failedIds;
        })();

        inFlightFlushRef.current = run;
        try {
            await run;
        } finally {
            if (inFlightFlushRef.current === run) {
                inFlightFlushRef.current = null;
            }
        }

        const hasRemaining = targetSessionId
            ? pendingPatchesRef.current.has(targetSessionId)
            : pendingPatchesRef.current.size > 0;
        return failedIds.size === 0 && !hasRemaining;
    }, []);

    const scheduleSave = useCallback(
        (patch: LocalSessionPatch) => {
            const sessionId = activeSessionIdRef.current;
            if (
                suppressSaveRef.current ||
                !sessionId ||
                editingInOtherTab.get()
            ) {
                return;
            }
            const existing = pendingPatchesRef.current.get(sessionId);
            pendingPatchesRef.current.set(sessionId, {
                ...(existing ?? {}),
                ...patch,
            });
            if (saveTimerRef.current !== undefined) {
                clearTimeout(saveTimerRef.current);
            }
            saveTimerRef.current = setTimeout(() => {
                saveTimerRef.current = undefined;
                void flushSave(sessionId);
            }, SAVE_DEBOUNCE_MS);
        },
        [flushSave],
    );

    // Subscribe to board state atoms and persist local edits to IndexedDB.
    useEffect(() => {
        const unsubQuestions = questions.listen((value) => {
            scheduleSave({ questions: [...value] });
        });
        const unsubStrokes = strokes.listen((value) => {
            scheduleSave({ strokes: [...value] });
        });
        const unsubDisabled = disabledStations.listen((value) => {
            scheduleSave({ disabledZones: [...value] });
        });
        const unsubHider = hiderMode.listen((value) => {
            scheduleSave({ hiderMode: value });
        });
        const unsubPlanning = planningModeEnabled.listen((value) => {
            scheduleSave({ planningMode: value });
        });

        const handlePageExit = () => {
            void flushSave();
        };
        const handleVisibility = () => {
            if (document.visibilityState === "hidden") void flushSave();
        };

        window.addEventListener("pagehide", handlePageExit);
        window.addEventListener("beforeunload", handlePageExit);
        document.addEventListener("visibilitychange", handleVisibility);

        return () => {
            unsubQuestions();
            unsubStrokes();
            unsubDisabled();
            unsubHider();
            unsubPlanning();
            window.removeEventListener("pagehide", handlePageExit);
            window.removeEventListener("beforeunload", handlePageExit);
            document.removeEventListener("visibilitychange", handleVisibility);
            void flushSave();
            releaseLocalSessionLock();
        };
    }, [scheduleSave, flushSave]);

    const clearActiveBoard = useCallback(() => {
        suppressSaveRef.current = true;
        const previousId = activeSessionIdRef.current;
        if (previousId) pendingPatchesRef.current.delete(previousId);
        activeSessionIdRef.current = null;
        if (saveTimerRef.current !== undefined) {
            clearTimeout(saveTimerRef.current);
            saveTimerRef.current = undefined;
        }
        releaseLocalSessionLock();
        setUnsavedError(null);
        clearLastLocalSessionId();
        activeLocalSession.set(null);
        activeSessionId.set("");
        clearLocalGame();
        questions.set([]);
        strokes.set([]);
        disabledStations.set([]);
        hiderMode.set(false);
        planningModeEnabled.set(false);
        suppressSaveRef.current = false;
    }, []);

    const openSessionRecord = useCallback(
        async (
            sessionOrId: LocalSessionRecord | string,
            preloadedDef?: GameDefinition,
        ) => {
            const gen = ++openGenerationRef.current;
            const saved = await flushSave();
            if (gen !== openGenerationRef.current) return false;
            if (!saved) {
                toast.error(
                    "Couldn't save your current session — stayed here so your edits aren't lost.",
                    { toastId: "local-switch-blocked" },
                );
                return false;
            }

            const targetId =
                typeof sessionOrId === "string" ? sessionOrId : sessionOrId.id;
            // Acquire exclusive edit ownership before reading the session so
            // any tab displaced by this open flushes its pending writes first.
            await acquireLocalSessionLock(targetId, () => {
                void flushSave(targetId);
            });
            if (gen !== openGenerationRef.current) return false;

            const session = await getLocalSession(targetId);
            if (gen !== openGenerationRef.current) return false;
            if (!session) {
                releaseLocalSessionLock();
                toast.error("That local session no longer exists.");
                await refreshCatalog();
                return false;
            }

            const definition =
                preloadedDef ?? (await getLocalGameDefinition(session.gameId));
            if (gen !== openGenerationRef.current) return false;
            if (!definition) {
                releaseLocalSessionLock();
                toast.error(
                    "The game definition for this local session is missing.",
                );
                return false;
            }

            suppressSaveRef.current = true;
            try {
                activeSessionIdRef.current = session.id;
                writeLastLocalSessionId(session.id);
                activeLocalSession.set({
                    id: session.id,
                    name: session.name,
                    gameId: session.gameId,
                    gameName: session.gameName,
                });
                activeSessionId.set(`local:${session.id}`);
                activeSessionRole.set("creator");

                // Apply board state before applying the game definition so
                // `applyGameDefinition` filters questions against the loaded game.
                questions.set(
                    Array.isArray(session.questions) ? session.questions : [],
                );
                strokes.set(
                    Array.isArray(session.strokes) ? session.strokes : [],
                );
                disabledStations.set(
                    Array.isArray(session.disabledZones)
                        ? session.disabledZones
                        : [],
                );
                hiderMode.set(session.hiderMode ?? false);
                planningModeEnabled.set(Boolean(session.planningMode));

                applyLocalGameDefinition(`local:${session.gameId}`, definition);
            } finally {
                suppressSaveRef.current = false;
            }

            setPickerOpen(false);
            setPendingUrl(null);
            setPendingLink(null);
            setLinkError(null);
            setLoadError(null);
            return true;
        },
        [flushSave, refreshCatalog],
    );

    const openSessionById = useCallback(
        async (sessionId: string) => openSessionRecord(sessionId),
        [openSessionRecord],
    );

    const saveGameAndStartSession = useCallback(
        async (
            definition: GameDefinition,
            source: LocalGameSource,
            sessionName?: string,
        ) => {
            const game = await saveLocalGame(definition, source);
            const session = await createLocalSession(game, sessionName);
            await refreshCatalog();
            await openSessionRecord(session, definition);
        },
        [openSessionRecord, refreshCatalog],
    );

    const loadFromGameLink = useCallback(
        async (target: PendingLinkLoad) => {
            setLinkError(null);
            const result = await loadLocalGameFromLink(API_BASE, target.token);
            if (!result.ok) {
                setLinkError({
                    message: result.error,
                    invalidLink: result.invalidLink,
                });
                return;
            }
            try {
                stripLocalQueryParams();
                await saveGameAndStartSession(
                    result.definition,
                    { kind: "game-link", label: result.definition.name },
                    target.sessionName,
                );
                toast.success(`Opened ${result.definition.name} locally`);
            } catch (err) {
                const message =
                    err instanceof Error
                        ? err.message
                        : "Couldn't save the game locally.";
                setLinkError({ message });
            }
        },
        [saveGameAndStartSession],
    );

    // Boot: check persistence, handle ?url= / ?link=, or restore last local session.
    useEffect(() => {
        let cancelled = false;
        (async () => {
            const isPersist = await isLocalStoragePersistent();
            if (!cancelled) setPersistent(isPersist);

            await refreshCatalog();
            if (cancelled) return;

            const params = new URLSearchParams(window.location.search);
            const linkToken = params.get("link")?.trim();
            const rawUrl = params.get("url")?.trim();
            const requestedName = params.get("name")?.trim() || undefined;

            if (linkToken) {
                const target: PendingLinkLoad = {
                    token: linkToken,
                    sessionName: requestedName,
                };
                setPendingLink(target);
                setBooting(false);
                void loadFromGameLink(target);
                return;
            }

            if (rawUrl) {
                const validated = validateExternalGameUrl(rawUrl);
                if (validated.ok) {
                    setPendingUrl({
                        url: validated.url,
                        sessionName: requestedName ?? "",
                    });
                } else {
                    stripLocalQueryParams();
                    setLoadError({ message: validated.error });
                    setPickerOpen(true);
                }
                setBooting(false);
                return;
            }

            const lastId = readLastLocalSessionId();
            if (lastId) {
                const opened = await openSessionRecord(lastId);
                if (!cancelled) {
                    if (!opened) {
                        clearLastLocalSessionId();
                        setPickerOpen(true);
                    }
                    setBooting(false);
                }
                return;
            }

            if (!cancelled) {
                setPickerOpen(true);
                setBooting(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [loadFromGameLink, openSessionRecord, refreshCatalog]);

    // Escape closes picker when a local session is active.
    useEffect(() => {
        if (!pickerOpen || !active) return;
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key !== "Escape" || e.isComposing || e.defaultPrevented) return;
            setPickerOpen(false);
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [pickerOpen, active]);

    // ── Handlers ─────────────────────────────────────────────────────────────

    const handleFile = async (file: File) => {
        setLoadError(null);
        setBusyLabel(`Reading ${file.name}…`);
        try {
            const result = await loadLocalGameFromFile(file);
            if (!result.ok) {
                setLoadError({ message: result.error, issues: result.issues });
                return;
            }
            await saveGameAndStartSession(result.definition, {
                kind: "file",
                label: file.name,
            });
            toast.success(`Loaded ${result.definition.name} locally`);
        } catch (err) {
            setLoadError({
                message:
                    err instanceof Error
                        ? err.message
                        : "Failed to save game locally.",
            });
        } finally {
            setBusyLabel(null);
        }
    };

    const handleLoadFromUrl = async (
        rawUrl: string,
        sessionName?: string,
        fromQueryParam = false,
    ) => {
        setLoadError(null);
        setBusyLabel("Downloading game.json…");
        try {
            const result = await loadLocalGameFromUrl(rawUrl);
            if (!result.ok) {
                setLoadError({ message: result.error, issues: result.issues });
                if (fromQueryParam) {
                    setPendingUrl(null);
                    setPickerOpen(true);
                    stripLocalQueryParams();
                }
                return;
            }
            const parsedUrl = new URL(result.url!);
            if (fromQueryParam) stripLocalQueryParams();
            await saveGameAndStartSession(
                result.definition,
                {
                    kind: "url",
                    label: parsedUrl.hostname,
                    url: parsedUrl.href,
                },
                sessionName,
            );
            setUrlInput("");
            toast.success(`Loaded ${result.definition.name} locally`);
        } catch (err) {
            setLoadError({
                message:
                    err instanceof Error
                        ? err.message
                        : "Failed to save game locally.",
            });
            if (fromQueryParam) {
                setPendingUrl(null);
                setPickerOpen(true);
                stripLocalQueryParams();
            }
        } finally {
            setBusyLabel(null);
        }
    };

    const handleStartFromSavedGame = async (game: LocalGameMeta, name?: string) => {
        setLoadError(null);
        setBusyLabel(`Opening ${game.name}…`);
        try {
            const def = await getLocalGameDefinition(game.id);
            if (!def) {
                setLoadError({
                    message: "This saved game could not be read from browser storage.",
                });
                void refreshCatalog();
                return;
            }
            const session = await createLocalSession(game, name);
            setNewSessionGame(null);
            setNewSessionName("");
            await refreshCatalog();
            await openSessionRecord(session, def);
        } catch (err) {
            setLoadError({
                message:
                    err instanceof Error
                        ? err.message
                        : "Failed to create local session.",
            });
            void refreshCatalog();
        } finally {
            setBusyLabel(null);
        }
    };

    const handleRenameSession = async (sessionId: string) => {
        const trimmed = renameDraft.trim().slice(0, 100);
        setRenamingId(null);
        if (!trimmed) return;
        await updateLocalSession(sessionId, { name: trimmed });
        if (activeLocalSession.get()?.id === sessionId) {
            const cur = activeLocalSession.get()!;
            activeLocalSession.set({ ...cur, name: trimmed });
        }
        await refreshCatalog();
    };

    const handleDeleteSession = async () => {
        if (!deleteSessionTarget) return;
        const target = deleteSessionTarget;
        setDeleteSessionTarget(null);
        pendingPatchesRef.current.delete(target.id);
        if (activeSessionIdRef.current === target.id) {
            clearActiveBoard();
        }
        await deleteLocalSession(target.id);
        if (pendingPatchesRef.current.size > 0) void flushSave();
        await refreshCatalog();
        if (!activeLocalSession.get()) {
            setPickerOpen(true);
        }
    };

    const handleDeleteGame = async () => {
        if (!deleteGameTarget) return;
        const target = deleteGameTarget;
        setDeleteGameTarget(null);
        const deletedSessionIds = await deleteLocalGame(target.id);
        for (const id of deletedSessionIds) {
            pendingPatchesRef.current.delete(id);
        }
        if (
            activeSessionIdRef.current &&
            deletedSessionIds.includes(activeSessionIdRef.current)
        ) {
            clearActiveBoard();
        }
        if (pendingPatchesRef.current.size > 0) void flushSave();
        await refreshCatalog();
        if (!activeLocalSession.get()) {
            setPickerOpen(true);
        }
    };

    const openPicker = async () => {
        await flushSave();
        await refreshCatalog();
        setLoadError(null);
        setPickerOpen(true);
    };

    const sessionsUsingDeleteGame = deleteGameTarget
        ? sessions.filter((s) => s.gameId === deleteGameTarget.id).length
        : 0;
    const hasSignedInAccount = Boolean(
        readStorage("localStorage", STORED_USER_KEY),
    );
    const onlineHref = hasSignedInAccount ? "/map" : "/";
    const onlineLabel = hasSignedInAccount ? "Online sessions" : "Sign in";

    return (
        <>
            <OtherTabNotice />

            {/* Top-right status chips matching /map's slot layout */}
            <StatusChip slot="user">
                <div className="flex w-max items-center gap-2 rounded-full border border-border bg-background/90 px-3 py-1.5 text-xs text-foreground shadow-sm backdrop-blur-sm">
                    <HardDrive className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="font-medium">Local only</span>
                    <span className="text-muted-foreground">·</span>
                    <a
                        href={onlineHref}
                        className="text-primary hover:underline"
                    >
                        {onlineLabel}
                    </a>
                </div>
            </StatusChip>

            {active && (
                <StatusChip slot="session">
                    <div className="flex flex-col items-end gap-1">
                        <button
                            type="button"
                            onClick={() => void openPicker()}
                            className="flex w-max max-w-[260px] items-center gap-2 rounded-full border border-border bg-background/90 px-3 py-1.5 text-xs text-foreground shadow-sm backdrop-blur-sm transition-colors hover:bg-accent"
                            title="Switch or manage local sessions"
                        >
                            <FolderOpen className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                            <span className="truncate font-medium">
                                {active.name}
                            </span>
                            {active.name !== active.gameName && (
                                <span className="truncate text-muted-foreground">
                                    ({active.gameName})
                                </span>
                            )}
                        </button>
                        {unsavedError && (
                            <button
                                type="button"
                                onClick={() => void flushSave()}
                                className="flex w-max items-center gap-1.5 rounded-full border border-destructive/60 bg-background/95 px-2.5 py-1 text-xs text-destructive shadow-sm backdrop-blur-sm hover:bg-destructive/10"
                                title={unsavedError}
                            >
                                <AlertTriangle className="h-3 w-3 shrink-0" />
                                <span>Unsaved changes · Retry</span>
                            </button>
                        )}
                    </div>
                </StatusChip>
            )}

            {/* Boot spinner */}
            {booting && (
                <div className="fixed inset-0 z-[2000] flex items-center justify-center bg-background">
                    <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                </div>
            )}

            {/* Confirmation modal for /local?url=https://... */}
            {!booting && pendingUrl && (
                <div className="fixed inset-0 z-[2000] flex items-center justify-center bg-background/95 p-4 backdrop-blur-sm">
                    <div className="w-full max-w-md rounded-xl border border-border bg-card p-6 shadow-xl">
                        <div className="mb-4 flex items-center gap-2">
                            <Globe className="h-5 w-5 text-primary" />
                            <h1 className="text-lg font-semibold">
                                Load game from external URL?
                            </h1>
                        </div>
                        <p className="mb-3 text-sm text-muted-foreground">
                            Your browser will download this file directly from{" "}
                            <span className="font-medium text-foreground">
                                {pendingUrl.url.hostname}
                            </span>{" "}
                            and save a local copy on this device.
                        </p>
                        <p className="mb-4 break-all rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-xs text-muted-foreground">
                            {pendingUrl.url.href}
                        </p>
                        <label className="mb-4 flex flex-col gap-1.5 text-sm">
                            <span className="text-muted-foreground">
                                Session name (optional)
                            </span>
                            <Input
                                value={pendingUrl.sessionName}
                                maxLength={100}
                                placeholder="Defaults to the game's name"
                                disabled={Boolean(busyLabel)}
                                onChange={(e) =>
                                    setPendingUrl({
                                        ...pendingUrl,
                                        sessionName: e.target.value,
                                    })
                                }
                            />
                        </label>
                        {busyLabel && (
                            <p className="mb-3 text-sm text-muted-foreground">
                                {busyLabel}
                            </p>
                        )}
                        <div className="flex justify-end gap-2">
                            <Button
                                variant="outline"
                                disabled={Boolean(busyLabel)}
                                onClick={() => {
                                    stripLocalQueryParams();
                                    setPendingUrl(null);
                                    if (!active) setPickerOpen(true);
                                }}
                            >
                                Cancel
                            </Button>
                            <Button
                                disabled={Boolean(busyLabel)}
                                onClick={() =>
                                    void handleLoadFromUrl(
                                        pendingUrl.url.href,
                                        pendingUrl.sessionName || undefined,
                                        true,
                                    )
                                }
                            >
                                {busyLabel ? "Loading…" : "Load & play"}
                            </Button>
                        </div>
                    </div>
                </div>
            )}

            {/* Loading/error modal for /local?link=<token> */}
            {!booting && pendingLink && (
                <div className="fixed inset-0 z-[2000] flex items-center justify-center bg-background/95 p-4 backdrop-blur-sm">
                    <div className="w-full max-w-md rounded-xl border border-border bg-card p-6 text-center shadow-xl">
                        {!linkError ? (
                            <div className="flex flex-col items-center gap-4 py-4">
                                <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                                <p className="text-sm text-muted-foreground">
                                    Downloading game definition for local play…
                                </p>
                            </div>
                        ) : (
                            <div className="flex flex-col items-center gap-4">
                                <h1 className="text-xl font-semibold">
                                    {linkError.invalidLink
                                        ? "Link no longer active"
                                        : "Couldn't load game"}
                                </h1>
                                <p className="text-sm text-muted-foreground">
                                    {linkError.message}
                                </p>
                                <div className="flex flex-wrap justify-center gap-2">
                                    {!linkError.invalidLink && (
                                        <Button
                                            onClick={() =>
                                                void loadFromGameLink(pendingLink)
                                            }
                                        >
                                            <RefreshCw className="mr-2 h-4 w-4" />
                                            Try again
                                        </Button>
                                    )}
                                    <Button
                                        variant="outline"
                                        onClick={() => {
                                            stripLocalQueryParams();
                                            setPendingLink(null);
                                            setLinkError(null);
                                            setPickerOpen(true);
                                        }}
                                    >
                                        Open local sessions
                                    </Button>
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* Local Session Picker overlay */}
            {!booting && !pendingUrl && !pendingLink && pickerOpen && (
                <div
                    className="fixed inset-0 z-[2000] flex items-center justify-center bg-background/95 p-4 backdrop-blur-sm"
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby={titleId}
                >
                    <div
                        ref={dialogRef}
                        tabIndex={-1}
                        className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl outline-none"
                    >
                        {/* Header */}
                        <div className="flex items-start justify-between gap-4 border-b border-border px-6 py-4">
                            <div>
                                <h1
                                    id={titleId}
                                    className="text-xl font-bold tracking-tight"
                                >
                                    Local Play
                                </h1>
                                <p className="mt-0.5 text-xs text-muted-foreground">
                                    Saved only in this browser. Nothing is
                                    synced or uploaded, and no account is
                                    required.
                                </p>
                            </div>
                            <div className="flex shrink-0 items-center gap-2">
                                {active && (
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        onClick={() => setPickerOpen(false)}
                                    >
                                        Back to board
                                    </Button>
                                )}
                                <Button asChild size="sm" variant="ghost">
                                    <a href={onlineHref}>{onlineLabel}</a>
                                </Button>
                            </div>
                        </div>

                        {/* Body */}
                        <div className="flex-1 space-y-6 overflow-y-auto px-6 py-5">
                            {!persistent && (
                                <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-xs text-amber-200">
                                    Browser storage (IndexedDB) is blocked in
                                    this window. Your local games and sessions
                                    will work, but will be cleared when you
                                    close this tab.
                                </div>
                            )}

                            {loadError && (
                                <div
                                    role="alert"
                                    className="rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive"
                                >
                                    <p className="font-medium">
                                        {loadError.message}
                                    </p>
                                    {loadError.issues &&
                                        loadError.issues.length > 1 && (
                                            <ul className="mt-2 list-disc space-y-0.5 pl-4 text-xs">
                                                {loadError.issues
                                                    .slice(0, 5)
                                                    .map((issue, i) => (
                                                        <li key={i}>
                                                            {issue.path &&
                                                            issue.path !== "/"
                                                                ? `${issue.path}: `
                                                                : ""}
                                                            {issue.message}
                                                        </li>
                                                    ))}
                                            </ul>
                                        )}
                                </div>
                            )}

                            {/* Saved local sessions */}
                            {sessions.length > 0 && (
                                <section className="space-y-2.5">
                                    <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                                        Your local sessions
                                    </h2>
                                    <div className="space-y-2">
                                        {sessions.map((s) => {
                                            const isCurrent =
                                                active?.id === s.id;
                                            const isRenaming =
                                                renamingId === s.id;
                                            return (
                                                <div
                                                    key={s.id}
                                                    className={`group flex items-center gap-2 rounded-lg border px-3 py-2.5 transition-colors ${
                                                        isCurrent
                                                            ? "border-primary/60 bg-primary/10"
                                                            : "border-border bg-background/50 hover:bg-accent/50"
                                                    }`}
                                                >
                                                    {isRenaming ? (
                                                        <form
                                                            className="flex flex-1 items-center gap-2"
                                                            onSubmit={(e) => {
                                                                e.preventDefault();
                                                                void handleRenameSession(
                                                                    s.id,
                                                                );
                                                            }}
                                                        >
                                                            <Input
                                                                autoFocus
                                                                maxLength={100}
                                                                value={
                                                                    renameDraft
                                                                }
                                                                onChange={(e) =>
                                                                    setRenameDraft(
                                                                        e.target
                                                                            .value,
                                                                    )
                                                                }
                                                                className="h-8 text-sm"
                                                            />
                                                            <Button
                                                                type="submit"
                                                                size="sm"
                                                            >
                                                                Save
                                                            </Button>
                                                            <Button
                                                                type="button"
                                                                size="sm"
                                                                variant="ghost"
                                                                onClick={() =>
                                                                    setRenamingId(
                                                                        null,
                                                                    )
                                                                }
                                                            >
                                                                Cancel
                                                            </Button>
                                                        </form>
                                                    ) : (
                                                        <>
                                                            <button
                                                                type="button"
                                                                className="min-w-0 flex-1 text-left"
                                                                onClick={() =>
                                                                    void openSessionById(
                                                                        s.id,
                                                                    )
                                                                }
                                                            >
                                                                <div className="flex items-center gap-2">
                                                                    <span className="truncate text-sm font-medium">
                                                                        {s.name}
                                                                    </span>
                                                                    {isCurrent && (
                                                                        <span className="rounded bg-primary/20 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
                                                                            Open
                                                                        </span>
                                                                    )}
                                                                </div>
                                                                <p className="mt-0.5 truncate text-xs text-muted-foreground">
                                                                    {s.gameName}{" "}
                                                                    ·{" "}
                                                                    {
                                                                        s.questionCount
                                                                    }{" "}
                                                                    question
                                                                    {s.questionCount ===
                                                                    1
                                                                        ? ""
                                                                        : "s"}
                                                                    {s.updatedAt
                                                                        ? ` · ${formatUpdated(s.updatedAt)}`
                                                                        : ""}
                                                                </p>
                                                            </button>
                                                            <Button
                                                                type="button"
                                                                size="icon"
                                                                variant="ghost"
                                                                className="h-8 w-8 text-muted-foreground hover:text-foreground"
                                                                title="Rename session"
                                                                aria-label={`Rename ${s.name}`}
                                                                onClick={() => {
                                                                    setRenamingId(
                                                                        s.id,
                                                                    );
                                                                    setRenameDraft(
                                                                        s.name,
                                                                    );
                                                                }}
                                                            >
                                                                <Pencil className="h-3.5 w-3.5" />
                                                            </Button>
                                                            <Button
                                                                type="button"
                                                                size="icon"
                                                                variant="ghost"
                                                                className="h-8 w-8 text-muted-foreground hover:text-destructive"
                                                                title="Delete session"
                                                                aria-label={`Delete ${s.name}`}
                                                                onClick={() =>
                                                                    setDeleteSessionTarget(
                                                                        s,
                                                                    )
                                                                }
                                                            >
                                                                <Trash2 className="h-3.5 w-3.5" />
                                                            </Button>
                                                        </>
                                                    )}
                                                </div>
                                            );
                                        })}
                                    </div>
                                </section>
                            )}

                            {/* Load a new game.json */}
                            <section className="space-y-3">
                                <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                                    Load a game definition
                                </h2>

                                {/* File drop zone */}
                                <div
                                    onDragOver={(e) => {
                                        e.preventDefault();
                                        setDragOver(true);
                                    }}
                                    onDragLeave={() => setDragOver(false)}
                                    onDrop={(e) => {
                                        e.preventDefault();
                                        setDragOver(false);
                                        const file =
                                            e.dataTransfer.files?.[0];
                                        if (file) void handleFile(file);
                                    }}
                                    className={`flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-4 py-6 text-center transition-colors ${
                                        dragOver
                                            ? "border-primary bg-primary/10"
                                            : "border-border bg-background/40 hover:border-muted-foreground/50"
                                    }`}
                                >
                                    <Upload className="h-6 w-6 text-muted-foreground" />
                                    <p className="text-sm font-medium">
                                        Drop a{" "}
                                        <code className="rounded bg-muted px-1 py-0.5 text-xs">
                                            .game.json
                                        </code>{" "}
                                        file here
                                    </p>
                                    <p className="text-xs text-muted-foreground">
                                        Everything stays on this device — works
                                        offline once loaded.
                                    </p>
                                    <Button
                                        type="button"
                                        size="sm"
                                        variant="secondary"
                                        disabled={Boolean(busyLabel)}
                                        onClick={() =>
                                            fileInputRef.current?.click()
                                        }
                                    >
                                        <FileUp className="mr-2 h-4 w-4" />
                                        {busyLabel || "Choose file…"}
                                    </Button>
                                    <input
                                        ref={fileInputRef}
                                        type="file"
                                        accept=".json,application/json"
                                        hidden
                                        onChange={(e) => {
                                            const file = e.target.files?.[0];
                                            e.target.value = "";
                                            if (file) void handleFile(file);
                                        }}
                                    />
                                </div>

                                {/* Static URL loader */}
                                <form
                                    className="flex flex-col gap-1.5"
                                    onSubmit={(e) => {
                                        e.preventDefault();
                                        void handleLoadFromUrl(urlInput);
                                    }}
                                >
                                    <div className="flex gap-2">
                                        <Input
                                            type="url"
                                            placeholder="https://example.com/my-city.game.json"
                                            value={urlInput}
                                            disabled={Boolean(busyLabel)}
                                            onChange={(e) =>
                                                setUrlInput(e.target.value)
                                            }
                                        />
                                        <Button
                                            type="submit"
                                            variant="outline"
                                            disabled={
                                                Boolean(busyLabel) ||
                                                !urlInput.trim()
                                            }
                                        >
                                            Load URL
                                        </Button>
                                    </div>
                                    <p className="text-xs text-muted-foreground">
                                        Requires a direct CORS-enabled URL (e.g.
                                        GitHub Raw, Gist raw, or static hosting).
                                    </p>
                                </form>
                            </section>

                            {/* Previously loaded local games */}
                            {games.length > 0 && (
                                <section className="space-y-2.5">
                                    <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                                        Saved games on this device
                                    </h2>
                                    <div className="space-y-2">
                                        {games.map((g) => (
                                            <div
                                                key={g.id}
                                                className="flex flex-col gap-2 rounded-lg border border-border bg-background/50 px-3 py-2.5"
                                            >
                                                <div className="flex items-center justify-between gap-2">
                                                    <div className="min-w-0 flex-1">
                                                        <p className="truncate text-sm font-medium">
                                                            {g.name}
                                                        </p>
                                                        <p className="truncate text-xs text-muted-foreground">
                                                            {g.zoneCount} zone
                                                            {g.zoneCount === 1
                                                                ? ""
                                                                : "s"}{" "}
                                                            · {g.layerCount}{" "}
                                                            layer
                                                            {g.layerCount === 1
                                                                ? ""
                                                                : "s"}{" "}
                                                            ·{" "}
                                                            {sourceLabel(
                                                                g.source,
                                                            )}
                                                        </p>
                                                    </div>
                                                    <div className="flex shrink-0 items-center gap-1.5">
                                                        <Button
                                                            type="button"
                                                            size="sm"
                                                            variant="outline"
                                                            disabled={Boolean(
                                                                busyLabel,
                                                            )}
                                                            onClick={() => {
                                                                setNewSessionGame(
                                                                    g,
                                                                );
                                                                setNewSessionName(
                                                                    g.name,
                                                                );
                                                            }}
                                                        >
                                                            <Plus className="mr-1 h-3.5 w-3.5" />
                                                            New session
                                                        </Button>
                                                        <Button
                                                            type="button"
                                                            size="icon"
                                                            variant="ghost"
                                                            className="h-8 w-8 text-muted-foreground hover:text-destructive"
                                                            title="Remove saved game"
                                                            aria-label={`Remove ${g.name}`}
                                                            onClick={() =>
                                                                setDeleteGameTarget(
                                                                    g,
                                                                )
                                                            }
                                                        >
                                                            <Trash2 className="h-3.5 w-3.5" />
                                                        </Button>
                                                    </div>
                                                </div>

                                                {newSessionGame?.id === g.id && (
                                                    <form
                                                        className="flex items-center gap-2 border-t border-border pt-2"
                                                        onSubmit={(e) => {
                                                            e.preventDefault();
                                                            void handleStartFromSavedGame(
                                                                g,
                                                                newSessionName,
                                                            );
                                                        }}
                                                    >
                                                        <Input
                                                            autoFocus
                                                            maxLength={100}
                                                            value={
                                                                newSessionName
                                                            }
                                                            placeholder="Session name"
                                                            onChange={(e) =>
                                                                setNewSessionName(
                                                                    e.target
                                                                        .value,
                                                                )
                                                            }
                                                            className="h-8 text-sm"
                                                        />
                                                        <Button
                                                            type="submit"
                                                            size="sm"
                                                            disabled={Boolean(
                                                                busyLabel,
                                                            )}
                                                        >
                                                            Start
                                                        </Button>
                                                        <Button
                                                            type="button"
                                                            size="sm"
                                                            variant="ghost"
                                                            onClick={() =>
                                                                setNewSessionGame(
                                                                    null,
                                                                )
                                                            }
                                                        >
                                                            Cancel
                                                        </Button>
                                                    </form>
                                                )}
                                            </div>
                                        ))}
                                    </div>
                                </section>
                            )}

                            {loadingCatalog &&
                                sessions.length === 0 &&
                                games.length === 0 && (
                                    <p className="text-center text-xs text-muted-foreground">
                                        Loading saved sessions…
                                    </p>
                                )}
                        </div>
                    </div>
                </div>
            )}

            {/* Delete local session confirmation */}
            <AlertDialog
                open={Boolean(deleteSessionTarget)}
                onOpenChange={(open) => {
                    if (!open) setDeleteSessionTarget(null);
                }}
            >
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>
                            Delete local session “{deleteSessionTarget?.name}”?
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                            This removes its questions, drawings and disabled
                            zones from this browser. The game definition itself
                            stays saved so you can start a new session anytime.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                            onClick={() => void handleDeleteSession()}
                        >
                            Delete session
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>

            {/* Delete saved local game confirmation */}
            <AlertDialog
                open={Boolean(deleteGameTarget)}
                onOpenChange={(open) => {
                    if (!open) setDeleteGameTarget(null);
                }}
            >
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>
                            Remove “{deleteGameTarget?.name}” from this device?
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                            {sessionsUsingDeleteGame > 0
                                ? `This will also delete ${sessionsUsingDeleteGame} local session${sessionsUsingDeleteGame === 1 ? "" : "s"} using this game.`
                                : "You can always load the game file again later."}
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                            onClick={() => void handleDeleteGame()}
                        >
                            Remove game
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </>
    );
}
