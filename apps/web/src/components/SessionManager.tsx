import { useStore } from "@nanostores/react";
import type {
    GameSessionSummary,
    ServersResponse,
    SessionsResponse,
} from "@searchlight/shared";
import { useCallback, useEffect, useRef, useState } from "react";

import { strokes } from "@/annotations/hooks/useAnnotationStore";
import { Button } from "@/components/ui/button";
import {
    compiledGameAtom,
    filterSupportedQuestions,
} from "@/game-definition/store";
import {
    activeSessionData,
    activeSessionId,
    clearActiveSession,
    setActiveSession,
    verifiedUserId,
} from "@/lib/activeSession";
import {
    gameDefinitionReady,
    pendingSessionLoad,
    questions,
    sidebarContextR,
} from "@/lib/context";
import { hiderMode, planningModeEnabled } from "@/lib/context";
import {
    applyUnsyncedEvents,
    discardSessionData,
    getCachedSession,
    setCachedSession,
} from "@/lib/eventQueue";
import {
    fetchGames,
    type GameOption,
    resolveSessionGame,
    switchToGame,
} from "@/lib/games";
import { shouldSuppressHiderSave } from "@/lib/hiderSaveSuppress";
import { shouldSuppressPlanningModeSave } from "@/lib/planningModeSaveSuppress";
import { isQuestionSaveSuppressed } from "@/lib/questionSaveSuppress";
import { readStorage, removeStorage } from "@/lib/safeStorage";
import {
    cancelPendingHiderSave,
    cancelPendingPlanningModeSave,
    cancelPendingQuestionSave,
    flushSavesOnPageExit,
    flushSessionSaves,
    loadSessionContent,
    saveHiderModeToServer,
    savePlanningModeToServer,
    saveQuestionsDebounced,
} from "@/lib/sessionState";
import { startSSE, stopSSE } from "@/lib/sseManager";
import { flushPendingEvents, startSyncManager } from "@/lib/syncManager";

const API_BASE = import.meta.env.PUBLIC_API_BASE as string;

// ── Session picker overlay ────────────────────────────────────────────────────

function SessionPickerOverlay({
    onSessionSelected,
}: {
    onSessionSelected: (session: GameSessionSummary) => void;
}) {
    const [servers, setServers] = useState<ServersResponse["servers"] | null>(
        null,
    );
    const [selectedServerId, setSelectedServerId] = useState<string>("");
    const [sessions, setSessions] = useState<GameSessionSummary[] | null>(null);
    const [availableGames, setAvailableGames] = useState<GameOption[]>([]);
    const [loadingServers, setLoadingServers] = useState(true);
    const [loadingSessions, setLoadingSessions] = useState(false);
    const [creatingSession, setCreatingSession] = useState(false);
    const [newSessionName, setNewSessionName] = useState("");
    const [newSessionGameId, setNewSessionGameId] = useState("");
    const [newSessionVisibility, setNewSessionVisibility] = useState<
        "private" | "shared"
    >("private");
    const [showCreateForm, setShowCreateForm] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [deletingId, setDeletingId] = useState<string | null>(null);
    const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
    const [leavingId, setLeavingId] = useState<string | null>(null);
    const [confirmLeaveId, setConfirmLeaveId] = useState<string | null>(null);
    const loadSessionsReqRef = useRef(0);

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

    const loadSessionsForServer = useCallback(async (serverId: string) => {
        const reqId = ++loadSessionsReqRef.current;
        setLoadingSessions(true);
        setSessions(null);
        setError(null);
        try {
            const [sessRes, games] = await Promise.all([
                fetch(`${API_BASE}/sessions?serverId=${serverId}`, {
                    credentials: "include",
                }),
                fetchGames(serverId),
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
    }, []);

    useEffect(() => {
        if (selectedServerId) loadSessionsForServer(selectedServerId);
    }, [selectedServerId, loadSessionsForServer]);

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
            discardSessionData(sessionId);
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
                    visibility: newSessionVisibility,
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

    return (
        <div className="fixed inset-0 z-[9000] flex items-center justify-center bg-background/95 backdrop-blur-sm">
            <div className="w-full max-w-md mx-4 bg-card border border-border rounded-xl shadow-xl p-6">
                <h1 className="text-xl font-bold mb-1">Select a Session</h1>
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

                {loadingSessions && (
                    <p className="text-sm text-muted-foreground">
                        Loading sessions…
                    </p>
                )}

                {sessions !== null && (
                    <div className="mb-2">
                        {sessions.length === 0 ? (
                            <p className="text-sm text-muted-foreground italic mb-3">
                                No sessions yet. Create one below.
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

                        {!showCreateForm ? (
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
                                                    {g.label}
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
                                <div>
                                    <label className="text-xs text-muted-foreground block mb-1">
                                        Visibility
                                    </label>
                                    <div className="flex gap-3 text-sm">
                                        {(["private", "shared"] as const).map(
                                            (v) => (
                                                <label
                                                    key={v}
                                                    className="flex items-center gap-1.5 cursor-pointer"
                                                >
                                                    <input
                                                        type="radio"
                                                        name="visibility"
                                                        value={v}
                                                        checked={
                                                            newSessionVisibility ===
                                                            v
                                                        }
                                                        onChange={() =>
                                                            setNewSessionVisibility(
                                                                v,
                                                            )
                                                        }
                                                    />
                                                    <span className="capitalize">
                                                        {v}
                                                    </span>
                                                </label>
                                            ),
                                        )}
                                    </div>
                                </div>
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

// ── Session chip (active state) ───────────────────────────────────────────────

function SessionChip({
    session,
    onChangeSession,
}: {
    session: GameSessionSummary;
    onChangeSession: () => void;
}) {
    const sidebar = useStore(sidebarContextR);
    const right = sidebar.open ? "calc(16rem + 3.5rem)" : "3.5rem";

    return (
        <div
            className="fixed top-10 z-[1041] flex items-center gap-2 bg-background/90 border border-border rounded-full px-3 py-1 text-xs shadow-sm backdrop-blur-sm transition-[right] duration-200 ease-linear"
            style={{ right }}
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
    );
}

// ── Main component ────────────────────────────────────────────────────────────

export function SessionManager() {
    const authUserId = useStore(verifiedUserId);
    const sessionId = useStore(activeSessionId);
    const session = useStore(activeSessionData);
    const currentQuestions = useStore(questions);
    const currentHiderMode = useStore(hiderMode);
    const currentPlanningMode = useStore(planningModeEnabled);
    const [showPicker, setShowPicker] = useState(false);
    const [loading, setLoading] = useState(false);
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

    // Debounce-save questions whenever they change (while a session is active).
    // Skip the first fire after a server load to avoid overwriting fresh server data.
    useEffect(() => {
        if (!sessionId || !authUserId) return;
        if (suppressNextSaveRef.current) {
            suppressNextSaveRef.current = false;
            return;
        }
        if (isQuestionSaveSuppressed(currentQuestions)) {
            console.info(
                "[searchlight:session] suppressing save — questions were set by SSE or game filtering",
            );
            return;
        }
        if (isLoadingSession()) {
            console.info(
                "[searchlight:session] suppressing save — session is loading",
            );
            return;
        }
        saveQuestionsDebounced(sessionId, currentQuestions);
    }, [sessionId, authUserId, currentQuestions]);

    // Debounce-save hider mode whenever it changes (while a session is active).
    useEffect(() => {
        if (!sessionId || !authUserId) return;
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
        if (!sessionId || !authUserId) return;
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
                discardSessionData(sessionId);
            }
            // Edits still waiting to be queued can never be delivered either.
            cancelPendingQuestionSave(sessionId);
            cancelPendingHiderSave(sessionId);
            cancelPendingPlanningModeSave(sessionId);
            if (activeSessionId.get() === sessionId) clearActiveSession();
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
        cancelPendingQuestionSave();

        // Handle pending link from /join page
        const pendingToken = readStorage("localStorage", "taibled-pending-link");
        const pendingLinkSession = readStorage(
            "localStorage",
            "taibled-pending-link-session",
        );
        if (pendingToken) {
            removeStorage("localStorage", "taibled-pending-link");
            setLoading(true);
            fetch(`${API_BASE}/links/${pendingToken}/redeem`, {
                method: "POST",
                credentials: "include",
            })
                .then(async (res) => {
                    if (!isCurrent()) return;
                    if (!res.ok) throw new Error(`${res.status}`);
                    const { sessionId: redeemedId } = (await res.json()) as {
                        sessionId: string;
                    };
                    const sessRes = await fetch(
                        `${API_BASE}/sessions/${redeemedId}`,
                        { credentials: "include" },
                    );
                    if (!sessRes.ok) throw new Error("session fetch failed");
                    const selected: GameSessionSummary = await sessRes.json();
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

        const returnTo = readStorage("localStorage", "taibled-return-to");
        if (returnTo) {
            removeStorage("localStorage", "taibled-return-to");
            window.location.href = returnTo;
            return cleanup;
        }

        const storedId = activeSessionId.get();
        if (!storedId) {
            setShowPicker(true);
            return cleanup;
        }

        // The cached owner must match /me, and the session must be authorized
        // before private content becomes visible. Retain offline access for the
        // same verified account if the session request itself fails.
        const cached = getCachedSession(storedId);
        const canPaintCache = Boolean(cached && cached.userId === authUserId);
        // The loading overlay stays up over the painted cache until the
        // reconcile below finishes: it replaces the board, so an edit made
        // in between could not be kept (and must not be saved over fresher
        // server state).
        const paintCached = () => {
            if (!canPaintCache || !cached) return false;
            const derived = applyUnsyncedEvents(storedId, cached);
            gameDefinitionReady.set(false);
            suppressNextSaveRef.current = true;
            strokes.set(derived.strokes);
            questions.set(derived.questions);
            return true;
        };
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
                if (!res.ok) throw new Error(`session fetch failed: ${res.status}`);
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
                    } = await loadSessionContent(storedId, authUserId);
                    if (!isCurrent()) return;
                    const targetGame = await resolveSessionGame(refreshedSession);
                    if (!isCurrent()) return;
                    const definitionReady = await switchToGame(targetGame, {
                        revisionId: refreshedSession.gameRevisionId,
                        sessionId: refreshedSession.id,
                    });
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
                    const visibleQuestions = definitionReady
                        ? filterSupportedQuestions(
                              reconciled.questions,
                              compiledGameAtom.get(),
                          )
                        : reconciled.questions;
                    console.info(
                        "[searchlight:session] reconciled",
                        visibleQuestions.length,
                        "question(s) from server",
                    );
                    suppressNextSaveRef.current = true;
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
                    const newHiderMode =
                        refreshedSession.hiderLat != null &&
                        refreshedSession.hiderLng != null
                            ? {
                                  latitude: refreshedSession.hiderLat,
                                  longitude: refreshedSession.hiderLng,
                              }
                            : false;
                    // Only suppress if the atom will actually change. If both old and new
                    // are false, nanostores won't fire and the ref would stay true forever,
                    // silently swallowing the next legit user-initiated hider save.
                    if (newHiderMode !== false || hiderMode.get() !== false) {
                        suppressNextHiderSaveRef.current = true;
                    }
                    hiderMode.set(newHiderMode);
                    const newPlanningMode =
                        refreshedSession.planningModeEnabled ?? false;
                    if (planningModeEnabled.get() !== newPlanningMode) {
                        suppressNextPlanningModeRef.current = true;
                    }
                    planningModeEnabled.set(newPlanningMode);
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
                } finally {
                    if (isCurrent()) loadingGenerationRef.current = null;
                }
            })
            .catch((e) => {
                if (!isCurrent()) return;
                console.warn("[searchlight:session] session fetch error:", e);
                // Keep the pointer even without a cache to show, so the next
                // load can restore the session once the server is back.
                setShowPicker(!paintCached());
            })
            .finally(() => {
                if (isCurrent()) setLoading(false);
            });

        return cleanup;
    }, [authUserId]);

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

            // Check local cache for instant paint. If not cached, clear atoms so stale
            // content from the outgoing session is never published.
            const cached = getCachedSession(selected.id);
            const canPaintCache = Boolean(
                cached && cached.userId === authUserId,
            );
            if (canPaintCache && cached) {
                const derived = applyUnsyncedEvents(selected.id, cached);
                // As in the stored-session restore above, the board is shown
                // under the loading overlay until the server state replaces it,
                // and nothing is evaluated before the game definition loads.
                gameDefinitionReady.set(false);
                suppressNextSaveRef.current = true;
                strokes.set(derived.strokes);
                questions.set(derived.questions);
                console.info(
                    "[searchlight:session] painted from cache, loading server state",
                );
            } else {
                gameDefinitionReady.set(false);
                suppressNextSaveRef.current = true;
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
                } = await loadSessionContent(selected.id, authUserId);
                if (!isCurrent()) return;
                sessionToActivate = refreshedSession;

                const targetGame = await resolveSessionGame(refreshedSession);
                if (!isCurrent()) return;
                console.info(
                    "[searchlight:session] applying game",
                    targetGame.label,
                );
                const definitionReady = await switchToGame(targetGame, {
                    revisionId: refreshedSession.gameRevisionId,
                    sessionId: refreshedSession.id,
                });
                if (!isCurrent()) return;

                // Reconcile any remaining pending events that were not flushed
                const reconciledState = applyUnsyncedEvents(selected.id, {
                    strokes: loadedStrokes,
                    questions: loadedQuestions,
                });

                strokes.set(reconciledState.strokes);
                const visibleQuestions = definitionReady
                    ? filterSupportedQuestions(
                          reconciledState.questions,
                          compiledGameAtom.get(),
                      )
                    : reconciledState.questions;
                console.info(
                    "[searchlight:session] loaded",
                    visibleQuestions.length,
                    "question(s) from server",
                );
                suppressNextSaveRef.current = true;
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
                const newHiderMode =
                    refreshedSession.hiderLat != null &&
                    refreshedSession.hiderLng != null
                        ? {
                              latitude: refreshedSession.hiderLat,
                              longitude: refreshedSession.hiderLng,
                          }
                        : false;
                if (newHiderMode !== false || hiderMode.get() !== false) {
                    suppressNextHiderSaveRef.current = true;
                }
                hiderMode.set(newHiderMode);
                const newPlanningMode =
                    refreshedSession.planningModeEnabled ?? false;
                if (planningModeEnabled.get() !== newPlanningMode) {
                    suppressNextPlanningModeRef.current = true;
                }
                planningModeEnabled.set(newPlanningMode);
                startSSE(selected.id, (status) =>
                    forgetSession(selected.id, status),
                );
            } catch (e: unknown) {
                if (!isCurrent()) return;
                console.warn(
                    "[searchlight:session] failed to load session content:",
                    e,
                );
                if (canPaintCache && cached) {
                    // Offline fallback: replay pending events on top of cached snapshot
                    const derived = applyUnsyncedEvents(selected.id, cached);
                    suppressNextSaveRef.current = true;
                    strokes.set(derived.strokes);
                    questions.set(derived.questions);
                } else {
                    // No cache and no server — leave atoms empty, don't publish stale session content
                    strokes.set([]);
                    questions.set([]);
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
        },
        [authUserId, forgetSession],
    );

    // Listen for invite-accept session loads from InviteDrawer (separate island).
    useEffect(() => {
        return pendingSessionLoad.listen(async (sessionId) => {
            if (!sessionId) return;
            const generation = ++sessionLoadGenerationRef.current;
            pendingSessionLoad.set(null);
            try {
                const res = await fetch(`${API_BASE}/sessions/${sessionId}`, {
                    credentials: "include",
                });
                if (!res.ok) return;
                const data: GameSessionSummary = await res.json();
                if (generation !== sessionLoadGenerationRef.current) return;
                await handleSessionSelected(data);
            } catch (e) {
                console.warn(
                    "[searchlight:session] invite-triggered load failed:",
                    e,
                );
            }
        });
    }, [handleSessionSelected]);

    if (loading) {
        return (
            <div className="fixed inset-0 z-[9000] flex items-center justify-center bg-background/80">
                <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            </div>
        );
    }

    return (
        <>
            {showPicker && (
                <SessionPickerOverlay
                    onSessionSelected={handleSessionSelected}
                />
            )}
            {!showPicker && session && (
                <SessionChip
                    session={session}
                    onChangeSession={() => setShowPicker(true)}
                />
            )}
        </>
    );
}
