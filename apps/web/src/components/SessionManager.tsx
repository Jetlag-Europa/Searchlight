import { useEffect, useState, useCallback, useRef } from "react";
import { useStore } from "@nanostores/react";
import type { ServersResponse, SessionsResponse, GameSessionSummary } from "@taibled/shared";
import { questions, sidebarContextR, pendingSessionLoad } from "@/lib/context";
import {
    activeSessionId,
    activeSessionData,
    setActiveSession,
    clearActiveSession,
} from "@/lib/activeSession";
import {
    fetchGames,
    switchToGame,
    getGameById,
    type GameDefinition,
} from "@/lib/games";
import { loadSessionContent, saveQuestionsDebounced, cancelPendingQuestionSave, cancelPendingHiderSave, saveHiderModeToServer, flushHiderSave, savePlanningModeToServer, cancelPendingPlanningModeSave } from "@/lib/sessionState";
import { shouldSuppressQuestionSave } from "@/lib/questionSaveSuppress";
import { shouldSuppressHiderSave } from "@/lib/hiderSaveSuppress";
import { shouldSuppressPlanningModeSave } from "@/lib/planningModeSaveSuppress";
import { hiderMode, planningModeEnabled } from "@/lib/context";
import {
    getCachedSession,
    getPendingEvents,
    applyPendingEventsToState,
} from "@/lib/eventQueue";
import { startSyncManager, flushPendingEvents } from "@/lib/syncManager";
import { startSSE, stopSSE } from "@/lib/sseManager";
import { strokes } from "@/annotations/hooks/useAnnotationStore";
import { Button } from "@/components/ui/button";

const API_BASE = import.meta.env.PUBLIC_API_BASE as string;

// ── Session picker overlay ────────────────────────────────────────────────────

function SessionPickerOverlay({
    onSessionSelected,
}: {
    onSessionSelected: (session: GameSessionSummary) => void;
}) {
    const [servers, setServers] = useState<ServersResponse["servers"] | null>(null);
    const [selectedServerId, setSelectedServerId] = useState<string>("");
    const [sessions, setSessions] = useState<GameSessionSummary[] | null>(null);
    const [availableGames, setAvailableGames] = useState<GameDefinition[]>([]);
    const [loadingServers, setLoadingServers] = useState(true);
    const [loadingSessions, setLoadingSessions] = useState(false);
    const [creatingSession, setCreatingSession] = useState(false);
    const [newSessionName, setNewSessionName] = useState("");
    const [newSessionGameId, setNewSessionGameId] = useState("");
    const [newSessionVisibility, setNewSessionVisibility] = useState<"private" | "shared">("private");
    const [showCreateForm, setShowCreateForm] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [deletingId, setDeletingId] = useState<string | null>(null);
    const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
    const [leavingId, setLeavingId] = useState<string | null>(null);
    const [confirmLeaveId, setConfirmLeaveId] = useState<string | null>(null);

    useEffect(() => {
        fetch(`${API_BASE}/servers`, { credentials: "include" })
            .then(async (res) => {
                if (!res.ok) throw new Error(`${res.status}`);
                const data: ServersResponse = await res.json();
                setServers(data.servers);
                if (data.servers.length === 1) {
                    setSelectedServerId(data.servers[0].id);
                }
            })
            .catch((e: Error) => setError(`Failed to load servers: ${e.message}`))
            .finally(() => setLoadingServers(false));
    }, []);

    const loadSessionsForServer = useCallback(async (serverId: string) => {
        setLoadingSessions(true);
        setSessions(null);
        setError(null);
        try {
            const [sessRes, games] = await Promise.all([
                fetch(`${API_BASE}/sessions?serverId=${serverId}`, { credentials: "include" }),
                fetchGames(serverId),
            ]);
            if (!sessRes.ok) throw new Error(`${sessRes.status}`);
            const data: SessionsResponse = await sessRes.json();
            setSessions(data.sessions);
            setAvailableGames(games);
            setNewSessionGameId(games.length > 0 ? games[0].id : "");
        } catch (e: unknown) {
            setError(`Failed to load sessions: ${(e as Error).message}`);
        } finally {
            setLoadingSessions(false);
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
            setSessions((prev) => prev?.filter((s) => s.id !== sessionId) ?? null);
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
            setSessions((prev) => prev?.filter((s) => s.id !== sessionId) ?? null);
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
                    Choose an existing session or create a new one to get started.
                </p>

                {error && (
                    <p className="text-sm text-destructive mb-4 p-3 bg-destructive/10 rounded-md">{error}</p>
                )}

                {loadingServers && (
                    <p className="text-sm text-muted-foreground">Loading servers…</p>
                )}

                {servers && servers.length > 1 && (
                    <div className="mb-4">
                        <label className="text-sm font-medium block mb-1">Server</label>
                        <select
                            className="w-full border border-input rounded-md px-3 py-2 text-sm bg-background"
                            value={selectedServerId}
                            onChange={(e) => setSelectedServerId(e.target.value)}
                        >
                            <option value="">— pick a server —</option>
                            {servers.map((s) => (
                                <option key={s.id} value={s.id}>{s.name}</option>
                            ))}
                        </select>
                    </div>
                )}

                {loadingSessions && (
                    <p className="text-sm text-muted-foreground">Loading sessions…</p>
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
                                            if (confirmDeleteId === session.id) setConfirmDeleteId(null);
                                            if (confirmLeaveId === session.id) setConfirmLeaveId(null);
                                        }}
                                    >
                                        <button
                                            onClick={() => onSessionSelected(session)}
                                            className="flex-1 text-left p-3 min-w-0"
                                        >
                                            <div className="font-medium text-sm truncate">{session.name}</div>
                                            <div className="text-xs text-muted-foreground mt-0.5">
                                                {session.gameName} ·{" "}
                                                <span className="capitalize">{session.visibility}</span> ·{" "}
                                                <span className="capitalize">{session.role}</span>
                                            </div>
                                        </button>
                                        {session.role === "creator" && (
                                            <button
                                                onClick={() => handleDeleteSession(session.id)}
                                                disabled={deletingId === session.id}
                                                className={`shrink-0 px-3 py-1 mr-1 rounded-md text-xs transition-colors ${
                                                    confirmDeleteId === session.id
                                                        ? "text-destructive hover:bg-destructive/10 font-medium"
                                                        : "text-muted-foreground hover:text-destructive opacity-0 group-hover/row:opacity-100"
                                                }`}
                                                title={confirmDeleteId === session.id ? "Click again to confirm" : "Delete session"}
                                            >
                                                {deletingId === session.id ? "…" : confirmDeleteId === session.id ? "Confirm?" : "✕"}
                                            </button>
                                        )}
                                        {session.role === "member" && (
                                            <button
                                                onClick={() => handleLeaveSession(session.id)}
                                                disabled={leavingId === session.id}
                                                className={`shrink-0 px-3 py-1 mr-1 rounded-md text-xs transition-colors ${
                                                    confirmLeaveId === session.id
                                                        ? "text-destructive hover:bg-destructive/10 font-medium"
                                                        : "text-muted-foreground hover:text-destructive opacity-0 group-hover/row:opacity-100"
                                                }`}
                                                title={confirmLeaveId === session.id ? "Click again to confirm" : "Leave session"}
                                            >
                                                {leavingId === session.id ? "…" : confirmLeaveId === session.id ? "Confirm?" : "Leave"}
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
                                <p className="text-sm font-medium">New session</p>
                                <div>
                                    <label className="text-xs text-muted-foreground block mb-1">Name</label>
                                    <input
                                        type="text"
                                        placeholder="e.g. Planning A"
                                        className="w-full border border-input rounded-md px-3 py-1.5 text-sm bg-background"
                                        value={newSessionName}
                                        onChange={(e) => setNewSessionName(e.target.value)}
                                        onKeyDown={(e) => e.key === "Enter" && handleCreateSession()}
                                    />
                                </div>
                                {availableGames.length >= 1 ? (
                                    <div>
                                        <label className="text-xs text-muted-foreground block mb-1">Game</label>
                                        <select
                                            className="w-full border border-input rounded-md px-3 py-1.5 text-sm bg-background"
                                            value={newSessionGameId}
                                            onChange={(e) => setNewSessionGameId(e.target.value)}
                                        >
                                            {availableGames.map((g) => (
                                                <option key={g.id} value={g.id}>{g.label}</option>
                                            ))}
                                        </select>
                                    </div>
                                ) : (
                                    <p className="text-xs text-muted-foreground italic">
                                        No games available for this server — sessions cannot be created.
                                    </p>
                                )}
                                <div>
                                    <label className="text-xs text-muted-foreground block mb-1">Visibility</label>
                                    <div className="flex gap-3 text-sm">
                                        {(["private", "shared"] as const).map((v) => (
                                            <label key={v} className="flex items-center gap-1.5 cursor-pointer">
                                                <input
                                                    type="radio"
                                                    name="visibility"
                                                    value={v}
                                                    checked={newSessionVisibility === v}
                                                    onChange={() => setNewSessionVisibility(v)}
                                                />
                                                <span className="capitalize">{v}</span>
                                            </label>
                                        ))}
                                    </div>
                                </div>
                                <div className="flex gap-2">
                                    <Button
                                        size="sm"
                                        onClick={handleCreateSession}
                                        disabled={creatingSession || !newSessionName.trim() || !newSessionGameId}
                                    >
                                        {creatingSession ? "Creating…" : "Create"}
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
            <span className="font-medium truncate max-w-[140px]" title={session.name}>{session.name}</span>
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
    const sessionId = useStore(activeSessionId);
    const session = useStore(activeSessionData);
    const currentQuestions = useStore(questions);
    const currentHiderMode = useStore(hiderMode);
    const currentPlanningMode = useStore(planningModeEnabled);
    const [showPicker, setShowPicker] = useState(false);
    const [loading, setLoading] = useState(false);
    // Prevents saving questions immediately after we just loaded them from the server.
    const suppressNextSaveRef = useRef(false);
    // Start suppressed: always wait for the server load before allowing any hider saves.
    const suppressNextHiderSaveRef = useRef(true);
    // Start suppressed: always wait for the server load before allowing planning mode saves.
    const suppressNextPlanningModeRef = useRef(true);

    // Debounce-save questions whenever they change (while a session is active).
    // Skip the first fire after a server load to avoid overwriting fresh server data.
    useEffect(() => {
        if (!sessionId) return;
        if (suppressNextSaveRef.current) {
            suppressNextSaveRef.current = false;
            return;
        }
        if (shouldSuppressQuestionSave()) {
            console.info("[taibled:session] suppressing save — questions were set by SSE");
            return;
        }
        saveQuestionsDebounced(sessionId, currentQuestions);
    }, [sessionId, currentQuestions]);

    // Debounce-save hider mode whenever it changes (while a session is active).
    useEffect(() => {
        if (!sessionId) return;
        if (suppressNextHiderSaveRef.current) {
            suppressNextHiderSaveRef.current = false;
            console.info("[taibled:session] hider save suppressed by ref", { sessionId, hiderMode: currentHiderMode });
            return;
        }
        if (shouldSuppressHiderSave()) {
            console.info("[taibled:session] hider save suppressed by SSE counter", { sessionId, hiderMode: currentHiderMode });
            return;
        }
        console.info("[taibled:session] queuing hider save", { sessionId, hiderMode: currentHiderMode });
        saveHiderModeToServer(sessionId, currentHiderMode);
    }, [sessionId, currentHiderMode]);

    // Debounce-save planning mode whenever it changes (while a session is active).
    useEffect(() => {
        if (!sessionId) return;
        if (suppressNextPlanningModeRef.current) {
            suppressNextPlanningModeRef.current = false;
            console.info("[taibled:session] planning mode save suppressed by ref", { sessionId, planningModeEnabled: currentPlanningMode });
            return;
        }
        if (shouldSuppressPlanningModeSave()) {
            console.info("[taibled:session] planning mode save suppressed by SSE counter", { sessionId, planningModeEnabled: currentPlanningMode });
            return;
        }
        console.info("[taibled:session] queuing planning mode save", { sessionId, planningModeEnabled: currentPlanningMode });
        savePlanningModeToServer(sessionId, currentPlanningMode);
    }, [sessionId, currentPlanningMode]);

    // Flush any pending hider save when the tab closes so the debounce timer
    // isn't killed by the browser before it fires.
    useEffect(() => {
        const handleBeforeUnload = () => {
            const id = activeSessionId.get();
            if (id) {
                console.info("[taibled:session] beforeunload — flushing hider save for", id);
                flushHiderSave(id, hiderMode.get());
            }
        };
        window.addEventListener("beforeunload", handleBeforeUnload);
        return () => window.removeEventListener("beforeunload", handleBeforeUnload);
    }, []);

    // On mount: start sync manager and restore or show picker
    useEffect(() => {
        startSyncManager();
        cancelPendingQuestionSave();

        // Handle pending link from /join page
        const pendingToken = localStorage.getItem("taibled-pending-link");
        const pendingLinkSession = localStorage.getItem("taibled-pending-link-session");
        if (pendingToken) {
            localStorage.removeItem("taibled-pending-link");
            setLoading(true);
            fetch(`${API_BASE}/links/${pendingToken}/redeem`, { method: "POST", credentials: "include" })
                .then(async (res) => {
                    if (!res.ok) throw new Error(`${res.status}`);
                    const { sessionId: redeemedId } = await res.json() as { sessionId: string };
                    const sessRes = await fetch(`${API_BASE}/sessions/${redeemedId}`, { credentials: "include" });
                    if (!sessRes.ok) throw new Error("session fetch failed");
                    setLoading(false);
                    await handleSessionSelected(await sessRes.json() as GameSessionSummary);
                })
                .catch(() => { setLoading(false); setShowPicker(true); });
            return () => stopSSE();
        }
        if (pendingLinkSession) {
            localStorage.removeItem("taibled-pending-link-session");
            setLoading(true);
            fetch(`${API_BASE}/sessions/${pendingLinkSession}`, { credentials: "include" })
                .then(async (res) => {
                    if (!res.ok) throw new Error(`${res.status}`);
                    setLoading(false);
                    await handleSessionSelected(await res.json() as GameSessionSummary);
                })
                .catch(() => { setLoading(false); setShowPicker(true); });
            return () => stopSSE();
        }

        const returnTo = localStorage.getItem("taibled-return-to");
        if (returnTo) {
            localStorage.removeItem("taibled-return-to");
            window.location.href = returnTo;
            return () => stopSSE();
        }

        const storedId = activeSessionId.get();
        if (!storedId) {
            setShowPicker(true);
            return () => stopSSE();
        }

        // Try local cache first for instant paint; validate session in background.
        const cached = getCachedSession(storedId);
        if (cached) {
            const pending = getPendingEvents(storedId).filter((e) => e.status === "pending");
            const derived = applyPendingEventsToState(
                { strokes: cached.strokes, questions: cached.questions },
                pending,
            );
            suppressNextSaveRef.current = true;
            strokes.set(derived.strokes);
            questions.set(derived.questions);
            console.info("[taibled:session] restored from cache:", storedId, `(${pending.length} pending)`);
        } else {
            setLoading(true);
        }

        console.info("[taibled:session] validating stored session", storedId);
        fetch(`${API_BASE}/sessions/${storedId}`, { credentials: "include" })
            .then(async (res) => {
                if (!res.ok) {
                    console.warn("[taibled:session] stored session invalid (" + res.status + "), showing picker");
                    clearActiveSession();
                    setShowPicker(true);
                    return;
                }
                const data: GameSessionSummary = await res.json();
                const games = await fetchGames(data.serverId);
                const game = games.find((g) => g.id === data.gameId) ?? getGameById(data.gameId);
                if (game) { console.info("[taibled:session] applying game", game.label); switchToGame(game); }

                cancelPendingHiderSave();
                cancelPendingPlanningModeSave();
                // storedId === data.id always here (we fetched by storedId), so
                // activeSessionId won't change — no suppress needed for sessionId effect.
                setActiveSession(data);
                setShowPicker(false);

                // Always reconcile from server: flush pending first so server has the
                // latest state, then load authoritative content. On cache hit this runs
                // in the background (user already sees painted state); on cache miss this
                // is the first paint. Errors are swallowed so cached state is preserved
                // when offline.
                try {
                    await flushPendingEvents(storedId);
                    const { questions: serverQs } = await loadSessionContent(storedId);
                    console.info("[taibled:session] reconciled", serverQs.length, "question(s) from server");
                    suppressNextSaveRef.current = true;
                    questions.set(serverQs);
                    const newHiderMode =
                        data.hiderLat != null && data.hiderLng != null
                            ? { latitude: data.hiderLat, longitude: data.hiderLng }
                            : false;
                    // Only suppress if the atom will actually change. If both old and new
                    // are false, nanostores won't fire and the ref would stay true forever,
                    // silently swallowing the next legit user-initiated hider save.
                    if (newHiderMode !== false || hiderMode.get() !== false) {
                        suppressNextHiderSaveRef.current = true;
                    }
                    hiderMode.set(newHiderMode);
                    const newPlanningMode = data.planningModeEnabled ?? false;
                    if (planningModeEnabled.get() !== newPlanningMode) {
                        suppressNextPlanningModeRef.current = true;
                    }
                    planningModeEnabled.set(newPlanningMode);
                    startSSE(storedId);
                } catch (e) {
                    console.warn(
                        cached
                            ? "[taibled:session] background reconcile failed, keeping cached state"
                            : "[taibled:session] content load failed",
                        e,
                    );
                }
            })
            .catch((e) => {
                console.warn("[taibled:session] session fetch error:", e);
                if (!cached) {
                    clearActiveSession();
                    setShowPicker(true);
                } else {
                    // We have cached state — stay in it, just skip picker.
                    setShowPicker(false);
                }
            })
            .finally(() => setLoading(false));

        return () => stopSSE();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const handleSessionSelected = useCallback(async (selected: GameSessionSummary) => {
        stopSSE();
        cancelPendingQuestionSave();

        // Flush any pending hider save for the outgoing session immediately so it
        // isn't silently dropped by the 800ms debounce when switching sessions.
        const outgoingId = activeSessionId.get();
        if (outgoingId) {
            flushHiderSave(outgoingId, hiderMode.get());
        }

        console.info("[taibled:session] selecting session", selected.id, selected.name);

        // Check local cache for instant paint.
        const cached = getCachedSession(selected.id);
        if (cached) {
            const pending = getPendingEvents(selected.id).filter((e) => e.status === "pending");
            const derived = applyPendingEventsToState(
                { strokes: cached.strokes, questions: cached.questions },
                pending,
            );
            suppressNextSaveRef.current = true;
            strokes.set(derived.strokes);
            questions.set(derived.questions);
            console.info("[taibled:session] painted from cache, loading server state in background");
        } else {
            setLoading(true);
        }

        try {
            const [{ questions: loadedQuestions }, games] = await Promise.all([
                loadSessionContent(selected.id),
                fetchGames(selected.serverId),
            ]);
            console.info("[taibled:session] loaded", loadedQuestions.length, "question(s) from server");
            suppressNextSaveRef.current = true;
            questions.set(loadedQuestions);
            const game = games.find((g) => g.id === selected.gameId);
            if (game) { console.info("[taibled:session] applying game", game.label); switchToGame(game); }
            const newHiderMode =
                selected.hiderLat != null && selected.hiderLng != null
                    ? { latitude: selected.hiderLat, longitude: selected.hiderLng }
                    : false;
            if (newHiderMode !== false || hiderMode.get() !== false) {
                suppressNextHiderSaveRef.current = true;
            }
            hiderMode.set(newHiderMode);
            const newPlanningMode = selected.planningModeEnabled ?? false;
            if (planningModeEnabled.get() !== newPlanningMode) {
                suppressNextPlanningModeRef.current = true;
            }
            planningModeEnabled.set(newPlanningMode);
            // Flush any pending events for this session, then start live channel.
            flushPendingEvents(selected.id).catch(() => {});
            startSSE(selected.id);
        } catch (e: unknown) {
            console.warn("[taibled:session] failed to load session content:", e);
            if (!cached) {
                // No cache and no server — leave atoms empty, still enter session.
            }
        } finally {
            setLoading(false);
        }

        // Suppress save effects that fire when sessionId changes — state was just
        // loaded from the server so there's nothing new to write back.
        suppressNextSaveRef.current = true;
        cancelPendingHiderSave();
        cancelPendingPlanningModeSave();
        // Only suppress the sessionId-change hider effect if the session is
        // actually changing — same-session re-selects don't fire the effect.
        if (activeSessionId.get() !== selected.id) {
            suppressNextHiderSaveRef.current = true;
            suppressNextPlanningModeRef.current = true;
        }
        setActiveSession(selected);
        setShowPicker(false);
    }, []);

    // Listen for invite-accept session loads from InviteDrawer (separate island).
    useEffect(() => {
        return pendingSessionLoad.listen(async (sessionId) => {
            if (!sessionId) return;
            pendingSessionLoad.set(null);
            try {
                const res = await fetch(`${API_BASE}/sessions/${sessionId}`, { credentials: "include" });
                if (!res.ok) return;
                const data: GameSessionSummary = await res.json();
                await handleSessionSelected(data);
            } catch (e) {
                console.warn("[taibled:session] invite-triggered load failed:", e);
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
                <SessionPickerOverlay onSessionSelected={handleSessionSelected} />
            )}
            {!showPicker && session && (
                <SessionChip session={session} onChangeSession={() => setShowPicker(true)} />
            )}
        </>
    );
}
