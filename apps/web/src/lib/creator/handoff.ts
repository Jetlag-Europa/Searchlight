import type { GameDefinition } from "@searchlight/shared";

const DB_NAME = "searchlight-creator-handoff-v1";
const STORE_NAME = "draft";
const LEGACY_DRAFT_KEY = "latest";
const MAX_DRAFT_AGE_MS = 24 * 60 * 60 * 1000;

export interface CreatorImportHandoff {
    fileName: string;
    definition: GameDefinition;
    createdAt: string;
}

function makeDraftId(): string {
    if (
        typeof crypto !== "undefined" &&
        typeof crypto.randomUUID === "function"
    ) {
        return crypto.randomUUID();
    }
    return `draft-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function openHandoffDb(): Promise<IDBDatabase | null> {
    return new Promise((resolve) => {
        if (typeof indexedDB === "undefined") {
            resolve(null);
            return;
        }
        try {
            const req = indexedDB.open(DB_NAME, 1);
            req.onupgradeneeded = () => {
                if (!req.result.objectStoreNames.contains(STORE_NAME)) {
                    req.result.createObjectStore(STORE_NAME);
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => resolve(null);
        } catch {
            resolve(null);
        }
    });
}

/**
 * Stashes a generated GameDefinition in a per-handoff IndexedDB key so `/create`
 * can open `/games/import?from=creator&draft=<id>` without colliding across
 * concurrent tabs or touching `/local` / `/map` storage. Returns the draft ID
 * on success, or null if storage is unavailable.
 */
export async function saveCreatorImportHandoff(
    fileName: string,
    definition: GameDefinition,
): Promise<string | null> {
    const draftId = makeDraftId();
    const payload: CreatorImportHandoff = {
        fileName,
        definition,
        createdAt: new Date().toISOString(),
    };
    const db = await openHandoffDb();
    if (!db) return null;
    try {
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, "readwrite");
            const store = tx.objectStore(STORE_NAME);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            store.put(payload, draftId);
            // Opportunistically prune abandoned drafts older than 24 hours.
            const cursorReq = store.openCursor();
            const cutoff = Date.now() - MAX_DRAFT_AGE_MS;
            cursorReq.onsuccess = () => {
                const cursor = cursorReq.result;
                if (!cursor) return;
                const val = cursor.value as CreatorImportHandoff | undefined;
                const ts = val?.createdAt ? Date.parse(val.createdAt) : 0;
                if (cursor.key !== draftId && (!ts || ts < cutoff)) {
                    cursor.delete();
                }
                cursor.continue();
            };
        });
        return draftId;
    } catch {
        return null;
    } finally {
        db.close();
    }
}

/** Reads (without deleting) a pending handoff from `/create`. */
export async function readCreatorImportHandoff(
    draftId?: string | null,
): Promise<CreatorImportHandoff | null> {
    const key = draftId?.trim() || LEGACY_DRAFT_KEY;
    const db = await openHandoffDb();
    if (!db) return null;
    try {
        return await new Promise<CreatorImportHandoff | null>((resolve) => {
            const tx = db.transaction(STORE_NAME, "readonly");
            const getReq = tx.objectStore(STORE_NAME).get(key);
            getReq.onsuccess = () =>
                resolve(
                    (getReq.result as CreatorImportHandoff | undefined) ?? null,
                );
            getReq.onerror = () => resolve(null);
            tx.onerror = () => resolve(null);
        });
    } catch {
        return null;
    } finally {
        db.close();
    }
}

/** Deletes a consumed handoff draft once the importer has accepted it. */
export async function clearCreatorImportHandoff(
    draftId?: string | null,
): Promise<void> {
    const key = draftId?.trim() || LEGACY_DRAFT_KEY;
    const db = await openHandoffDb();
    if (!db) return;
    try {
        await new Promise<void>((resolve) => {
            const tx = db.transaction(STORE_NAME, "readwrite");
            tx.objectStore(STORE_NAME).delete(key);
            tx.oncomplete = () => resolve();
            tx.onerror = () => resolve();
        });
    } catch {
        // ignore cleanup failure
    } finally {
        db.close();
    }
}
