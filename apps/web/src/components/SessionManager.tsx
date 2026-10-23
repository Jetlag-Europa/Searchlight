import { useStore } from "@nanostores/react";
import type {
    Game,
    GameSessionSummary,
    ServersResponse,
    SessionsResponse,
} from "@searchlight/shared";
import { Settings, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { toast } from "react-toastify";

import { strokes } from "@/annotations/hooks/useAnnotationStore";
import { StatusChip } from "@/components/StatusChip";
import { Button } from "@/components/ui/button";
import {
    compiledGameAtom,
    filterSupportedQuestions,
    setActiveGameDefinition,
} from "@/game-definition/store";
import {
    activeSessionData,
    activeSessionId,
    clearActiveSession,
    offlineUserId,
    setActiveSession,
    verifiedUserId,
} from "@/lib/activeSession";
import {
    gameDefinitionReady,
    questions,
    sessionPickerOpen,
} from "@/lib/context";
import { hiderMode, planningModeEnabled } from "@/lib/context";
import {
    applyPendingModes,
    applyUnsyncedEvents,
    discardSessionData,
    getCachedSession,
    getPendingEvents,
    queuedQuestionsBase,
    setBoardBase,
    setCachedSession,
} from "@/lib/eventQueue";
import { fetchGameCatalog, leaveGame, switchToGame } from "@/lib/games";
import { shouldSuppressHiderSave } from "@/lib/hiderSaveSuppress";
import { shouldSuppressPlanningModeSave } from "@/lib/planningModeSaveSuppress";
import {
    reconcileQuestionConflicts,
    setQuestionDecisionsPossible,
    showMergedSave,
    trackBoardQuestions,
} from "@/lib/questionConflicts";
import {
    isQuestionSaveSuppressed,
    suppressQuestionSave,
} from "@/lib/questionSaveSuppress";
import { handleRejectedEdits } from "@/lib/rejectedEdits";
import { readStorage, removeStorage } from "@/lib/safeStorage";
import {
    cancelPendingHiderSave,
    cancelPendingPlanningModeSave,
    cancelPendingQuestionSave,
    flushSavesOnPageExit,
    flushSessionSaves,
    hasScheduledQuestionSave,
    loadSessionContent,
    saveHiderModeToServer,
    savePlanningModeToServer,
    saveQuestionsDebounced,
} from "@/lib/sessionState";
import { startSSE, stopSSE } from "@/lib/sseManager";
import {
    flushPendingEvents,
    onQuestionsSaved,
    startSyncManager,
} from "@/lib/syncManager";

const API_BASE = import.meta.env.PUBLIC_API_BASE as string;

// ── Session picker overlay ────────────────────────────────────────────────────

function SessionPickerOverlay({
    onSessionSelected,
    onClose,
}: {
    onSessionSelected: (session: GameSessionSummary) => void;
    // Returns to the active session's board; absent when there is none.
    onClose?: () => void;
}) {
    const [servers, setServers] = useState<ServersResponse["servers"] | null>(
        null,
    );
    const [selectedServerId, setSelectedServerId] = useState<string>("");
    const [sessions, setSessions] = useState<GameSessionSummary[] | null>(null);
    const [availableGames, setAvailableGames] = useState<Game[]>([]);
    const [loadingServers, setLoadingServers] = useState(true);
    const [recheckingServers, setRecheckingServers] = useState(false);
    const [loadingSessions, setLoadingSessions] = useState(false);
    const [creatingSession, setCreatingSession] = useState(false);
    const [newSessionName, setNewSessionName] = useState("");
    const [newSessionGameId, setNewSessionGameId] = useState("");
    const [showCreateForm, setShowCreateForm] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [deletingId, setDeletingId] = useState<string | null>(null);
    const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
    const [leavingId, setLeavingId] = useState<string | null>(null);
    const [confirmLeaveId, setConfirmLeaveId] = useState<string | null>(null);
    const loadSessionsReqRef = useRef(0);
    const titleId = useId();
    const dialogRef = useRef<HTMLDivElement>(null);
    const backButtonRef = useRef<HTMLButtonElement>(null);
    // A session being created will be switched to: stay until it is.
    const close = creatingSession ? undefined : onClose;

    // Focus starts inside the picker; the board behind it is inert.
    useEffect(() => {
        (backButtonRef.current ?? dialogRef.current)?.focus();
    }, []);

    // Escape returns to the board, like Back to board.
    useEffect(() => {
        if (!close) return;
        const closeOnEscape = (event: KeyboardEvent) => {
            if (event.key !== "Escape") return;
            if (event.isComposing || event.defaultPrevented) return;
            close();
        };
        window.addEventListener("keydown", closeOnEscape);
        return () => window.removeEventListener("keydown", closeOnEscape);
    }, [close]);

    useEffect(() => {
        let active = true;
        fetch(`${API_BASE}/servers`, { credentials: "include" })
            .then(async (res) => {
                if (!active) return;
                if (!res.ok) throw new Error(`${res.status}`);
                const data: ServersResponse = await res.json();
                if (!active) return;
                setServers(data.servers);
                if (data.servers.length === 1) {
                    setSelectedServerId(data.servers[0].id);
                }
            })
            .catch((e: Error) => {
                if (!active) return;
                setError(`Failed to load servers: ${e.message}`);
            })
            .finally(() => {
                if (active) setLoadingServers(false);
            });
        return () => {
            active = false;
        };
    }, []);

    // The server list remembers for hours that you aren't in a server, so ask
    // Discord again on request, for someone who just joined one.
    const recheckServers = () => {
        setRecheckingServers(true);
        fetch(`${API_BASE}/servers?recheck=true`, { credentials: "include" })
            .then(async (res) => {
                if (!res.ok) throw new Error(`${res.status}`);
                const data: ServersResponse = await res.json();
                setServers(data.servers);
                setSelectedServerId((id) =>
                    data.servers.some((s) => s.id === id) ? id : "",
                );
            })
            .catch((e: Error) =>
                setError(`Failed to load servers: ${e.message}`),
            )
            .finally(() => setRecheckingServers(false));
    };

    const loadSessionsForServer = useCallback(
        async (serverId: string, isMember: boolean) => {
            const reqId = ++loadSessionsReqRef.current;
            setLoadingSessions(true);
            setSessions(null);
            setError(null);
            try {
                const [sessRes, games] = await Promise.all([
                    fetch(`${API_BASE}/sessions?serverId=${serverId}`, {
                        credentials: "include",
                    }),
                    // A server is listed for non-members who have sessions
                    // there (from a game link or an invite link); its catalog is
                    // closed to them.
                    isMember
                        ? fetchGameCatalog(serverId).catch((err) => {
                              console.warn(
                                  "[searchlight:session] game catalog unavailable:",
                                  err,
                              );
                              return [] as Game[];
                          })
                        : Promise.resolve([] as Game[]),
                ]);
                if (reqId !== loadSessionsReqRef.current) return;
                if (!sessRes.ok) throw new Error(`${sessRes.status}`);
                const data: SessionsResponse = await sessRes.json();
                if (reqId !== loadSessionsReqRef.current) return;
                setSessions(data.sessions);
                setAvailableGames(games);
                setNewSessionGameId(games.length > 0 ? games[0].id : "");
            } catch (e: unknown) {
                if (reqId !== loadSessionsReqRef.current) return;
                setError(`Failed to load sessions: ${(e as Error).message}`);
            } finally {
                if (reqId === loadSessionsReqRef.current) {
                    setLoadingSessions(false);
                }
            }
        },
        [],
    );

    const selectedIsMember =
        servers?.find((s) => s.id === selectedServerId)?.isMember ?? false;

    useEffect(() => {
        if (selectedServerId)
            loadSessionsForServer(selectedServerId, selectedIsMember);
    }, [selectedServerId, selectedIsMember, loadSessionsForServer]);

    const handleDeleteSession = async (sessionId: string) => {
        if (confirmDeleteId !== sessionId) {
            setConfirmDeleteId(sessionId);
            return;
        }
        setDeletingId(sessionId);
        setConfirmDeleteId(null);
        try {
            const res = await fetch(`${API_BASE}/sessions/${sessionId}`, {
                method: "DELETE",
                credentials: "include",
            });
            if (!res.ok) throw new Error(`${res.status}`);
            setSessions(
                (prev) => prev?.filter((s) => s.id !== sessionId) ?? null,
            );
            discardSessionData(sessionId, { allAccounts: true });
            if (activeSessionId.get() === sessionId) clearActiveSession();
        } catch (e: unknown) {
            setError(`Failed to delete session: ${(e as Error).message}`);
        } finally {
            setDeletingId(null);
        }
    };

    const handleLeaveSession = async (sessionId: string) => {
        if (confirmLeaveId !== sessionId) {
            setConfirmLeaveId(sessionId);
            return;
        }
        setLeavingId(sessionId);
        setConfirmLeaveId(null);
        try {
            const res = await fetch(`${API_BASE}/sessions/${sessionId}/leave`, {
                method: "DELETE",
                credentials: "include",
            });
            if (!res.ok) throw new Error(`${res.status}`);
            setSessions(
                (prev) => prev?.filter((s) => s.id !== sessionId) ?? null,
            );
            discardSessionData(sessionId);
            if (activeSessionId.get() === sessionId) clearActiveSession();
        } catch (e: unknown) {
            setError(`Failed to leave session: ${(e as Error).message}`);
        } finally {
            setLeavingId(null);
        }
    };

    const handleCreateSession = async () => {
        if (!newSessionName.trim() || !newSessionGameId) return;
        setCreatingSession(true);
        setError(null);
        try {
            const res = await fetch(`${API_BASE}/sessions`, {
                method: "POST",
                credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    gameId: newSessionGameId,
                    name: newSessionName.trim(),
                }),
            });
            if (!res.ok) throw new Error(`${res.status}`);
            const session: GameSessionSummary = await res.json();
            onSessionSelected(session);
        } catch (e: unknown) {
            setError(`Failed to create session: ${(e as Error).message}`);
        } finally {
            setCreatingSession(false);
        }
    };

    // The same permissions that put a server on the /games page.
    const canManageGames = servers?.some((server) =>
        server.permissions.some((p) =>
            [
                "games.create",
                "games.edit",
                "games.delete",
                "server.admin",
            ].includes(p),
        ),
    );

    return (
        <div className="fixed inset-0 z-[9000] flex items-center justify-center bg-background/95 backdrop-blur-sm">
            <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
                tabIndex={-1}
                className="w-full max-w-md mx-4 bg-card border border-border rounded-xl shadow-xl p-6 outline-none"
            >
                <div className="flex items-start justify-between gap-2 mb-1">
                    <h1 id={titleId} className="text-xl font-bold">
                        Select a Session
                    </h1>
                    <div className="flex shrink-0 items-center gap-1">
                        {canManageGames && (
                            <a
                                href="/games"
                                title="Manage games"
                                aria-label="Manage games"
                                className="rounded-md p-1.5 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                            >
                                <Settings className="h-5 w-5" />
                            </a>
                        )}
                        {onClose && (
                            <Button
                                ref={backButtonRef}
                                size="sm"
                                variant="ghost"
                                onClick={close}
                                disabled={!close}
                            >
                                Back to board
                            </Button>
                        )}
                    </div>
                </div>
                <p className="text-sm text-muted-foreground mb-5">
                    Choose an existing session or create a new one to get
                    started.
                </p>

                {error && (
                    <p className="text-sm text-destructive mb-4 p-3 bg-destructive/10 rounded-md">
                        {error}
                    </p>
                )}

                {loadingServers && (
                    <p className="text-sm text-muted-foreground">
                        Loading servers…
                    </p>
                )}

                {servers && servers.length > 1 && (
                    <div className="mb-4">
                        <label className="text-sm font-medium block mb-1">
                            Server
                        </label>
                        <select
                            className="w-full border border-input rounded-md px-3 py-2 text-sm bg-background"
                            value={selectedServerId}
                            onChange={(e) =>
                                setSelectedServerId(e.target.value)
                            }
                        >
                            <option value="">— pick a server —</option>
                            {servers.map((s) => (
                                <option key={s.id} value={s.id}>
                                    {s.name}
                                </option>
                            ))}
                        </select>
                    </div>
                )}

                {servers && (
                    <p className="text-xs text-muted-foreground -mt-2 mb-4">
                        Joined a Discord server that isn’t listed?{" "}
                        <Button
                            variant="link"
                            className="h-auto p-0 text-xs"
                            onClick={recheckServers}
                            disabled={recheckingServers}
                        >
                            {recheckingServers ? "Checking…" : "Check again"}
                        </Button>
                    </p>
                )}

                {loadingSessions && (
                    <p className="text-sm text-muted-foreground">
                        Loading sessions…
                    </p>
                )}

                {sessions !== null && (
                    <div className="mb-2">
                        {sessions.length === 0 ? (
                            <p className="text-sm text-muted-foreground italic mb-3">
                                {selectedIsMember
                                    ? "No sessions yet. Create one below."
                                    : "No sessions on this server."}
                            </p>
                        ) : (
                            <div className="space-y-2 mb-3 max-h-64 overflow-y-auto pr-1">
                                {sessions.map((session) => (
                                    <div
                                        key={session.id}
                                        className="flex items-center border border-border rounded-lg hover:bg-accent hover:text-accent-foreground transition-colors group/row"
                                        onMouseLeave={() => {
                                            if (confirmDeleteId === session.id)
                                                setConfirmDeleteId(null);
                                            if (confirmLeaveId === session.id)
                                                setConfirmLeaveId(null);
                                        }}
                                    >
                                        <button
                                            onClick={() =>
                                                onSessionSelected(session)
                                            }
                                            className="flex-1 text-left p-3 min-w-0"
                                        >
                                            <div className="font-medium text-sm truncate">
                                                {session.name}
                                            </div>
                                            <div className="text-xs text-muted-foreground mt-0.5">
                                                {session.gameName} ·{" "}
                                                <span className="capitalize">
                                                    {session.visibility}
                                                </span>{" "}
                                                ·{" "}
                                                <span className="capitalize">
                                                    {session.role}
                                                </span>
                                            </div>
                                        </button>
                                        {session.role === "creator" && (
                                            <button
                                                onClick={() =>
                                                    handleDeleteSession(
                                                        session.id,
                                                    )
                                                }
                                                disabled={
                                                    deletingId === session.id
                                                }
                                                className={`shrink-0 px-3 py-1 mr-1 rounded-md text-xs transition-colors ${
                                                    confirmDeleteId ===
                                                    session.id
                                                        ? "text-destructive hover:bg-destructive/10 font-medium"
                                                        : "text-muted-foreground hover:text-destructive opacity-0 group-hover/row:opacity-100"
                                                }`}
                                                title={
                                                    confirmDeleteId ===
                                                    session.id
                                                        ? "Click again to confirm"
                                                        : "Delete session"
                                                }
                                            >
                                                {deletingId === session.id
                                                    ? "…"
                                                    : confirmDeleteId ===
                                                        session.id
                                                      ? "Confirm?"
                                                      : "✕"}
                                            </button>
                                        )}
                                        {session.role === "member" && (
                                            <button
                                                onClick={() =>
                                                    handleLeaveSession(
                                                        session.id,
                                                    )
                                                }
                                                disabled={
                                                    leavingId === session.id
                                                }
                                                className={`shrink-0 px-3 py-1 mr-1 rounded-md text-xs transition-colors ${
                                                    confirmLeaveId ===
                                                    session.id
                                                        ? "text-destructive hover:bg-destructive/10 font-medium"
                                                        : "text-muted-foreground hover:text-destructive opacity-0 group-hover/row:opacity-100"
                                                }`}
                                                title={
                                                    confirmLeaveId ===
                                                    session.id
                                                        ? "Click again to confirm"
                                                        : "Leave session"
                                                }
                                            >
                                                {leavingId === session.id
                                                    ? "…"
                                                    : confirmLeaveId ===
                                                        session.id
                                                      ? "Confirm?"
                                                      : "Leave"}
                                            </button>
                                        )}
                                    </div>
                                ))}
                            </div>
                        )}

                        {!selectedIsMember ? (
                            <p className="text-xs text-muted-foreground">
                                You aren’t in this Discord server, so you can
                                only open sessions shared with you here.
                            </p>
                        ) : !showCreateForm ? (
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={() => setShowCreateForm(true)}
                            >
                                + New session
                            </Button>
                        ) : (
                            <div className="border border-border rounded-lg p-4 space-y-3 mt-3">
                                <p className="text-sm font-medium">
                                    New session
                                </p>
                                <div>
                                    <label className="text-xs text-muted-foreground block mb-1">
                                        Name
                                    </label>
                                    <input
                                        type="text"
                                        placeholder="e.g. Planning A"
                                        className="w-full border border-input rounded-md px-3 py-1.5 text-sm bg-background"
                                        value={newSessionName}
                                        onChange={(e) =>
                                            setNewSessionName(e.target.value)
                                        }
                                        onKeyDown={(e) =>
                                            e.key === "Enter" &&
                                            handleCreateSession()
                                        }
                                    />
                                </div>
                                {availableGames.length >= 1 ? (
                                    <div>
                                        <label className="text-xs text-muted-foreground block mb-1">
                                            Game
                                        </label>
                                        <select
                                            className="w-full border border-input rounded-md px-3 py-1.5 text-sm bg-background"
                                            value={newSessionGameId}
                                            onChange={(e) =>
                                                setNewSessionGameId(
                                                    e.target.value,
                                                )
                                            }
                                        >
                                            {availableGames.map((g) => (
                                                <option key={g.id} value={g.id}>
                                                    {g.name}
                                                </option>
                                            ))}
                                        </select>
                                    </div>
                                ) : (
                                    <p className="text-xs text-muted-foreground italic">
                                        No games available for this server —
                                        sessions cannot be created.
                                    </p>
                                )}
                                <p className="text-xs text-muted-foreground">
                                    Only you can see a new session. Use Invite
                                    to play it with others, or Share a copy to
                                    give someone their own.
                                </p>
                                <div className="flex gap-2">
                                    <Button
                                        size="sm"
                                        onClick={handleCreateSession}
                                        disabled={
                                            creatingSession ||
                                            !newSessionName.trim() ||
                                            !newSessionGameId
                                        }
                                    >
                                        {creatingSession
                                            ? "Creating…"
                                            : "Create"}
                                    </Button>
                                    <Button
                                        size="sm"
                                        variant="ghost"
                                        onClick={() => setShowCreateForm(false)}
                                    >
                                        Cancel
                                    </Button>
                                </div>
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}

// Offline the picker has nothing to list: sessions are listed, started and
// deleted by the server.
function OfflinePickerNotice({ onClose }: { onClose: () => void }) {
    const titleId = useId();
    const closeRef = useRef<HTMLButtonElement>(null);
    useEffect(() => {
        closeRef.current?.focus();
        const closeOnEscape = (event: KeyboardEvent) => {
            if (event.key === "Escape" && !event.isComposing) onClose();
        };
        window.addEventListener("keydown", closeOnEscape);
        return () => window.removeEventListener("keydown", closeOnEscape);
    }, [onClose]);
    return (
        <div className="fixed inset-0 z-[9000] flex items-center justify-center bg-background/95 backdrop-blur-sm">
            <div
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
                className="w-full max-w-md mx-4 bg-card border border-border rounded-xl shadow-xl p-6"
            >
                <h1 id={titleId} className="text-xl font-bold mb-1">
                    Select a Session
                </h1>
                <p className="text-sm text-muted-foreground mb-5">
                    Sessions can be changed once the server can be reached.
                    This session keeps your edits meanwhile, and saves them
                    then.
                </p>
                <Button ref={closeRef} size="sm" onClick={onClose}>
                    Back to board
                </Button>
            </div>
        </div>
    );
}

// ── Session chip (active state) ───────────────────────────────────────────────

function SessionChip({
    session,
    onChangeSession,
    inert,
}: {
    session: GameSessionSummary;
    onChangeSession: (event: React.MouseEvent<HTMLElement>) => void;
    inert: boolean;
}) {
    return (
        <StatusChip slot="session">
            <div
                className="flex w-max items-center gap-2 bg-background/90 border border-border rounded-full px-3 py-1 text-xs shadow-sm backdrop-blur-sm"
                inert={inert}
            >
                <span
                    className="font-medium truncate max-w-[140px]"
                    title={session.name}
                >
                    {session.name}
                </span>
                <button
                    onClick={onChangeSession}
                    className="text-muted-foreground hover:text-foreground underline whitespace-nowrap"
                >
                    change
                </button>
            </div>
        </StatusChip>
    );
}

// ── Game not loaded (session active, definition missing) ──────────────────────

// Shown under the map beside the revision banner. The board stays visible,
// but nothing is answered or added until the game loads.
function GameNotLoadedBanner({
    onRetry,
    onChangeSession,
}: {
    onRetry: () => void;
    onChangeSession: (event: React.MouseEvent<HTMLElement>) => void;
}) {
    return (
        <section
            aria-label="Session game"
            className="shrink-0 border-b bg-background px-3 py-2 text-foreground sm:px-4"
        >
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                <div className="flex min-w-0 items-center gap-2.5">
                    <TriangleAlert
                        aria-hidden="true"
                        className="size-4 shrink-0 text-destructive"
                    />
                    <div className="text-xs">
                        <p className="font-medium" role="alert">
                            Game not loaded
                        </p>
                        <p className="mt-0.5 text-muted-foreground">
                            This session&apos;s game couldn&apos;t be loaded.
                            Questions can&apos;t be answered or added until it
                            is.
                        </p>
                    </div>
                </div>
                <div className="flex gap-2">
                    <Button size="sm" variant="outline" onClick={onRetry}>
                        Retry
                    </Button>
                    <Button size="sm" variant="ghost" onClick={onChangeSession}>
                        Change session
                    </Button>
                </div>
            </div>
        </section>
    );
}

// ── Main component ────────────────────────────────────────────────────────────

export function SessionManager() {
    const verifiedId = useStore(verifiedUserId);
    const offlineId = useStore(offlineUserId);
    // The account the board is played as: the one /me verified or, while /me
    // can't be reached, the last one verified in this browser. Offline,
    // nothing is asked of the server until /me answers.
    const authUserId = verifiedId ?? offlineId;
    const offline = !verifiedId && Boolean(offlineId);
    const sessionId = useStore(activeSessionId);
    const session = useStore(activeSessionData);
    const currentQuestions = useStore(questions);
    const currentHiderMode = useStore(hiderMode);
    const currentPlanningMode = useStore(planningModeEnabled);
    const gameReady = useStore(gameDefinitionReady);
    const [showPicker, setShowPicker] = useState(false);
    const [loading, setLoading] = useState(false);
    // The last session load ended without the session's game definition.
    const [gameNotLoaded, setGameNotLoaded] = useState(false);
    // Loading it later (a revision upgrade) clears the failure.
    useEffect(() => {
        if (gameReady) setGameNotLoaded(false);
    }, [gameReady]);
    // The control that opened the picker gets focus back on Back to board;
    // the chip and banner stay mounted under the picker for that.
    const pickerOpenerRef = useRef<HTMLElement | null>(null);
    const restorePickerFocusRef = useRef(false);
    const openPicker = (event: React.MouseEvent<HTMLElement>) => {
        pickerOpenerRef.current = event.currentTarget;
        setShowPicker(true);
    };
    const closePicker = useCallback(() => {
        restorePickerFocusRef.current = true;
        setShowPicker(false);
    }, []);
    // The board behind the picker is inert, and so is the user chip (it reads
    // sessionPickerOpen). Focus returns once they aren't.
    useEffect(() => {
        const board = document.getElementById("map-board");
        if (board) board.inert = showPicker;
        sessionPickerOpen.set(showPicker);
        if (!showPicker && restorePickerFocusRef.current) {
            restorePickerFocusRef.current = false;
            pickerOpenerRef.current?.focus();
            pickerOpenerRef.current = null;
        }
    }, [showPicker]);
    const sessionLoadGenerationRef = useRef(0);
    // Generation of the session load that is still replacing content, if any.
    // Save effects bail while it is current: the atoms can already hold the
    // incoming session's (or a stale cached) state while activeSessionId still
    // names the session it would be saved into.
    const loadingGenerationRef = useRef<number | null>(null);
    const isLoadingSession = () =>
        loadingGenerationRef.current === sessionLoadGenerationRef.current;
    // Prevents saving questions immediately after we just loaded them from the server.
    const suppressNextSaveRef = useRef(true);
    // Start suppressed: always wait for the server load before allowing any hider saves.
    const suppressNextHiderSaveRef = useRef(true);
    // Start suppressed: always wait for the server load before allowing planning mode saves.
    const suppressNextPlanningModeRef = useRef(true);
    // The account whose kept session the board shows while offline.
    const offlineBoardUserRef = useRef<string | null>(null);
    const offlineRef = useRef(offline);
    offlineRef.current = offline;
    // The session whose questions the board shows, for this account: painted
    // from what was kept, or loaded. Null while it shows none (nothing was
    // kept and the load failed, or another account's board was cleared).
    const boardSessionRef = useRef<string | null>(null);
    // Offline, only a board painted from what was kept may be saved: saving
    // the empty board of a session that wasn't would wipe it on reconnect.
    // Likewise a board that shows nothing of the active session.
    const savesBlocked = () =>
        (offlineRef.current && offlineBoardUserRef.current !== authUserId) ||
        boardSessionRef.current !== activeSessionId.get();
    // Deciding a question conflict edits the board: only while the board is
    // the active session's and its edits are saved.
    const loadingRef = useRef(loading);
    loadingRef.current = loading;
    const refreshQuestionDecisions = () =>
        setQuestionDecisionsPossible(
            Boolean(activeSessionId.get() && authUserId) &&
                !loadingRef.current &&
                !isLoadingSession() &&
                !savesBlocked(),
        );
    useEffect(refreshQuestionDecisions);
    useEffect(() => () => setQuestionDecisionsPossible(false), []);

    // A board painted from the snapshot shows the latest list still queued,
    // if any: its base is that list's, not the snapshot's (a merged list
    // whose answer was lost comes with the server list it was merged with).
    //
    // Known limit: if that merged save did land (only its answer was lost),
    // the server also has our side of it. An edit made on the reopened
    // board before the queued list is sent then replaces it in the queue,
    // and a question of ours that the edit removes again reads, in the next
    // merge, as one the other side added, so it comes back. Telling the two
    // apart takes asking the server about the replaced list first, which was
    // tried and broke the live flow (a live board shows the list as first
    // made, not as merged). It takes a lost answer, a reload and that edit
    // in a row; the question can be removed again.
    const paintedFromSnapshot = (id: string) => {
        const base = queuedQuestionsBase(id);
        if (base) setBoardBase(id, base);
    };

    // A session's hider and planning mode, with this account's edits to them
    // that haven't synced yet.
    const showSessionModes = (session: GameSessionSummary) => {
        const modes = applyPendingModes(
            session,
            getPendingEvents(session.id).filter(
                (event) => event.status !== "synced",
            ),
        );
        // Only suppress if the atom will actually change. If both old and new
        // are false, nanostores won't fire and the ref would stay true forever,
        // silently swallowing the next legit user-initiated hider save.
        if (modes.hiderMode !== false || hiderMode.get() !== false) {
            suppressNextHiderSaveRef.current = true;
        }
        hiderMode.set(modes.hiderMode);
        if (planningModeEnabled.get() !== modes.planningModeEnabled) {
            suppressNextPlanningModeRef.current = true;
        }
        planningModeEnabled.set(modes.planningModeEnabled);
    };

    // Debounce-save questions whenever they change (while a session is active).
    // Skip the first fire after a server load to avoid overwriting fresh server data.
    useEffect(() => {
        const save = (() => {
            if (!sessionId || !authUserId || savesBlocked()) return false;
            if (suppressNextSaveRef.current) {
                suppressNextSaveRef.current = false;
                return false;
            }
            if (isQuestionSaveSuppressed(currentQuestions)) {
                console.info(
                    "[searchlight:session] suppressing save — questions were set by SSE or game filtering",
                );
                return false;
            }
            if (isLoadingSession()) {
                console.info(
                    "[searchlight:session] suppressing save — session is loading",
                );
                return false;
            }
            return true;
        })();
        // A player's edit to a question held for a decision decides it.
        trackBoardQuestions(sessionId, currentQuestions, save);
        if (save) saveQuestionsDebounced(sessionId, currentQuestions);
    }, [sessionId, authUserId, currentQuestions]);

    // Debounce-save hider mode whenever it changes (while a session is active).
    useEffect(() => {
        if (!sessionId || !authUserId || savesBlocked()) return;
        if (suppressNextHiderSaveRef.current) {
            suppressNextHiderSaveRef.current = false;
            console.info("[searchlight:session] hider save suppressed by ref", {
                sessionId,
                hiderMode: currentHiderMode,
            });
            return;
        }
        if (shouldSuppressHiderSave()) {
            console.info(
                "[searchlight:session] hider save suppressed by SSE counter",
                { sessionId, hiderMode: currentHiderMode },
            );
            return;
        }
        if (isLoadingSession()) {
            console.info(
                "[searchlight:session] hider save suppressed — session is loading",
            );
            return;
        }
        console.info("[searchlight:session] queuing hider save", {
            sessionId,
            hiderMode: currentHiderMode,
        });
        saveHiderModeToServer(sessionId, currentHiderMode);
    }, [sessionId, authUserId, currentHiderMode]);

    // Debounce-save planning mode whenever it changes (while a session is active).
    useEffect(() => {
        if (!sessionId || !authUserId || savesBlocked()) return;
        if (suppressNextPlanningModeRef.current) {
            suppressNextPlanningModeRef.current = false;
            console.info(
                "[searchlight:session] planning mode save suppressed by ref",
                { sessionId, planningModeEnabled: currentPlanningMode },
            );
            return;
        }
        if (shouldSuppressPlanningModeSave()) {
            console.info(
                "[searchlight:session] planning mode save suppressed by SSE counter",
                { sessionId, planningModeEnabled: currentPlanningMode },
            );
            return;
        }
        if (isLoadingSession()) {
            console.info(
                "[searchlight:session] planning mode save suppressed — session is loading",
            );
            return;
        }
        console.info("[searchlight:session] queuing planning mode save", {
            sessionId,
            planningModeEnabled: currentPlanningMode,
        });
        savePlanningModeToServer(sessionId, currentPlanningMode);
    }, [sessionId, authUserId, currentPlanningMode]);

    // Flush pending question, hider & planning saves when the page may close.
    useEffect(() => flushSavesOnPageExit(), []);

    // The session was deleted (404) or this user can no longer open it (403):
    // drop the pointer and the local queue/cache, which can never sync. A 403
    // can also follow a user switch, so keep another account's local edits.
    const forgetSession = useCallback(
        (sessionId: string, status: number) => {
            if (
                status === 404 ||
                getCachedSession(sessionId)?.userId === authUserId
            ) {
                discardSessionData(sessionId, { allAccounts: status === 404 });
            }
            // Edits still waiting to be queued can never be delivered either.
            cancelPendingQuestionSave(sessionId);
            cancelPendingHiderSave(sessionId);
            cancelPendingPlanningModeSave(sessionId);
            if (activeSessionId.get() === sessionId) clearActiveSession();
            if (boardSessionRef.current === sessionId) boardSessionRef.current = null;
            setShowPicker(true);
        },
        [authUserId],
    );

    // On mount: start sync manager and restore or show picker
    useEffect(() => {
        if (!authUserId) return;
        const generation = ++sessionLoadGenerationRef.current;
        const isCurrent = () => generation === sessionLoadGenerationRef.current;
        const cleanup = () => {
            sessionLoadGenerationRef.current++;
            stopSSE();
        };
        startSyncManager();
        // /me answered after the board was played offline. Another account
        // doesn't get to see it (AuthGuard has dropped the session pointer).
        // The same one keeps the edits it made, queued for the reconcile.
        const offlineBoardUser = offlineBoardUserRef.current;
        offlineBoardUserRef.current = null;
        refreshQuestionDecisions();
        if (offlineBoardUser === authUserId && activeSessionId.get()) {
            flushSessionSaves(activeSessionId.get());
        } else {
            cancelPendingQuestionSave();
            cancelPendingHiderSave();
            cancelPendingPlanningModeSave();
            if (offlineBoardUser) {
                leaveGame();
                boardSessionRef.current = null;
                strokes.set([]);
                questions.set(suppressQuestionSave([]));
                hiderMode.set(false);
                planningModeEnabled.set(false);
            }
        }

        // A session the user just started or joined from /play or /join.
        // Offline, it waits for /me.
        const pendingLinkSession = readStorage(
            "localStorage",
            "taibled-pending-link-session",
        );
        if (pendingLinkSession && offline) return cleanup;
        if (pendingLinkSession) {
            removeStorage("localStorage", "taibled-pending-link-session");
            setLoading(true);
            fetch(`${API_BASE}/sessions/${pendingLinkSession}`, {
                credentials: "include",
            })
                .then(async (res) => {
                    if (!res.ok) throw new Error(`${res.status}`);
                    const selected: GameSessionSummary = await res.json();
                    if (!isCurrent()) return;
                    setLoading(false);
                    await handleSessionSelected(selected);
                })
                .catch(() => {
                    if (isCurrent()) {
                        setLoading(false);
                        setShowPicker(true);
                    }
                });
            return cleanup;
        }

        const storedId = activeSessionId.get();
        if (!storedId) {
            // The picker needs the server.
            if (!offline) setShowPicker(true);
            return cleanup;
        }

        // The cached owner must match the account played as, and the session
        // must be authorized before private content becomes visible. Without
        // that authorization, only the account /me last verified in this
        // browser sees what was kept for it, and only while the server can't
        // be reached: when /me fails (not with a 401: that's a logout), or
        // when /me verifies it but the session request itself fails. Logging
        // out forgets that account and the kept games.
        const cached = getCachedSession(storedId);
        const canPaintCache = Boolean(cached && cached.userId === authUserId);
        // The loading overlay stays up over the painted cache until the
        // reconcile below finishes: it replaces the board, so an edit made
        // in between could not be kept (and must not be saved over fresher
        // server state).
        // As kept when painted: a queued list may have been saved since the
        // load started.
        const paintCached = () => {
            const kept = getCachedSession(storedId);
            if (!canPaintCache || !kept || kept.userId !== authUserId) return false;
            const derived = applyUnsyncedEvents(storedId, kept);
            boardSessionRef.current = storedId;
            gameDefinitionReady.set(false);
            setActiveGameDefinition(null);
            suppressNextSaveRef.current = true;
            strokes.set(derived.strokes);
            // The game hasn't loaded: show only what it may support.
            questions.set(filterSupportedQuestions(derived.questions, null));
            paintedFromSnapshot(storedId);
            return true;
        };
        // Then, still without the server: the session's details, its hider
        // and planning mode and its game as this browser kept them, with the
        // edits not yet synced.
        const restoreKept = () => {
            const kept = cached?.session;
            if (!kept) {
                setGameNotLoaded(true);
                return;
            }
            setActiveSession(kept);
            showSessionModes(kept);
            void switchToGame(
                { id: kept.gameId },
                { revisionId: kept.gameRevisionId, sessionId: kept.id },
            ).then((ready) => {
                if (isCurrent()) setGameNotLoaded(!ready);
            });
        };

        if (offline) {
            console.info(
                "[searchlight:session] server unreachable, restoring kept session",
                storedId,
            );
            if (paintCached()) {
                offlineBoardUserRef.current = authUserId;
                refreshQuestionDecisions();
                restoreKept();
            }
            return cleanup;
        }
        setLoading(true);

        console.info(
            "[searchlight:session] validating stored session",
            storedId,
        );
        fetch(`${API_BASE}/sessions/${storedId}`, { credentials: "include" })
            .then(async (res) => {
                if (!isCurrent()) return;
                if (res.status === 403 || res.status === 404) {
                    console.warn(
                        "[searchlight:session] stored session unavailable (" +
                            res.status +
                            "), showing picker",
                    );
                    forgetSession(storedId, res.status);
                    return;
                }
                // Anything else (502, 503, 429…) is handled like being offline.
                if (!res.ok)
                    throw new Error(`session fetch failed: ${res.status}`);
                const data: GameSessionSummary = await res.json();
                if (!isCurrent()) return;
                // The cached snapshot may be stale: nothing shown before the
                // server reconcile may be saved over fresher questions.
                loadingGenerationRef.current = generation;
                paintCached();
                // storedId === data.id always here (we fetched by storedId), so
                // activeSessionId won't change — no suppress needed for sessionId effect.
                setActiveSession(data);
                setShowPicker(false);

                // Always reconcile from server: flush pending first so server has the
                // latest state, then load authoritative content. On cache hit this runs
                // in the background (user already sees painted state); on cache miss this
                // is the first paint. Errors are swallowed so cached state is preserved
                try {
                    await flushPendingEvents(storedId);
                    if (!isCurrent()) return;
                    const {
                        questions: serverQs,
                        strokes: serverStrokes,
                        session: refreshedSession,
                        cursor: serverCursor,
                        questionsSequence,
                    } = await loadSessionContent(storedId, authUserId);
                    if (!isCurrent()) return;
                    // Questions held for a decision may be settled by now.
                    // The list's own sequence, else the cursor read before it.
                    const listSequence = questionsSequence ?? serverCursor;
                    if (listSequence !== undefined) {
                        reconcileQuestionConflicts(storedId, serverQs, listSequence);
                    }
                    const definitionReady = await switchToGame(
                        { id: refreshedSession.gameId },
                        {
                            revisionId: refreshedSession.gameRevisionId,
                            sessionId: refreshedSession.id,
                        },
                    );
                    if (!isCurrent()) return;
                    cancelPendingQuestionSave();
                    cancelPendingHiderSave();
                    cancelPendingPlanningModeSave();
                    setActiveSession(refreshedSession);
                    // Keep edits the flush above couldn't deliver on top of the
                    // server state, as an explicit selection does.
                    const reconciled = applyUnsyncedEvents(storedId, {
                        strokes: serverStrokes,
                        questions: serverQs,
                    });
                    strokes.set(reconciled.strokes);
                    // Without its definition, keep what the game may support.
                    const visibleQuestions = filterSupportedQuestions(
                        reconciled.questions,
                        definitionReady ? compiledGameAtom.get() : null,
                    );
                    console.info(
                        "[searchlight:session] reconciled",
                        visibleQuestions.length,
                        "question(s) from server",
                    );
                    suppressNextSaveRef.current = true;
                    boardSessionRef.current = storedId;
                    questions.set(visibleQuestions);
                    const cachedState = getCachedSession(storedId);
                    if (cachedState && definitionReady) {
                        setCachedSession({
                            ...cachedState,
                            userId: authUserId,
                            visibility: refreshedSession.visibility,
                            questions: visibleQuestions,
                        });
                    }
                    // Edits the flush couldn't deliver stay on top, as for
                    // questions.
                    showSessionModes(refreshedSession);
                    startSSE(storedId, (status) =>
                        forgetSession(storedId, status),
                    );
                } catch (e) {
                    console.warn(
                        canPaintCache
                            ? "[searchlight:session] background reconcile failed, keeping cached state"
                            : "[searchlight:session] content load failed",
                        e,
                    );
                    // The session is authorized: its modes are known, and
                    // its game may still come from the copy kept here.
                    if (isCurrent()) showSessionModes(data);
                    if (isCurrent() && canPaintCache) {
                        await switchToGame(
                            { id: data.gameId },
                            {
                                revisionId: data.gameRevisionId,
                                sessionId: data.id,
                            },
                        );
                    }
                } finally {
                    if (isCurrent()) {
                        loadingGenerationRef.current = null;
                        setGameNotLoaded(!gameDefinitionReady.get());
                    }
                }
            })
            .catch((e) => {
                if (!isCurrent()) return;
                console.warn("[searchlight:session] session fetch error:", e);
                // Keep the pointer even without a cache to show, so the next
                // load can restore the session once the server is back.
                const painted = paintCached();
                setShowPicker(!painted);
                if (painted) restoreKept();
            })
            .finally(() => {
                if (isCurrent()) setLoading(false);
            });

        return cleanup;
    }, [authUserId, offline]);

    // Keep the session's details, hider and planning mode with its snapshot,
    // for an offline restore. Only once the session shows with its game:
    // until then the modes can still be another session's.
    useEffect(() => {
        if (offline || !authUserId || !session || !gameReady || loading) return;
        if (session.id !== sessionId) return;
        const cached = getCachedSession(session.id);
        if (!cached || cached.userId !== authUserId) return;
        const kept: GameSessionSummary = {
            ...session,
            hiderLat: currentHiderMode ? currentHiderMode.latitude : null,
            hiderLng: currentHiderMode ? currentHiderMode.longitude : null,
            planningModeEnabled: currentPlanningMode,
        };
        if (JSON.stringify(cached.session) === JSON.stringify(kept)) return;
        setCachedSession({ ...cached, session: kept });
    }, [
        offline,
        authUserId,
        session,
        sessionId,
        gameReady,
        loading,
        currentHiderMode,
        currentPlanningMode,
    ]);

    const handleSessionSelected = useCallback(
        async (selected: GameSessionSummary) => {
            if (!authUserId) return;
            const generation = ++sessionLoadGenerationRef.current;
            const isCurrent = () =>
                generation === sessionLoadGenerationRef.current;
            loadingGenerationRef.current = generation;
            stopSSE();

            // Queue the outgoing session's pending edits durably right away;
            // their delivery (or retry) must not hold up the switch.
            const outgoingId = activeSessionId.get();
            if (outgoingId) flushSessionSaves(outgoingId);

            console.info(
                "[searchlight:session] selecting session",
                selected.id,
                selected.name,
            );

            // Nothing is evaluated before the session's game loads, and
            // another session's game must not outlast a failed load.
            const switchingSession = selected.id !== outgoingId;
            if (switchingSession) {
                leaveGame();
            } else {
                gameDefinitionReady.set(false);
                setActiveGameDefinition(null);
            }

            // Check local cache for instant paint. If not cached, clear atoms so stale
            // content from the outgoing session is never published.
            const cached = getCachedSession(selected.id);
            const canPaintCache = Boolean(
                cached && cached.userId === authUserId,
            );
            if (canPaintCache && cached) {
                const derived = applyUnsyncedEvents(selected.id, cached);
                // As in the stored-session restore above, the board is shown
                // under the loading overlay until the server state replaces it.
                suppressNextSaveRef.current = true;
                boardSessionRef.current = selected.id;
                strokes.set(derived.strokes);
                questions.set(
                    filterSupportedQuestions(derived.questions, null),
                );
                paintedFromSnapshot(selected.id);
                console.info(
                    "[searchlight:session] painted from cache, loading server state",
                );
            } else {
                suppressNextSaveRef.current = true;
                boardSessionRef.current = null;
                strokes.set([]);
                questions.set([]);
            }
            setLoading(true);

            let sessionToActivate = selected;

            try {
                // On explicit selection, flush pending events BEFORE authoritative load!
                await flushPendingEvents(selected.id).catch((err) => {
                    console.info(
                        "[searchlight:session] flush pending failed (offline?):",
                        err,
                    );
                });
                if (!isCurrent()) return;
                const {
                    questions: loadedQuestions,
                    strokes: loadedStrokes,
                    session: refreshedSession,
                    cursor: loadedCursor,
                    questionsSequence,
                } = await loadSessionContent(selected.id, authUserId);
                if (!isCurrent()) return;
                // Questions held for a decision may be settled by now.
                // The list's own sequence, else the cursor read before it.
                const listSequence = questionsSequence ?? loadedCursor;
                if (listSequence !== undefined) {
                    reconcileQuestionConflicts(selected.id, loadedQuestions, listSequence);
                }
                sessionToActivate = refreshedSession;

                console.info(
                    "[searchlight:session] applying game",
                    refreshedSession.gameName,
                );
                const definitionReady = await switchToGame(
                    { id: refreshedSession.gameId },
                    {
                        revisionId: refreshedSession.gameRevisionId,
                        sessionId: refreshedSession.id,
                    },
                );
                if (!isCurrent()) return;

                // Reconcile any remaining pending events that were not flushed
                const reconciledState = applyUnsyncedEvents(selected.id, {
                    strokes: loadedStrokes,
                    questions: loadedQuestions,
                });

                strokes.set(reconciledState.strokes);
                // Without its definition, keep what the game may support.
                const visibleQuestions = filterSupportedQuestions(
                    reconciledState.questions,
                    definitionReady ? compiledGameAtom.get() : null,
                );
                console.info(
                    "[searchlight:session] loaded",
                    visibleQuestions.length,
                    "question(s) from server",
                );
                suppressNextSaveRef.current = true;
                boardSessionRef.current = selected.id;
                questions.set(visibleQuestions);
                const cachedState = getCachedSession(selected.id);
                if (cachedState && definitionReady) {
                    setCachedSession({
                        ...cachedState,
                        userId: authUserId,
                        visibility: refreshedSession.visibility,
                        questions: visibleQuestions,
                    });
                }
                showSessionModes(refreshedSession);
                startSSE(selected.id, (status) =>
                    forgetSession(selected.id, status),
                );
            } catch (e: unknown) {
                if (!isCurrent()) return;
                console.warn(
                    "[searchlight:session] failed to load session content:",
                    e,
                );
                // As kept now: a queued list may have been saved meanwhile.
                const kept = getCachedSession(selected.id);
                if (canPaintCache && kept && kept.userId === authUserId) {
                    // Offline fallback: replay pending events on top of cached snapshot
                    const derived = applyUnsyncedEvents(selected.id, kept);
                    suppressNextSaveRef.current = true;
                    boardSessionRef.current = selected.id;
                    strokes.set(derived.strokes);
                    questions.set(
                        filterSupportedQuestions(derived.questions, null),
                    );
                    paintedFromSnapshot(selected.id);
                } else {
                    // No cache and no server — leave atoms empty, don't publish stale session content
                    boardSessionRef.current = null;
                    strokes.set([]);
                    questions.set([]);
                }
                if (switchingSession) {
                    // The outgoing session's hider and planning mode aren't
                    // this session's.
                    if (hiderMode.get() !== false) {
                        suppressNextHiderSaveRef.current = true;
                        hiderMode.set(false);
                    }
                    if (planningModeEnabled.get()) {
                        suppressNextPlanningModeRef.current = true;
                        planningModeEnabled.set(false);
                    }
                }
            } finally {
                if (isCurrent()) setLoading(false);
            }
            if (!isCurrent()) return;

            // Suppress save effects that fire when sessionId changes — state was just
            // loaded from the server so there's nothing new to write back.
            suppressNextSaveRef.current = true;
            // Nothing set during the load may be saved, into either session.
            cancelPendingQuestionSave();
            cancelPendingHiderSave();
            cancelPendingPlanningModeSave();
            // Only suppress the sessionId-change hider effect if the session is
            // actually changing — same-session re-selects don't fire the effect.
            if (activeSessionId.get() !== selected.id) {
                suppressNextHiderSaveRef.current = true;
                suppressNextPlanningModeRef.current = true;
            }
            setActiveSession(sessionToActivate);
            loadingGenerationRef.current = null;
            setShowPicker(false);
            setGameNotLoaded(!gameDefinitionReady.get());
        },
        [authUserId, forgetSession],
    );

    // Load the session again, its game included. Fetching the session first
    // also covers an offline restore, which never got the session's details.
    const retryGameLoad = async () => {
        const id = activeSessionId.get();
        if (offline) {
            // The session loads again once /me answers.
            toast.error(
                "Couldn't reach the server. Check your connection and try again.",
            );
            return;
        }
        if (!id) {
            setShowPicker(true);
            return;
        }
        const generation = ++sessionLoadGenerationRef.current;
        const isCurrent = () => generation === sessionLoadGenerationRef.current;
        const fail = (message: string, error: unknown) => {
            console.warn("[searchlight:session] retry failed:", error);
            toast.error(message);
        };
        setLoading(true);
        let selected: GameSessionSummary;
        try {
            let res: Response;
            try {
                res = await fetch(`${API_BASE}/sessions/${id}`, {
                    credentials: "include",
                });
            } catch (e) {
                // fetch rejects only when the request couldn't be sent.
                if (isCurrent()) {
                    fail(
                        "Couldn't reach the server. Check your connection and try again.",
                        e,
                    );
                }
                return;
            }
            if (!isCurrent()) return;
            if (res.status === 403 || res.status === 404) {
                forgetSession(id, res.status);
                return;
            }
            if (res.status === 401) {
                fail(
                    "Your sign-in has expired. Reload the page to sign in again.",
                    res.status,
                );
                return;
            }
            if (!res.ok) {
                fail(
                    `The server couldn't load this session (error ${res.status}). Try again later.`,
                    res.status,
                );
                return;
            }
            try {
                selected = await res.json();
            } catch (e) {
                if (isCurrent()) {
                    fail(
                        "The server's response couldn't be read. Try again later.",
                        e,
                    );
                }
                return;
            }
        } finally {
            if (isCurrent()) setLoading(false);
        }
        if (!isCurrent()) return;
        await handleSessionSelected(selected);
        // handleSessionSelected starts the next load generation.
        if (
            sessionLoadGenerationRef.current === generation + 1 &&
            !gameDefinitionReady.get()
        ) {
            toast.error("The game still couldn't be loaded. Try again later.");
        }
    };

    // A question list saved here was merged with changes made elsewhere:
    // show them, on top of anything edited since. A load in progress shows
    // the server's list anyway.
    useEffect(
        () =>
            onQuestionsSaved((saved) => {
                if (!saved.mergedWith || saved.sessionId !== activeSessionId.get()) {
                    return;
                }
                // Only on a board that shows the session (one that shows
                // nothing would read as removing everything).
                if (isLoadingSession() || boardSessionRef.current !== saved.sessionId) {
                    return;
                }
                showMergedSave(saved, {
                    saveScheduled: hasScheduledQuestionSave(saved.sessionId),
                });
            }),
        [],
    );

    // The server refused edits for good (too large, invalid, a conflict) and
    // they left the queue: load the session again, which also checks it's
    // still there, so the board shows what the server has.
    useEffect(
        () =>
            handleRejectedEdits({
                isLoading: isLoadingSession,
                reload: () => void retryGameLoad(),
                confirmUnavailable: (id) => {
                    fetch(`${API_BASE}/sessions/${id}`, {
                        credentials: "include",
                    })
                        .then((res) => {
                            if (
                                (res.status === 403 || res.status === 404) &&
                                activeSessionId.get() === id
                            ) {
                                forgetSession(id, res.status);
                            }
                        })
                        .catch((err) => {
                            console.warn(
                                "[searchlight:session] session check failed:",
                                err,
                            );
                        });
                },
            }),
        [forgetSession, handleSessionSelected],
    );

    // map.astro places the slot beside the revision banner.
    const bannerSlot = document.getElementById("game-not-loaded-banner");

    if (loading) {
        return (
            <div className="fixed inset-0 z-[9000] flex items-center justify-center bg-background/80">
                <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            </div>
        );
    }

    return (
        <>
            {showPicker && offline && (
                <OfflinePickerNotice onClose={closePicker} />
            )}
            {showPicker && !offline && (
                <SessionPickerOverlay
                    onSessionSelected={handleSessionSelected}
                    onClose={
                        // Only back to a board the session has shown.
                        sessionId && (session || gameNotLoaded)
                            ? closePicker
                            : undefined
                    }
                />
            )}
            {gameNotLoaded &&
                !gameReady &&
                bannerSlot &&
                createPortal(
                    <GameNotLoadedBanner
                        onRetry={() => void retryGameLoad()}
                        onChangeSession={openPicker}
                    />,
                    bannerSlot,
                )}
            {session && (
                <SessionChip
                    session={session}
                    onChangeSession={openPicker}
                    inert={showPicker}
                />
            )}
        </>
    );
}
