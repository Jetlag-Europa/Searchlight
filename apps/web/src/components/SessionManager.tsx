import { useEffect, useState, useCallback, useRef } from "react";
import { useStore } from "@nanostores/react";
import type { ServersResponse, SessionsResponse, GameSessionSummary } from "@taibled/shared";
import { questions, sidebarContextR } from "@/lib/context";
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
import { loadSessionContent, saveQuestionsDebounced } from "@/lib/sessionState";
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
            if (games.length > 0 && !newSessionGameId) {
                setNewSessionGameId(games[0].id);
            }
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
                                {availableGames.length > 1 && (
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
                                        disabled={creatingSession || !newSessionName.trim()}
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
    const [showPicker, setShowPicker] = useState(false);
    const [loading, setLoading] = useState(false);
    // Prevents saving questions immediately after we just loaded them from the server.
    const suppressNextSaveRef = useRef(false);

    // Debounce-save questions whenever they change (while a session is active).
    // Skip the first fire after a server load to avoid overwriting fresh server data.
    useEffect(() => {
        if (!sessionId) return;
        if (suppressNextSaveRef.current) {
            suppressNextSaveRef.current = false;
            return;
        }
        saveQuestionsDebounced(sessionId, currentQuestions);
    }, [sessionId, currentQuestions]);

    // On mount: validate stored session or show picker
    useEffect(() => {
        const storedId = activeSessionId.get();
        if (!storedId) {
            setShowPicker(true);
            return;
        }
        setLoading(true);
        fetch(`${API_BASE}/sessions/${storedId}`, { credentials: "include" })
            .then(async (res) => {
                if (!res.ok) {
                    clearActiveSession();
                    setShowPicker(true);
                    return;
                }
                const data: GameSessionSummary = await res.json();
                // Load session content (strokes + questions)
                try {
                    const { questions: loadedQuestions } = await loadSessionContent(storedId);
                    suppressNextSaveRef.current = true;
                    questions.set(loadedQuestions);
                    // Fetch games for the session's server and apply game defaults
                    const games = await fetchGames(data.serverId);
                    const game = games.find((g) => g.id === data.gameId) ?? getGameById(data.gameId);
                    if (game) switchToGame(game);
                } catch {
                    // Content load failed; session is still valid, continue
                }
                setActiveSession(data);
                setShowPicker(false);
            })
            .catch(() => {
                clearActiveSession();
                setShowPicker(true);
            })
            .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const handleSessionSelected = useCallback(async (selected: GameSessionSummary) => {
        setLoading(true);
        try {
            const [{ questions: loadedQuestions }, games] = await Promise.all([
                loadSessionContent(selected.id),
                fetchGames(selected.serverId),
            ]);
            suppressNextSaveRef.current = true;
            questions.set(loadedQuestions);
            const game = games.find((g) => g.id === selected.gameId);
            if (game) switchToGame(game);
            setActiveSession(selected);
            setShowPicker(false);
        } catch (e: unknown) {
            console.warn("[SessionManager] failed to load session content:", e);
            setActiveSession(selected);
            setShowPicker(false);
        } finally {
            setLoading(false);
        }
    }, []);

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
