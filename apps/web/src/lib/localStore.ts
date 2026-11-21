import {
    computeGameDefinitionChecksum,
    type GameDefinition,
    resolveGameDefinitionId,
} from "@searchlight/shared";

import type { StrokeFeature } from "@/annotations/types";
import { readStorage, removeStorage, writeStorage } from "@/lib/safeStorage";
import { randomUUID } from "@/lib/utils";
import type { Questions } from "@/maps/schema";

const DB_NAME = "searchlight-local-v1";
const DB_VERSION = 1;
const STORE_GAME_META = "gameMeta";
const STORE_GAME_DEFINITIONS = "gameDefinitions";
const STORE_SESSIONS = "sessions";

const LOCAL_ACTIVE_SESSION_SS_KEY = "searchlight-local-active-session";
const LOCAL_LAST_SESSION_LS_KEY = "searchlight-local-last-session";

export interface LocalGameSource {
    kind: "file" | "url" | "game-link";
    label: string;
    url?: string;
}

export interface LocalGameMeta {
    /** Content checksum (SHA-256 of canonical definition). */
    id: string;
    gameKey: string;
    name: string;
    size: "small" | "medium" | "large";
    zoneCount: number;
    layerCount: number;
    source: LocalGameSource;
    addedAt: string;
}

export interface LocalSessionRecord {
    id: string;
    name: string;
    gameId: string;
    gameName: string;
    questions: Questions;
    strokes: StrokeFeature[];
    disabledZones: string[];
    hiderMode: false | { latitude: number; longitude: number };
    planningMode: boolean;
    createdAt: string;
    updatedAt: string;
}

export interface LocalSessionSummary {
    id: string;
    name: string;
    gameId: string;
    gameName: string;
    questionCount: number;
    strokeCount: number;
    createdAt: string;
    updatedAt: string;
}

export type LocalSessionPatch = Partial<
    Pick<
        LocalSessionRecord,
        | "name"
        | "questions"
        | "strokes"
        | "disabledZones"
        | "hiderMode"
        | "planningMode"
    >
>;

export class LocalStorageFullError extends Error {
    constructor(message = "Browser storage is full. Delete an old local game or session to make room.") {
        super(message);
        this.name = "LocalStorageFullError";
    }
}

function isQuotaError(err: unknown): boolean {
    if (!err || typeof err !== "object") return false;
    const name = (err as { name?: string }).name;
    return name === "QuotaExceededError" || name === "NS_ERROR_DOM_QUOTA_REACHED";
}

function summarizeSession(s: LocalSessionRecord): LocalSessionSummary {
    return {
        id: s.id,
        name: s.name,
        gameId: s.gameId,
        gameName: s.gameName,
        questionCount: Array.isArray(s.questions) ? s.questions.length : 0,
        strokeCount: Array.isArray(s.strokes) ? s.strokes.length : 0,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
    };
}

function buildGameMeta(
    id: string,
    definition: GameDefinition,
    source: LocalGameSource,
    addedAt: string,
): LocalGameMeta {
    return {
        id,
        gameKey: resolveGameDefinitionId(definition),
        name: definition.name,
        size: definition.size ?? "medium",
        zoneCount: definition.hidingZones.features.features.length,
        layerCount: definition.features?.length ?? 0,
        source,
        addedAt,
    };
}

// ── In-memory fallback (when IndexedDB is unavailable or blocked) ─────────────

const memoryGameMeta = new Map<string, LocalGameMeta>();
const memoryDefinitions = new Map<string, GameDefinition>();
const memorySessions = new Map<string, LocalSessionRecord>();

let dbPromise: Promise<IDBDatabase | null> | null = null;
let openDbInstance: IDBDatabase | null = null;
let persistentAvailable: boolean | null = null;

function openDb(): Promise<IDBDatabase | null> {
    if (openDbInstance) return Promise.resolve(openDbInstance);
    if (dbPromise) return dbPromise;
    dbPromise = new Promise<IDBDatabase | null>((resolve) => {
        if (typeof indexedDB === "undefined") {
            persistentAvailable = false;
            resolve(null);
            return;
        }
        try {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(STORE_GAME_META)) {
                    db.createObjectStore(STORE_GAME_META, { keyPath: "id" });
                }
                if (!db.objectStoreNames.contains(STORE_GAME_DEFINITIONS)) {
                    db.createObjectStore(STORE_GAME_DEFINITIONS, { keyPath: "id" });
                }
                if (!db.objectStoreNames.contains(STORE_SESSIONS)) {
                    db.createObjectStore(STORE_SESSIONS, { keyPath: "id" });
                }
            };
            req.onsuccess = () => {
                const db = req.result;
                openDbInstance = db;
                db.onversionchange = () => {
                    db.close();
                    openDbInstance = null;
                    dbPromise = null;
                };
                persistentAvailable = true;
                resolve(db);
            };
            req.onerror = () => {
                console.warn(
                    "[searchlight:local] IndexedDB unavailable, using in-memory storage:",
                    req.error,
                );
                persistentAvailable = false;
                resolve(null);
            };
            req.onblocked = () => {
                console.warn(
                    "[searchlight:local] IndexedDB open blocked, using in-memory storage",
                );
                persistentAvailable = false;
                resolve(null);
            };
        } catch (err) {
            console.warn(
                "[searchlight:local] IndexedDB threw on open, using in-memory storage:",
                err,
            );
            persistentAvailable = false;
            resolve(null);
        }
    });
    return dbPromise;
}

function idbRequest<T>(req: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

function idbTransactionDone(tx: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () =>
            reject(isQuotaError(tx.error) ? new LocalStorageFullError() : tx.error);
        tx.onabort = () =>
            reject(isQuotaError(tx.error) ? new LocalStorageFullError() : (tx.error ?? new Error("Transaction aborted")));
    });
}

/** Whether IndexedDB storage is available (false in strict private modes). */
export async function isLocalStoragePersistent(): Promise<boolean> {
    await openDb();
    return persistentAvailable === true;
}

/** List all locally saved games, newest first (metadata only, no large GeoJSON). */
export async function listLocalGames(): Promise<LocalGameMeta[]> {
    const db = await openDb();
    if (!db) {
        return [...memoryGameMeta.values()].sort((a, b) =>
            b.addedAt.localeCompare(a.addedAt),
        );
    }
    const tx = db.transaction(STORE_GAME_META, "readonly");
    const games = (await idbRequest(
        tx.objectStore(STORE_GAME_META).getAll(),
    )) as LocalGameMeta[];
    return games.sort((a, b) => b.addedAt.localeCompare(a.addedAt));
}

/** Load the full GameDefinition for a saved local game. */
export async function getLocalGameDefinition(
    gameId: string,
): Promise<GameDefinition | null> {
    const db = await openDb();
    if (!db) {
        const def = memoryDefinitions.get(gameId);
        return def ? structuredClone(def) : null;
    }
    const tx = db.transaction(STORE_GAME_DEFINITIONS, "readonly");
    const row = (await idbRequest(
        tx.objectStore(STORE_GAME_DEFINITIONS).get(gameId),
    )) as { id: string; definition: GameDefinition } | undefined;
    return row?.definition ?? null;
}

/**
 * Save a validated GameDefinition locally, deduplicated by content checksum.
 * If the exact same definition is already saved, refreshes its timestamp and
 * returns the existing record without storing a second copy.
 */
export async function saveLocalGame(
    definition: GameDefinition,
    source: LocalGameSource,
): Promise<LocalGameMeta> {
    const id = computeGameDefinitionChecksum(definition);
    const now = new Date().toISOString();
    const meta = buildGameMeta(id, definition, source, now);

    const db = await openDb();
    if (!db) {
        memoryGameMeta.set(id, meta);
        memoryDefinitions.set(id, structuredClone(definition));
        return meta;
    }

    const tx = db.transaction(
        [STORE_GAME_META, STORE_GAME_DEFINITIONS],
        "readwrite",
    );
    const done = idbTransactionDone(tx);
    tx.objectStore(STORE_GAME_META).put(meta);
    tx.objectStore(STORE_GAME_DEFINITIONS).put({ id, definition });
    await done;
    return meta;
}

/** Delete a saved local game and any local sessions belonging to it. */
export async function deleteLocalGame(gameId: string): Promise<string[]> {
    const db = await openDb();
    if (!db) {
        memoryGameMeta.delete(gameId);
        memoryDefinitions.delete(gameId);
        const deletedSessionIds: string[] = [];
        for (const [id, session] of memorySessions.entries()) {
            if (session.gameId === gameId) {
                memorySessions.delete(id);
                deletedSessionIds.push(id);
            }
        }
        return deletedSessionIds;
    }

    const tx = db.transaction(
        [STORE_GAME_META, STORE_GAME_DEFINITIONS, STORE_SESSIONS],
        "readwrite",
    );
    const done = idbTransactionDone(tx);
    tx.objectStore(STORE_GAME_META).delete(gameId);
    tx.objectStore(STORE_GAME_DEFINITIONS).delete(gameId);
    const sessionStore = tx.objectStore(STORE_SESSIONS);
    const allSessions = (await idbRequest(
        sessionStore.getAll(),
    )) as LocalSessionRecord[];
    const deletedSessionIds: string[] = [];
    for (const s of allSessions) {
        if (s.gameId === gameId) {
            sessionStore.delete(s.id);
            deletedSessionIds.push(s.id);
        }
    }
    await done;
    return deletedSessionIds;
}

/** List all saved local sessions, most recently updated first. */
export async function listLocalSessions(): Promise<LocalSessionSummary[]> {
    const db = await openDb();
    if (!db) {
        return [...memorySessions.values()]
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
            .map(summarizeSession);
    }
    const tx = db.transaction(STORE_SESSIONS, "readonly");
    const sessions = (await idbRequest(
        tx.objectStore(STORE_SESSIONS).getAll(),
    )) as LocalSessionRecord[];
    return sessions
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map(summarizeSession);
}

/** Load one local session record. */
export async function getLocalSession(
    sessionId: string,
): Promise<LocalSessionRecord | null> {
    const db = await openDb();
    if (!db) {
        const s = memorySessions.get(sessionId);
        return s ? structuredClone(s) : null;
    }
    const tx = db.transaction(STORE_SESSIONS, "readonly");
    const record = (await idbRequest(
        tx.objectStore(STORE_SESSIONS).get(sessionId),
    )) as LocalSessionRecord | undefined;
    return record ?? null;
}

/** Create a new local session for a saved local game. */
export async function createLocalSession(
    game: Pick<LocalGameMeta, "id" | "name">,
    name?: string,
): Promise<LocalSessionRecord> {
    const now = new Date().toISOString();
    const trimmed = name?.trim();
    const record: LocalSessionRecord = {
        id: randomUUID(),
        name: (trimmed && trimmed.slice(0, 100)) || game.name,
        gameId: game.id,
        gameName: game.name,
        questions: [],
        strokes: [],
        disabledZones: [],
        hiderMode: false,
        planningMode: false,
        createdAt: now,
        updatedAt: now,
    };

    const db = await openDb();
    if (!db) {
        memorySessions.set(record.id, structuredClone(record));
        return record;
    }

    const tx = db.transaction(STORE_SESSIONS, "readwrite");
    const done = idbTransactionDone(tx);
    tx.objectStore(STORE_SESSIONS).put(record);
    await done;
    return record;
}

/**
 * Patch an existing local session atomically inside a single read-write
 * transaction so rapid updates to different fields never clobber each other.
 * No-op if the session was deleted in the meantime.
 */
export async function updateLocalSession(
    sessionId: string,
    patch: LocalSessionPatch,
): Promise<LocalSessionRecord | null> {
    const now = new Date().toISOString();
    // Use the already-open DB handle synchronously when available so flushes
    // inside `pagehide` / `beforeunload` open the transaction immediately.
    const db = openDbInstance ?? (await openDb());
    if (!db) {
        const existing = memorySessions.get(sessionId);
        if (!existing) return null;
        const updated: LocalSessionRecord = {
            ...existing,
            ...structuredClone(patch),
            updatedAt: now,
        };
        memorySessions.set(sessionId, updated);
        return structuredClone(updated);
    }

    const tx = db.transaction(STORE_SESSIONS, "readwrite");
    const done = idbTransactionDone(tx);
    const store = tx.objectStore(STORE_SESSIONS);
    const existing = (await idbRequest(store.get(sessionId))) as
        | LocalSessionRecord
        | undefined;
    if (!existing) {
        await done;
        return null;
    }
    const updated: LocalSessionRecord = {
        ...existing,
        ...patch,
        updatedAt: now,
    };
    store.put(updated);
    await done;
    return updated;
}

/** Delete one local session (keeps its saved game available for new sessions). */
export async function deleteLocalSession(sessionId: string): Promise<void> {
    const db = await openDb();
    if (!db) {
        memorySessions.delete(sessionId);
        return;
    }
    const tx = db.transaction(STORE_SESSIONS, "readwrite");
    const done = idbTransactionDone(tx);
    tx.objectStore(STORE_SESSIONS).delete(sessionId);
    await done;
}

// ── Last active local session pointer (isolated from online taibled-* keys) ──

export function readLastLocalSessionId(): string {
    const own = readStorage("sessionStorage", LOCAL_ACTIVE_SESSION_SS_KEY);
    if (own !== null) return own;
    const last = readStorage("localStorage", LOCAL_LAST_SESSION_LS_KEY);
    if (last) writeStorage("sessionStorage", LOCAL_ACTIVE_SESSION_SS_KEY, last);
    return last ?? "";
}

export function writeLastLocalSessionId(sessionId: string): void {
    writeStorage("sessionStorage", LOCAL_ACTIVE_SESSION_SS_KEY, sessionId);
    writeStorage("localStorage", LOCAL_LAST_SESSION_LS_KEY, sessionId);
}

export function clearLastLocalSessionId(): void {
    writeStorage("sessionStorage", LOCAL_ACTIVE_SESSION_SS_KEY, "");
    removeStorage("localStorage", LOCAL_LAST_SESSION_LS_KEY);
}

/** Test helper: clears in-memory fallback state and resets DB handle. */
export function _resetLocalStoreForTests(): void {
    memoryGameMeta.clear();
    memoryDefinitions.clear();
    memorySessions.clear();
    openDbInstance?.close();
    openDbInstance = null;
    dbPromise = null;
    persistentAvailable = null;
}
