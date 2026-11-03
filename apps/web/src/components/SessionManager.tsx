import { useStore } from "@nanostores/react";
import {
    CASUAL_SERVER_ID,
    type Game,
    type GameSessionSummary,
    type ServersResponse,
    type SessionsResponse,
} from "@searchlight/shared";
import { EyeIcon, Settings, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { toast } from "react-toastify";

import { strokes } from "@/annotations/hooks/useAnnotationStore";
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
import {
    compiledGameAtom,
    filterSupportedQuestions,
    setActiveGameDefinition,
} from "@/game-definition/store";
import {
    activeSessionData,
    activeSessionId,
    activeSessionRole,
    clearActiveSession,
    offlineUserId,
    sessionReadOnly,
    setActiveSession,
    verifiedUserId,
} from "@/lib/activeSession";
import { createBackoffRetry } from "@/lib/backoffRetry";
import {
    gameDefinitionReady,
    hiderMode,
    planningModeEnabled,
    questions,
    sessionPickerOpen,
} from "@/lib/context";
import { deletedSessionNotice } from "@/lib/deletedSessionNotice";
import { isSameDoubleTap } from "@/lib/doubleTap";
import {
    applyPendingModes,
    applyUnsyncedEvents,
    boardPaintedFromSnapshot,
    discardSessionData,
    getCachedSession,
    getPendingEvents,
    isSessionSummary,
    setCachedSession,
} from "@/lib/eventQueue";
import { fetchGameCatalog, leaveGame, switchToGame } from "@/lib/games";
import { shouldSuppressHiderSave } from "@/lib/hiderSaveSuppress";
import {
    DETAILS_TIMEOUT_MS,
    FLUSH_WAIT_MS,
    startLoadDeadline,
} from "@/lib/loadDeadline";
import { endOfflineAccess } from "@/lib/offlineAccess";
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
import { fetchSessionDetails, probeSession } from "@/lib/sessionProbe";
import {
    becomeSpectator,
    cacheSessionRole,
    cancelPendingHiderSave,
    cancelPendingPlanningModeSave,
    cancelPendingQuestionSave,
    discardSessionEdits,
    flushSavesOnPageExit,
    flushSessionSaves,
    hasScheduledQuestionSave,
    loadSessionContent,
    saveHiderModeToServer,
    savePlanningModeToServer,
    saveQuestionsDebounced,
} from "@/lib/sessionState";
import {
    SessionUnavailableError,
    sessionUnavailableStatus,
} from "@/lib/sessionUnavailable";
import {
    SESSION_ROLE_CHANGED_EVENT,
    SESSION_STREAM_RECONNECTED_EVENT,
    type SessionRoleChangedDetail,
    type SessionStreamReconnectedDetail,
    startSSE,
    stopSSE,
} from "@/lib/sseManager";
import {
    flushPendingEvents,
    onQuestionsSaved,
    startSyncManager,
} from "@/lib/syncManager";

const API_BASE = import.meta.env.PUBLIC_API_BASE as string;

// A row's Delete and Leave: shown on hover or focus with a mouse, and always,
// big enough to tap, on a touch screen.
const ROW_ACTION_CLASS =
    "shrink-0 px-3 py-1 mr-1 rounded-md text-xs transition-colors [@media(any-pointer:coarse)]:my-1 [@media(any-pointer:coarse)]:min-h-11 [@media(any-pointer:coarse)]:self-stretch";
const ROW_ACTION_HIDDEN_CLASS =
    "text-muted-foreground hover:text-destructive opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100 [@media(any-pointer:coarse)]:opacity-100";

// Sessions this tab asked the server to delete: their own stream's 404 later
// isn't news, even when the delete's reply was lost.
const deletedHere = new Set<string>();

// Checks again, in the background, a session whose board shows what was kept
// here because the server didn't answer for it. Another session starts from
// the shortest delay.
const sessionRecheck = createBackoffRetry();
let recheckedSessionId: string | null = null;
// A check was put off while the picker was open: closing it tries then.
let recheckWaitedForPicker = false;
// Or while the player typed in a field: leaving it tries then.
let recheckWaitedForTyping = false;

// Fields that take a tap, not typing.
const NOT_TYPED_IN = new Set([
    "button",
    "checkbox",
    "color",
    "file",
    "hidden",
    "image",
    "radio",
    "range",
    "reset",
    "submit",
]);

// The player is typing in a field (a question's name or radius, say): a load
// now would replace the board, and what they typed with it.
function typingInField(): boolean {
    const field = document.activeElement as HTMLInputElement | null;
    if (!field) return false;
    if (field.tagName === "TEXTAREA" || field.isContentEditable) return true;
    return field.tagName === "INPUT" && !NOT_TYPED_IN.has(field.type);
}

// As AuthGuard does when /me says the sign-in is gone. Not "reload the
// page": the installed app has no reload button.
function signInAgain(): void {
    const { pathname, search, hash } = window.location;
    void endOfflineAccess().finally(() => {
        window.location.href = `/?returnTo=${encodeURIComponent(
            pathname + search + hash,
        )}`;
    });
}

function saySignInExpired(): void {
    toast.error(
        <div className="flex w-full items-center gap-2">
            <span className="min-w-0 flex-1">Your sign-in has expired.</span>
            <button
                className="min-h-9 shrink-0 rounded-md border border-current px-3 text-sm font-semibold"
                onClick={signInAgain}
            >
                Sign in
            </button>
        </div>,
        // Until it's tapped or closed: nothing else offers it.
        { toastId: "sign-in-expired", autoClose: false },
    );
}

// How a session load ended, one toast at a time.
const LOAD_TOAST_ID = "session-load";
const LOAD_FAILED = "Something went wrong loading this session. Try again.";

// The server didn't give a session load what it needed, or took too long
// (see startLoadDeadline): say so, and what the board shows instead.
function sayLoadFellBack(timedOut: boolean, showingKeptCopy: boolean): void {
    const problem = timedOut
        ? "The server is taking too long."
        : "Couldn't load the latest from the server.";
    const instead = showingKeptCopy
        ? "Showing the copy saved on this device; it will keep trying."
        : "Try again in a moment.";
    toast.warn(`${problem} ${instead}`, { toastId: LOAD_TOAST_ID });
}

// How long a tapped Leave waits for its second tap.
const LEAVE_CONFIRM_MS = 5_000;

// Edits still waiting to be queued can never be delivered either, and would
// put the session's queue back after it was discarded. Every session's
// without an id.
function cancelPendingSaves(sessionId?: string): void {
    cancelPendingQuestionSave(sessionId);
    cancelPendingHiderSave(sessionId);
    cancelPendingPlanningModeSave(sessionId);
}

// A loaded mode its save effect has already checked: the next change is the
// player's.
const NOT_LOADED = Symbol("not loaded");

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
    // The session the delete confirm is open for (kept while it closes).
    const [deleteTarget, setDeleteTarget] = useState<GameSessionSummary | null>(
        null,
    );
    const [confirmingDelete, setConfirmingDelete] = useState(false);
    // Where focus goes when the confirm closes; the picker when null.
    const deleteReturnFocusRef = useRef<HTMLElement | null>(null);
    const [leavingId, setLeavingId] = useState<string | null>(null);
    const [confirmLeaveId, setConfirmLeaveId] = useState<string | null>(null);
    // When Leave was armed, or the delete confirm opened: the second tap of a
    // quick double tap mustn't also confirm.
    const leaveArmedAtRef = useRef<number | null>(null);
    const deleteOpenedAtRef = useRef<number | null>(null);
    // An armed Leave doesn't wait for the next tap, however much later.
    useEffect(() => {
        if (!confirmLeaveId) return;
        const timer = setTimeout(
            () => setConfirmLeaveId(null),
            LEAVE_CONFIRM_MS,
        );
        return () => clearTimeout(timer);
    }, [confirmLeaveId]);
    const loadSessionsReqRef = useRef(0);
    const titleId = useId();
    // The confirm renders in here: the board, where dialogs usually go, is
    // inert and under the picker.
    const [overlay, setOverlay] = useState<HTMLDivElement | null>(null);
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

    // A list that doesn't come in time failed, and can be tried again.
    const loadServersReqRef = useRef(0);
    const loadServers = useCallback(async () => {
        const reqId = ++loadServersReqRef.current;
        setLoadingServers(true);
        setError(null);
        const deadline = startLoadDeadline(DETAILS_TIMEOUT_MS);
        try {
            const res = await fetch(`${API_BASE}/servers`, {
                credentials: "include",
                signal: deadline.signal,
            });
            if (!res.ok) throw new Error(`${res.status}`);
            const data: ServersResponse = await res.json();
            if (reqId !== loadServersReqRef.current) return;
            setServers(data.servers);
            if (data.servers.length === 1) {
                setSelectedServerId(data.servers[0].id);
            }
        } catch (e: unknown) {
            if (reqId !== loadServersReqRef.current) return;
            setError(`Failed to load servers: ${(e as Error).message}`);
        } finally {
            deadline.clear();
            if (reqId === loadServersReqRef.current) setLoadingServers(false);
        }
    }, []);
    useEffect(() => {
        void loadServers();
        return () => {
            loadServersReqRef.current++;
        };
    }, [loadServers]);

    // The server list remembers for hours that you aren't in a server, so ask
    // Discord again on request, for someone who just joined one.
    const recheckServers = () => {
        setRecheckingServers(true);
        const deadline = startLoadDeadline(DETAILS_TIMEOUT_MS);
        fetch(`${API_BASE}/servers?recheck=true`, {
            credentials: "include",
            signal: deadline.signal,
        })
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
            .finally(() => {
                deadline.clear();
                setRecheckingServers(false);
            });
    };

    const loadSessionsForServer = useCallback(
        async (serverId: string, isMember: boolean) => {
            const reqId = ++loadSessionsReqRef.current;
            setLoadingSessions(true);
            setSessions(null);
            setError(null);
            const deadline = startLoadDeadline(DETAILS_TIMEOUT_MS);
            try {
                const [sessRes, games] = await Promise.all([
                    fetch(`${API_BASE}/sessions?serverId=${serverId}`, {
                        credentials: "include",
                        signal: deadline.signal,
                    }),
                    // A server is listed for non-members who have sessions
                    // there (from a game link or an invite link); its catalog is
                    // closed to them. Casual games are never in a catalog.
                    isMember && serverId !== CASUAL_SERVER_ID
                        ? deadline
                              .race(fetchGameCatalog(serverId))
                              .catch((err) => {
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
                deadline.clear();
                if (reqId === loadSessionsReqRef.current) {
                    setLoadingSessions(false);
                }
            }
        },
        [],
    );

    const selectedIsMember =
        servers?.find((s) => s.id === selectedServerId)?.isMember ?? false;
    // Casual only groups existing sessions: new ones start from game links.
    const selectedIsCasual = selectedServerId === CASUAL_SERVER_ID;

    useEffect(() => {
        if (selectedServerId)
            loadSessionsForServer(selectedServerId, selectedIsMember);
    }, [selectedServerId, selectedIsMember, loadSessionsForServer]);

    // A list that failed to load leaves nothing to pick from: Try again, or
    // coming back online, loads it again (the installed app has no reload).
    const listFailed =
        Boolean(error) &&
        (!servers || (Boolean(selectedServerId) && sessions === null));
    const retryList = useCallback(() => {
        if (!servers || !selectedServerId) void loadServers();
        else void loadSessionsForServer(selectedServerId, selectedIsMember);
    }, [
        servers,
        selectedServerId,
        selectedIsMember,
        loadServers,
        loadSessionsForServer,
    ]);
    useEffect(() => {
        if (!listFailed) return;
        window.addEventListener("online", retryList);
        return () => window.removeEventListener("online", retryList);
    }, [listFailed, retryList]);

    const handleDeleteSession = async (sessionId: string) => {
        setDeletingId(sessionId);
        deletedHere.add(sessionId);
        try {
            const res = await fetch(`${API_BASE}/sessions/${sessionId}`, {
                method: "DELETE",
                credentials: "include",
            });
            // When the request itself fails it may still have gone through,
            // so the id stays. The API's 404 for the session is a delete that
            // already happened: an earlier try whose reply was lost, or
            // another tab.
            if (!res.ok && (await sessionUnavailableStatus(res)) !== 404) {
                deletedHere.delete(sessionId);
                throw new Error(`${res.status}`);
            }
            setSessions(
                (prev) => prev?.filter((s) => s.id !== sessionId) ?? null,
            );
            discardSessionData(sessionId, { allAccounts: true });
            cancelPendingSaves(sessionId);
            if (activeSessionId.get() === sessionId) clearActiveSession();
        } catch (e: unknown) {
            setError(`Failed to delete session: ${(e as Error).message}`);
        } finally {
            setDeletingId(null);
        }
    };

    // `byPointer`: a click from a tap or a mouse (a key press can't be the
    // second half of a double tap).
    const handleLeaveSession = async (
        sessionId: string,
        byPointer: boolean,
    ) => {
        if (confirmLeaveId !== sessionId) {
            leaveArmedAtRef.current = Date.now();
            setConfirmLeaveId(sessionId);
            return;
        }
        if (byPointer && isSameDoubleTap(leaveArmedAtRef.current, Date.now()))
            return;
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
            cancelPendingSaves(sessionId);
            if (activeSessionId.get() === sessionId) clearActiveSession();
        } catch (e: unknown) {
            setError(`Failed to leave session: ${(e as Error).message}`);
        } finally {
            setLeavingId(null);
        }
    };

    const handleCreateSession = async () => {
        // Enter pressed again while it's created mustn't make another.
        if (creatingSession || !newSessionName.trim() || !newSessionGameId)
            return;
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
        <div
            ref={setOverlay}
            className="fixed inset-0 z-[9000] flex items-center justify-center bg-background/95 backdrop-blur-sm"
        >
            {/* Scrolls on a small or sideways phone, where it's taller than
                the screen. */}
            <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
                tabIndex={-1}
                className="w-full max-w-md max-h-[calc(100dvh-2rem)] overflow-y-auto mx-4 bg-card border border-border rounded-xl shadow-xl p-6 outline-none"
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
                    <div className="flex items-center justify-between gap-3 text-sm text-destructive mb-4 p-3 bg-destructive/10 rounded-md">
                        <p className="min-w-0 [overflow-wrap:anywhere]">
                            {error}
                        </p>
                        {listFailed && (
                            <Button
                                size="sm"
                                variant="outline"
                                className="shrink-0"
                                onClick={retryList}
                            >
                                Try again
                            </Button>
                        )}
                    </div>
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
                                {selectedIsMember && !selectedIsCasual
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
                                                {session.role === "viewer" ? (
                                                    "Spectating"
                                                ) : (
                                                    <span className="capitalize">
                                                        {session.role}
                                                    </span>
                                                )}
                                            </div>
                                        </button>
                                        {session.role === "creator" && (
                                            <button
                                                type="button"
                                                onClick={(event) => {
                                                    deleteReturnFocusRef.current =
                                                        event.currentTarget;
                                                    deleteOpenedAtRef.current =
                                                        Date.now();
                                                    setDeleteTarget(session);
                                                    setConfirmingDelete(true);
                                                }}
                                                disabled={
                                                    deletingId === session.id
                                                }
                                                aria-label={`Delete session “${session.name}”`}
                                                className={`${ROW_ACTION_CLASS} ${ROW_ACTION_HIDDEN_CLASS}`}
                                            >
                                                {deletingId === session.id
                                                    ? "…"
                                                    : "Delete"}
                                            </button>
                                        )}
                                        {session.role !== "creator" && (
                                            <button
                                                type="button"
                                                onClick={(event) =>
                                                    handleLeaveSession(
                                                        session.id,
                                                        event.detail !== 0,
                                                    )
                                                }
                                                // A held key repeats its
                                                // click: arm, not leave.
                                                onKeyDown={(event) => {
                                                    if (event.repeat)
                                                        event.preventDefault();
                                                }}
                                                disabled={
                                                    leavingId === session.id
                                                }
                                                aria-label={
                                                    confirmLeaveId ===
                                                    session.id
                                                        ? `Confirm leaving session “${session.name}”`
                                                        : `Leave session “${session.name}”`
                                                }
                                                className={`${ROW_ACTION_CLASS} ${
                                                    confirmLeaveId ===
                                                    session.id
                                                        ? "text-destructive hover:bg-destructive/10 font-medium"
                                                        : ROW_ACTION_HIDDEN_CLASS
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

                        {selectedIsCasual ? (
                            <p className="text-xs text-muted-foreground">
                                Casual games start from a game link. Ask the
                                game’s creator for one.
                            </p>
                        ) : !selectedIsMember ? (
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
            <AlertDialog
                open={confirmingDelete}
                onOpenChange={setConfirmingDelete}
            >
                <AlertDialogContent
                    container={overlay}
                    className="max-w-[calc(100vw-2rem)] rounded-lg sm:max-w-lg"
                    onCloseAutoFocus={(event) => {
                        // There's no trigger to go back to.
                        event.preventDefault();
                        const target = deleteReturnFocusRef.current;
                        (target?.isConnected
                            ? target
                            : dialogRef.current
                        )?.focus();
                    }}
                >
                    <AlertDialogHeader>
                        <AlertDialogTitle className="[overflow-wrap:anywhere]">
                            Delete “{deleteTarget?.name}”?
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                            This will delete the session for everyone in it,
                            with its questions and drawings. It can’t be undone.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                            onClick={(event) => {
                                // It can open under the second click of a
                                // double click on the row's Delete (a key
                                // press has no detail and can't be that).
                                if (
                                    event.detail !== 0 &&
                                    isSameDoubleTap(
                                        deleteOpenedAtRef.current,
                                        Date.now(),
                                    )
                                ) {
                                    event.preventDefault();
                                    return;
                                }
                                // Its row is going away.
                                deleteReturnFocusRef.current = null;
                                if (deleteTarget)
                                    void handleDeleteSession(deleteTarget.id);
                            }}
                        >
                            Delete session
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
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
    readOnly,
    onChangeSession,
    inert,
}: {
    session: GameSessionSummary;
    readOnly: boolean;
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
                    // Shorter beside the badge, to fit a 360 px phone.
                    className={`font-medium truncate ${
                        readOnly ? "max-w-[96px]" : "max-w-[140px]"
                    }`}
                    title={session.name}
                >
                    {session.name}
                </span>
                {readOnly && (
                    <span
                        className="flex items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 font-medium text-primary"
                        title="You can watch this session but not change it"
                    >
                        <EyeIcon aria-hidden="true" className="size-3" />
                        Spectating
                    </span>
                )}
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
    const readOnly = useStore(sessionReadOnly);
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
    // sessionPickerOpen). Nor is the board played on while a load replaces
    // it: what was typed meanwhile would be replaced too, and not saved.
    // Before focus returns to the board, below.
    useEffect(() => {
        const board = document.getElementById("map-board");
        if (board) board.inert = showPicker || loading;
    }, [showPicker, loading]);
    useEffect(() => {
        sessionPickerOpen.set(showPicker);
        // Back on the board: a background recheck waited for the picker.
        if (!showPicker && recheckWaitedForPicker) {
            recheckWaitedForPicker = false;
            sessionRecheck.tryNow();
        }
        if (!showPicker && restorePickerFocusRef.current) {
            restorePickerFocusRef.current = false;
            pickerOpenerRef.current?.focus();
            pickerOpenerRef.current = null;
        }
    }, [showPicker]);
    // Back from a field a background check waited for. Once the field's
    // own handlers have put what was typed on the board, to be saved.
    useEffect(() => {
        const onFocusOut = () => {
            if (!recheckWaitedForTyping) return;
            recheckWaitedForTyping = false;
            setTimeout(() => sessionRecheck.tryNow());
        };
        document.addEventListener("focusout", onFocusOut);
        return () => document.removeEventListener("focusout", onFocusOut);
    }, []);
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
    // The hider and planning mode a load last showed on the board (to start
    // with, what it shows already). Each save effect skips a change to exactly
    // that value, as the server or the queue already has it. Matching the
    // value, not counting changes, means a load that changes nothing can't
    // swallow the player's first change.
    const loadedHiderModeRef = useRef<
        ReturnType<typeof hiderMode.get> | typeof NOT_LOADED
    >(hiderMode.get());
    const loadedPlanningModeRef = useRef<boolean | typeof NOT_LOADED>(
        planningModeEnabled.get(),
    );
    // The account whose kept session the board shows while offline.
    const offlineBoardUserRef = useRef<string | null>(null);
    const offlineRef = useRef(offline);
    offlineRef.current = offline;
    // The session whose questions the board shows, for this account: painted
    // from what was kept, or loaded. Null while it shows none (nothing was
    // kept and the load failed, or another account's board was cleared).
    const boardSessionRef = useRef<string | null>(null);
    // That board is the copy kept here, not (yet) the server's state.
    const boardIsKeptCopyRef = useRef(false);
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
                !savesBlocked() &&
                !sessionReadOnly.get(),
        );
    useEffect(refreshQuestionDecisions);
    useEffect(() => () => setQuestionDecisionsPossible(false), []);

    // A session's hider and planning mode, with this account's edits to them
    // that haven't synced yet.
    const showSessionModes = (session: GameSessionSummary) => {
        const modes = applyPendingModes(
            session,
            getPendingEvents(session.id).filter(
                (event) => event.status !== "synced",
            ),
        );
        loadedHiderModeRef.current = modes.hiderMode;
        hiderMode.set(modes.hiderMode);
        loadedPlanningModeRef.current = modes.planningModeEnabled;
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
            // Read when the questions change: a spectator's board saves
            // nothing, and becoming a player again is no edit to save.
            return !sessionReadOnly.get();
        })();
        // A player's edit to a question held for a decision decides it.
        trackBoardQuestions(sessionId, currentQuestions, save);
        if (save) saveQuestionsDebounced(sessionId, currentQuestions);
    }, [sessionId, authUserId, currentQuestions]);

    // Debounce-save hider mode whenever it changes (while a session is active).
    useEffect(() => {
        if (!sessionId || !authUserId || savesBlocked()) return;
        // Consumed by the first run that may save: the next change is new.
        const loaded = loadedHiderModeRef.current;
        loadedHiderModeRef.current = NOT_LOADED;
        if (currentHiderMode === loaded) {
            console.info("[searchlight:session] hider save suppressed by ref", {
                sessionId,
                hiderMode: currentHiderMode,
            });
            return;
        }
        if (shouldSuppressHiderSave(currentHiderMode)) {
            console.info(
                "[searchlight:session] hider save suppressed — set by the server",
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
        if (sessionReadOnly.get()) return;
        console.info("[searchlight:session] queuing hider save", {
            sessionId,
            hiderMode: currentHiderMode,
        });
        saveHiderModeToServer(sessionId, currentHiderMode);
    }, [sessionId, authUserId, currentHiderMode]);

    // Debounce-save planning mode whenever it changes (while a session is active).
    useEffect(() => {
        if (!sessionId || !authUserId || savesBlocked()) return;
        // Consumed by the first run that may save, as for the hider.
        const loaded = loadedPlanningModeRef.current;
        loadedPlanningModeRef.current = NOT_LOADED;
        if (currentPlanningMode === loaded) {
            console.info(
                "[searchlight:session] planning mode save suppressed by ref",
                { sessionId, planningModeEnabled: currentPlanningMode },
            );
            return;
        }
        if (shouldSuppressPlanningModeSave(currentPlanningMode)) {
            console.info(
                "[searchlight:session] planning mode save suppressed — set by the server",
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
        if (sessionReadOnly.get()) return;
        console.info("[searchlight:session] queuing planning mode save", {
            sessionId,
            planningModeEnabled: currentPlanningMode,
        });
        savePlanningModeToServer(sessionId, currentPlanningMode);
    }, [sessionId, authUserId, currentPlanningMode]);

    // Spectators never see the hider: no position is kept for them, whatever
    // set it. The hider save effect skips the change, as it is read-only.
    // While a session loads, the role is still the outgoing session's.
    useEffect(() => {
        if (!readOnly || currentHiderMode === false) return;
        if (isLoadingSession()) return;
        hiderMode.set(false);
    }, [readOnly, currentHiderMode]);

    // Flush pending question, hider & planning saves when the page may close.
    useEffect(() => flushSavesOnPageExit(), []);

    // The session was deleted (404) or this user can no longer open it (403):
    // drop the pointer and the local queue/cache, which can never sync. A 403
    // can also follow a user switch, so keep another account's local edits.
    // `opening`: the session as a load that found out was opening it, which
    // is news like the active session's.
    const forgetSession = useCallback(
        (sessionId: string, status: number, opening?: GameSessionSummary) => {
            // What a failed load said is moot now.
            toast.dismiss(LOAD_TOAST_ID);
            // Named before the cache that may hold the name is discarded; a
            // cache left by another account on this device isn't ours to name.
            const active = activeSessionData.get();
            const cached = getCachedSession(sessionId);
            const known =
                opening ??
                (active?.id === sessionId
                    ? active
                    : cached?.userId === authUserId
                      ? cached.session
                      : undefined);
            const notice = deletedSessionNotice({
                sessionId,
                status,
                activeSessionId: opening ? sessionId : activeSessionId.get(),
                deletedHere: deletedHere.has(sessionId),
                role:
                    known?.role ??
                    (cached?.userId === authUserId ? cached.role : undefined),
                name: known?.name,
            });
            if (status === 404 || cached?.userId === authUserId) {
                discardSessionData(sessionId, { allAccounts: status === 404 });
            }
            cancelPendingSaves(sessionId);
            if (activeSessionId.get() === sessionId) clearActiveSession();
            if (boardSessionRef.current === sessionId) boardSessionRef.current = null;
            setShowPicker(true);
            if (notice) toast.warn(notice);
        },
        [authUserId],
    );

    // The board shows what was kept of a session the server didn't answer
    // for (a 5xx, no network, a route this API doesn't have): check it again
    // quietly until the server answers, then load it, which sends the queued
    // edits and opens the stream. Any other load stops it. (The check reads
    // the content the load reads again, but fails quietly where a load would
    // hold the board under its overlay until its deadline.)
    const keepCheckingSession = (id: string, generation: number) => {
        const isCurrent = () =>
            generation === sessionLoadGenerationRef.current &&
            activeSessionId.get() === id;
        // Not over the picker, which a load closes, nor under someone
        // typing, nor during another load.
        const busy = () => {
            if (sessionPickerOpen.get()) {
                recheckWaitedForPicker = true;
                return true;
            }
            if (typingInField()) {
                recheckWaitedForTyping = true;
                return true;
            }
            return isLoadingSession();
        };
        if (recheckedSessionId !== id) {
            recheckedSessionId = id;
            sessionRecheck.reset();
        }
        sessionRecheck.start(async () => {
            if (!isCurrent()) return true;
            if (busy()) return false;
            const probe = await probeSession(id);
            if (!isCurrent()) return true;
            if (probe.kind === "unavailable") {
                forgetSession(id, probe.status);
                return true;
            }
            if (probe.kind === "signedOut") {
                saySignInExpired();
                return true;
            }
            if (probe.kind === "retry" || busy()) return false;
            console.info("[searchlight:session] server answered, loading", id);
            void loadSession(probe.session);
            return true;
        });
    };

    // Show what this browser kept of a session, with the edits not yet synced,
    // as kept now (a queued list may have been saved meanwhile). False when it
    // kept nothing of this account's, or nothing it can read.
    const paintKeptCopy = (id: string): boolean => {
        const kept = getCachedSession(id);
        if (!kept || kept.userId !== authUserId) return false;
        let derived: ReturnType<typeof applyUnsyncedEvents>;
        try {
            derived = applyUnsyncedEvents(id, kept);
        } catch (err) {
            console.warn("[searchlight:session] kept copy unreadable:", err);
            return false;
        }
        suppressNextSaveRef.current = true;
        boardSessionRef.current = id;
        boardIsKeptCopyRef.current = true;
        strokes.set(derived.strokes);
        // The game hasn't loaded: show only what it may support.
        questions.set(filterSupportedQuestions(derived.questions, null));
        boardPaintedFromSnapshot(id);
        return true;
    };

    // On mount: start sync manager and restore or show picker
    useEffect(() => {
        if (!authUserId) return;
        const generation = ++sessionLoadGenerationRef.current;
        const isCurrent = () => generation === sessionLoadGenerationRef.current;
        const cleanup = () => {
            sessionLoadGenerationRef.current++;
            sessionRecheck.stop();
            stopSSE();
        };
        // Another account, or the server reachable again.
        sessionRecheck.reset();
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
            cancelPendingSaves();
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
            const deadline = startLoadDeadline(DETAILS_TIMEOUT_MS);
            void fetchSessionDetails(pendingLinkSession, deadline.signal).then(
                async (details) => {
                    deadline.clear();
                    if (!isCurrent()) return;
                    setLoading(false);
                    if (details.kind === "ready") {
                        await loadSession(details.session);
                        return;
                    }
                    setShowPicker(true);
                    if (details.kind === "signedOut") {
                        saySignInExpired();
                    } else if (deadline.signal.aborted) {
                        sayLoadFellBack(true, false);
                    } else {
                        toast.error(
                            "Couldn't open that session. Pick it from the list.",
                            { toastId: LOAD_TOAST_ID },
                        );
                    }
                },
            );
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
        // Without its game: restoreKept loads the one the copy names.
        const paintCached = () => {
            if (!paintKeptCopy(storedId)) return false;
            gameDefinitionReady.set(false);
            setActiveGameDefinition(null);
            return true;
        };
        // Then, still without the server: the session's details, its hider
        // and planning mode and its game as this browser kept them, with the
        // edits not yet synced.
        const restoreKept = () => {
            // The cache's role is kept up to date with the server's, and a
            // spectator's board never shows the hider.
            const kept =
                cached?.session && cached.role === "viewer"
                    ? {
                          ...cached.session,
                          role: "viewer" as const,
                          hiderLat: null,
                          hiderLng: null,
                      }
                    : cached?.session;
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
        // The cache says whether its user only spectates the session: their
        // board is read-only, and edits from before are dropped, before it
        // shows.
        const spectateIfCached = () => {
            if (canPaintCache && cached?.role === "viewer") {
                discardSessionEdits(storedId);
                activeSessionRole.set("viewer");
            }
        };

        if (offline) {
            console.info(
                "[searchlight:session] server unreachable, restoring kept session",
                storedId,
            );
            spectateIfCached();
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
        const deadline = startLoadDeadline(DETAILS_TIMEOUT_MS);
        void fetchSessionDetails(storedId, deadline.signal).then(
            async (details) => {
                deadline.clear();
                if (!isCurrent()) return;
                if (details.kind === "ready") {
                    // Loaded like a selection: its edits sent, then the
                    // server's state, else the copy kept here.
                    await loadSession(details.session);
                    return;
                }
                setLoading(false);
                if (details.kind === "unavailable") {
                    console.warn(
                        "[searchlight:session] stored session unavailable (" +
                            details.status +
                            "), showing picker",
                    );
                    forgetSession(storedId, details.status);
                    return;
                }
                // Anything else is handled like being offline. The pointer
                // stays even without a copy to show, so the next load can
                // restore the session once the server is back.
                console.warn(
                    "[searchlight:session] stored session didn't load:",
                    details.kind,
                );
                spectateIfCached();
                const painted = paintCached();
                setShowPicker(!painted);
                if (painted) restoreKept();
                if (details.kind === "signedOut") {
                    saySignInExpired();
                    return;
                }
                if (painted) keepCheckingSession(storedId, generation);
                sayLoadFellBack(deadline.signal.aborted, painted);
            },
        );

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
        // A spectator's copy never has the hider.
        const hider = session.role === "viewer" ? null : currentHiderMode;
        const kept: GameSessionSummary = {
            ...session,
            hiderLat: hider ? hider.latitude : null,
            hiderLng: hider ? hider.longitude : null,
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

    // One session load, as `generation` (see loadSession): returns whether the
    // server's state shows, its stream open.
    const runSessionLoad = useCallback(
        async (
            selected: GameSessionSummary,
            generation: number,
            userId: string,
        ): Promise<boolean> => {
            const isCurrent = () =>
                generation === sessionLoadGenerationRef.current;
            loadingGenerationRef.current = generation;
            sessionRecheck.stop();
            stopSSE();

            // Queue the outgoing session's pending edits durably right away;
            // their delivery (or retry) must not hold up the switch.
            const outgoingId = activeSessionId.get();
            if (outgoingId) flushSessionSaves(outgoingId);
            // A spectator's edits from before can't be sent or shown.
            if (selected.role === "viewer") discardSessionEdits(selected.id);

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

            // The copy kept here shows under the loading overlay until the
            // server's state replaces it. Without one, clear the atoms so the
            // outgoing session's content is never published.
            if (paintKeptCopy(selected.id)) {
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
            // The board shows this session's modes already. Unlike
            // !switchingSession, not on mount: the session's id was kept, but
            // its details (and modes) haven't been shown yet.
            const modesShown = activeSessionData.get()?.id === selected.id;
            let live = false;
            // Everything the load waits on the server for.
            const deadline = startLoadDeadline();

            try {
                // The server gets the edits queued here before its state is
                // read, so that state has them. Not for long: edits still
                // being sent then show on top of it, and send on.
                const flushWait = startLoadDeadline(FLUSH_WAIT_MS);
                await flushWait
                    .race(flushPendingEvents(selected.id))
                    .catch((err) => {
                        console.info(
                            "[searchlight:session] edits not all sent, reading the server's state anyway:",
                            err,
                        );
                    });
                flushWait.clear();
                if (!isCurrent()) return false;
                const {
                    questions: loadedQuestions,
                    strokes: loadedStrokes,
                    session: refreshedSession,
                    cursor: loadedCursor,
                    questionsSequence,
                } = await loadSessionContent(
                    selected.id,
                    userId,
                    deadline.signal,
                );
                if (!isCurrent()) return false;
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
                const game = { id: refreshedSession.gameId };
                const gameOptions = {
                    revisionId: refreshedSession.gameRevisionId,
                    sessionId: refreshedSession.id,
                };
                // A game still downloading by the deadline doesn't hold up
                // the server's state: the board goes live without it (the
                // banner says so), and the game shows once it lands.
                const definitionReady = await deadline
                    .race(switchToGame(game, gameOptions))
                    .catch(() => false);
                if (!isCurrent()) return false;
                if (refreshedSession.role === "viewer") {
                    discardSessionEdits(selected.id);
                }

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
                        userId,
                        visibility: refreshedSession.visibility,
                        questions: visibleQuestions,
                    });
                }
                showSessionModes(refreshedSession);
                startSSE(selected.id, (status) =>
                    forgetSession(selected.id, status),
                );
                live = true;
                boardIsKeptCopyRef.current = false;
            } catch (e: unknown) {
                if (!isCurrent()) return false;
                // Deleted, or closed to this user, since it was listed or
                // checked: forgotten before it shows, and so is the board it
                // was replacing.
                if (e instanceof SessionUnavailableError) {
                    if (switchingSession) clearActiveSession();
                    forgetSession(selected.id, e.status, selected);
                    return false;
                }
                const timedOut = deadline.signal.aborted;
                console.warn(
                    "[searchlight:session] failed to load session content:",
                    e,
                );
                const restoredFromCache = paintKeptCopy(selected.id);
                if (restoredFromCache) {
                    // The session is authorized, so its game may still come
                    // from the copy kept here: waited for while the load has
                    // time left, else the banner shows until it has loaded.
                    // Its modes stay as shown, if they are: `selected` may be
                    // older than an edit the flush just sent.
                    if (!modesShown) showSessionModes(selected);
                    const keptGame = switchToGame(
                        { id: selected.gameId },
                        {
                            revisionId: selected.gameRevisionId,
                            sessionId: selected.id,
                        },
                    );
                    if (!timedOut) {
                        await deadline.race(keptGame).catch(() => false);
                    }
                } else {
                    // No cache and no server — leave atoms empty, don't publish stale session content
                    boardSessionRef.current = null;
                    strokes.set([]);
                    questions.set([]);
                    if (switchingSession) {
                        // The outgoing session's hider and planning mode
                        // aren't this session's.
                        loadedHiderModeRef.current = false;
                        hiderMode.set(false);
                        loadedPlanningModeRef.current = false;
                        planningModeEnabled.set(false);
                    }
                }
                sayLoadFellBack(timedOut, restoredFromCache);
            } finally {
                deadline.clear();
            }
            if (!isCurrent()) return false;

            // Another session runs the question save effect again: what the
            // board shows now is no edit. (The same session doesn't, and the
            // flag would swallow the player's next edit.)
            if (switchingSession) suppressNextSaveRef.current = true;
            // Nothing set during the load may be saved, into either session.
            cancelPendingSaves();
            // The modes the board shows now are no change to save, when the
            // session changing runs the save effects again or a failed load
            // lets them save again.
            loadedHiderModeRef.current = hiderMode.get();
            loadedPlanningModeRef.current = planningModeEnabled.get();
            setActiveSession(sessionToActivate);
            // Released together with the session it was loading: the save
            // effects that run for it may save again.
            loadingGenerationRef.current = null;
            setShowPicker(false);
            return live;
        },
        [forgetSession],
    );

    // Every session load goes through here, and ends here however it ends:
    // its generation is released (saves and the background recheck wait while
    // it's set), the overlay goes, and a board left showing the copy kept here
    // is checked again until the server answers. Returns whether the server's
    // state shows (false also when another load took over).
    const loadSession = useCallback(
        async (selected: GameSessionSummary): Promise<boolean> => {
            if (!authUserId) return false;
            // What the picker passes on unchecked (a list entry, a session
            // just created) must be one, or the board is left on no session.
            if (!isSessionSummary(selected, selected?.id ?? "")) {
                console.warn("[searchlight:session] not a session:", selected);
                toast.error(LOAD_FAILED, { toastId: LOAD_TOAST_ID });
                return false;
            }
            const generation = ++sessionLoadGenerationRef.current;
            const isCurrent = () =>
                generation === sessionLoadGenerationRef.current;
            let live = false;
            try {
                live = await runSessionLoad(selected, generation, authUserId);
            } catch (err) {
                console.warn("[searchlight:session] load failed:", err);
                if (isCurrent()) {
                    toast.error(LOAD_FAILED, { toastId: LOAD_TOAST_ID });
                }
            } finally {
                if (loadingGenerationRef.current === generation) {
                    loadingGenerationRef.current = null;
                }
            }
            if (!isCurrent()) return false;
            setLoading(false);
            // A session forgotten as it loaded has no game to miss.
            setGameNotLoaded(
                Boolean(activeSessionId.get()) && !gameDefinitionReady.get(),
            );
            if (live) {
                sessionRecheck.reset();
                // A role change made before the stream opened (while the
                // game downloaded, say) wasn't sent on it.
                void checkSession(selected.id, false);
            } else if (
                boardSessionRef.current === selected.id &&
                activeSessionId.get() === selected.id
            ) {
                keepCheckingSession(selected.id, generation);
            }
            return live;
        },
        [authUserId, runSessionLoad],
    );

    // Load the session again, its game included. Fetching the session first
    // also covers an offline restore, which never got the session's details.
    const retryGameLoad = async () => {
        const id = activeSessionId.get();
        // As now: the effects that call this don't run again when it changes.
        if (offlineRef.current) {
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
        sessionRecheck.stop();
        setLoading(true);
        const deadline = startLoadDeadline(DETAILS_TIMEOUT_MS);
        const details = await fetchSessionDetails(id, deadline.signal);
        deadline.clear();
        if (!isCurrent()) return;
        setLoading(false);
        if (details.kind === "unavailable") {
            forgetSession(id, details.status);
            return;
        }
        if (details.kind === "signedOut") {
            console.warn("[searchlight:session] retry failed: signed out");
            saySignInExpired();
            return;
        }
        if (details.kind === "retry") {
            console.warn("[searchlight:session] retry failed");
            const showingKeptCopy =
                boardSessionRef.current === id && boardIsKeptCopyRef.current;
            sayLoadFellBack(deadline.signal.aborted, showingKeptCopy);
            if (showingKeptCopy) keepCheckingSession(id, generation);
            return;
        }
        // A load that didn't get the server's state says so itself.
        if (
            (await loadSession(details.session)) &&
            !gameDefinitionReady.get()
        ) {
            toast.error("The game still couldn't be loaded. Try again later.", {
                toastId: LOAD_TOAST_ID,
            });
        }
    };

    // The session the server sent has this user in another role than the
    // board's: a change made while the stream was down, whose live event was
    // missed. Load it again with that role. Becoming a spectator applies
    // right away, as in onRoleChanged below.
    const applyServerRole = (fresh: GameSessionSummary) => {
        if (fresh.id !== activeSessionId.get()) return;
        if (fresh.role === activeSessionRole.get()) return;
        console.info(
            "[searchlight:session] role is now",
            fresh.role,
            "on the server, reloading",
        );
        if (fresh.role === "viewer") becomeSpectator(fresh.id);
        void loadSession(fresh);
    };

    // Check the active session again: reload it if this user's role in it
    // changed, and with `forgetIfGone`, forget it if it's gone.
    const checkSession = async (id: string, forgetIfGone: boolean) => {
        // A load started meanwhile reads the session itself, and an answer
        // from before it (a role changed back since) mustn't undo it.
        const generation = sessionLoadGenerationRef.current;
        const details = await fetchSessionDetails(id);
        if (generation !== sessionLoadGenerationRef.current) return;
        if (activeSessionId.get() !== id) return;
        if (details.kind === "unavailable" && forgetIfGone) {
            forgetSession(id, details.status);
            return;
        }
        if (details.kind !== "ready" || isLoadingSession()) return;
        applyServerRole(details.session);
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
    // still there, so the board shows what the server has. A 403 to a
    // session that is still there means this user only spectates it now.
    useEffect(
        () =>
            handleRejectedEdits({
                isLoading: isLoadingSession,
                reload: () => void retryGameLoad(),
                confirmUnavailable: (id) => void checkSession(id, true),
            }),
        [forgetSession, loadSession],
    );

    // Whatever role the server gives, the cached copy keeps too, even when
    // loading the session's content then fails.
    useEffect(
        () =>
            activeSessionData.subscribe((data) => {
                if (data) cacheSessionRole(data.id, data.role);
            }),
        [],
    );

    // A role change made while the stream was down was missed: check the
    // session once it's back.
    useEffect(() => {
        const onReconnected = (event: Event) => {
            const { sessionId: reconnectedId } = (
                event as CustomEvent<SessionStreamReconnectedDetail>
            ).detail;
            if (reconnectedId !== activeSessionId.get()) return;
            if (isLoadingSession()) return;
            // Only the role: a stray 403 or 404 here (a captive portal, say)
            // mustn't forget the session and its unsent edits. The stream
            // finds out for itself if the session is really gone.
            void checkSession(reconnectedId, false);
        };
        window.addEventListener(
            SESSION_STREAM_RECONNECTED_EVENT,
            onReconnected,
        );
        return () =>
            window.removeEventListener(
                SESSION_STREAM_RECONNECTED_EVENT,
                onReconnected,
            );
    }, [forgetSession, loadSession]);

    // The creator made this user a player or a spectator of the active
    // session: load it again with the new role. Becoming a spectator applies
    // right away, so nothing more is saved or sent meanwhile, and the board
    // stays read-only if the reload fails.
    useEffect(() => {
        const onRoleChanged = (event: Event) => {
            const {
                sessionId: changedId,
                userId,
                role,
            } = (event as CustomEvent<SessionRoleChangedDetail>).detail;
            if (userId !== authUserId || changedId !== activeSessionId.get())
                return;
            console.info("[searchlight:session] role changed to", role);
            if (role === "viewer") becomeSpectator(changedId);
            void retryGameLoad();
        };
        window.addEventListener(SESSION_ROLE_CHANGED_EVENT, onRoleChanged);
        return () =>
            window.removeEventListener(
                SESSION_ROLE_CHANGED_EVENT,
                onRoleChanged,
            );
    }, [authUserId, forgetSession, loadSession]);

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
                    onSessionSelected={loadSession}
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
                    readOnly={readOnly}
                    onChangeSession={openPicker}
                    inert={showPicker}
                />
            )}
        </>
    );
}
