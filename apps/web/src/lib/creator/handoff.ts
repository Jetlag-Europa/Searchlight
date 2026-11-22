import {
  CASUAL_SERVER_ID,
  type DistanceUnit,
  type GameDefinition,
  type HidingZoneFeature,
  type PlayAreaFeatureCollection,
} from "@searchlight/shared";

import type { CreatorGeometryLayer, PreservedGameMetadata } from "@/lib/creator/assemble";
import type { CreatorPointItem } from "@/lib/creator/overpass";
import type {
  GameScale,
  StationPresetId,
  StationSource,
  StationTypeId,
} from "@/lib/creator/presets";

const DB_NAME = "searchlight-creator-handoff-v1";
const STORE_NAME = "draft";
const HANDOFF_KEY_PREFIX = "handoff:";
const OPEN_HANDOFF_KEY_PREFIX = "open:";
const WORKSPACE_DRAFT_KEY = "workspace-autosave";
const MAX_DRAFT_AGE_MS = 24 * 60 * 60 * 1000;

export interface CreatorImportHandoff {
  fileName: string;
  definition: GameDefinition;
  createdAt: string;
}

export interface CreatorOpenHandoff {
  mode: "edit" | "copy";
  definition: GameDefinition;
  /** Set ONLY when mode === "edit" and the user has update permission on /games. */
  replaceGameId?: string;
  sourceGameName?: string;
  createdAt: string;
}

export interface CreatorReplaceTarget {
  gameId: string;
  gameName: string;
}

export interface CreatorWorkspaceDraft {
  version: 1;
  updatedAt: string;
  step: "area" | "stations" | "features" | "export";
  gameName: string;
  customId: string;
  scale: GameScale;
  unit: DistanceUnit;
  hidingRadius: number;
  radarMode: "default" | "custom" | "off";
  radarsText: string;
  thermometer: boolean;
  playArea: PlayAreaFeatureCollection | null;
  playAreaOsmRelationId?: number | null;
  preservedMetadata: PreservedGameMetadata | null;
  replaceTarget?: CreatorReplaceTarget | null;
  stationSource?: StationSource;
  stationTypes?: StationTypeId[];
  stationPreset?: StationPresetId;
  customStationFilter: string;
  dedupeMeters: number;
  preferEnglishName: boolean;
  stations: CreatorPointItem[];
  extraHidingZones: HidingZoneFeature[];
  tierOverrides: Record<string, number>;
  layers: CreatorGeometryLayer[];
  visibleLayerIds: string[];
  poiBufferKm: number;
  customEndpoint: string;
  maxKmlLayers: number;
  includePlayAreaKml: boolean;
  includeCirclesKml: boolean;
}

let cachedDb: IDBDatabase | null = null;
let openPromise: Promise<IDBDatabase | null> | null = null;
let workspaceQueue: Promise<unknown> = Promise.resolve();
let workspaceWriteGen = 0;

function makeDraftId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `draft-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function openHandoffDb(): Promise<IDBDatabase | null> {
  if (cachedDb) return Promise.resolve(cachedDb);
  if (openPromise) return openPromise;
  openPromise = new Promise((resolve) => {
    if (typeof indexedDB === "undefined") {
      openPromise = null;
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
      req.onsuccess = () => {
        const db = req.result;
        const clear = () => {
          if (cachedDb === db) cachedDb = null;
        };
        db.onversionchange = () => {
          db.close();
          clear();
        };
        db.onclose = clear;
        cachedDb = db;
        openPromise = null;
        resolve(db);
      };
      req.onerror = req.onblocked = () => {
        openPromise = null;
        resolve(null);
      };
    } catch {
      openPromise = null;
      resolve(null);
    }
  });
  return openPromise;
}

async function runStoreTx<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T> | void,
): Promise<{ ok: true; value: T | undefined } | { ok: false }> {
  const db = await openHandoffDb();
  if (!db) return { ok: false };
  try {
    const value = await new Promise<T | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, mode);
      let result: T | undefined;
      const req = fn(tx.objectStore(STORE_NAME));
      if (req) {
        req.onsuccess = () => {
          result = req.result;
        };
        req.onerror = () => reject(req.error);
      }
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error("Aborted"));
    });
    return { ok: true, value };
  } catch {
    return { ok: false };
  }
}

function handoffStorageKey(draftId?: string | null): string | null {
  const trimmed = draftId?.trim();
  if (!trimmed || trimmed === WORKSPACE_DRAFT_KEY) return null;
  return `${HANDOFF_KEY_PREFIX}${trimmed}`;
}

function isValidHandoff(val: unknown): val is CreatorImportHandoff {
  return (
    typeof val === "object" &&
    val !== null &&
    typeof (val as CreatorImportHandoff).fileName === "string" &&
    typeof (val as CreatorImportHandoff).definition === "object" &&
    (val as CreatorImportHandoff).definition !== null
  );
}

/** Stashes a generated GameDefinition in a per-handoff IDB key for `/games/import`. */
export async function saveCreatorImportHandoff(
  fileName: string,
  definition: GameDefinition,
): Promise<string | null> {
  const draftId = makeDraftId();
  const storageKey = `${HANDOFF_KEY_PREFIX}${draftId}`;
  const payload: CreatorImportHandoff = {
    fileName,
    definition,
    createdAt: new Date().toISOString(),
  };
  const res = await runStoreTx<void>("readwrite", (store) => {
    store.put(payload, storageKey);
    const cursorReq = store.openCursor();
    const cutoff = Date.now() - MAX_DRAFT_AGE_MS;
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (!cursor) return;
      const val = cursor.value as CreatorImportHandoff | undefined;
      const ts = val?.createdAt ? Date.parse(val.createdAt) : 0;
      if (cursor.key !== storageKey && cursor.key !== WORKSPACE_DRAFT_KEY && (!ts || ts < cutoff)) {
        cursor.delete();
      }
      cursor.continue();
    };
  });
  return res.ok ? draftId : null;
}

/** Reads (without deleting) a pending handoff from `/create`. */
export async function readCreatorImportHandoff(
  draftId?: string | null,
): Promise<CreatorImportHandoff | null> {
  const key = handoffStorageKey(draftId);
  if (!key) return null;
  const res = await runStoreTx<unknown>("readonly", (store) => store.get(key));
  return res.ok && isValidHandoff(res.value) ? res.value : null;
}

function openHandoffStorageKey(openId?: string | null): string | null {
  const trimmed = openId?.trim();
  if (!trimmed || trimmed === WORKSPACE_DRAFT_KEY) return null;
  return `${OPEN_HANDOFF_KEY_PREFIX}${trimmed}`;
}

function isValidOpenHandoff(val: unknown): val is CreatorOpenHandoff {
  if (typeof val !== "object" || val === null) return false;
  const h = val as CreatorOpenHandoff;
  return (
    (h.mode === "edit" || h.mode === "copy") &&
    typeof h.definition === "object" &&
    h.definition !== null &&
    (h.replaceGameId === undefined || typeof h.replaceGameId === "string")
  );
}

/** Stashes a GameDefinition from `/games` in IndexedDB for `/create?open=<id>`. */
export async function saveCreatorOpenHandoff(
  input: Omit<CreatorOpenHandoff, "createdAt">,
): Promise<string | null> {
  const openId = makeDraftId();
  const storageKey = `${OPEN_HANDOFF_KEY_PREFIX}${openId}`;
  const payload: CreatorOpenHandoff = {
    mode: input.mode,
    definition: input.definition,
    // Guardrail: never persist replaceGameId for copy handoffs.
    ...(input.mode === "edit" && input.replaceGameId && { replaceGameId: input.replaceGameId }),
    ...(input.sourceGameName && { sourceGameName: input.sourceGameName }),
    createdAt: new Date().toISOString(),
  };
  const res = await runStoreTx<void>("readwrite", (store) => {
    store.put(payload, storageKey);
    const cursorReq = store.openCursor();
    const cutoff = Date.now() - MAX_DRAFT_AGE_MS;
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (!cursor) return;
      const val = cursor.value as { createdAt?: string } | undefined;
      const ts = val?.createdAt ? Date.parse(val.createdAt) : 0;
      if (cursor.key !== storageKey && cursor.key !== WORKSPACE_DRAFT_KEY && (!ts || ts < cutoff)) {
        cursor.delete();
      }
      cursor.continue();
    };
  });
  return res.ok ? openId : null;
}

/** Reads (without deleting) a pending `/games` -> `/create` handoff. */
export async function readCreatorOpenHandoff(
  openId?: string | null,
): Promise<CreatorOpenHandoff | null> {
  const key = openHandoffStorageKey(openId);
  if (!key) return null;
  const res = await runStoreTx<unknown>("readonly", (store) => store.get(key));
  return res.ok && isValidOpenHandoff(res.value) ? res.value : null;
}

/** Deletes a consumed or dismissed `/games` -> `/create` handoff. */
export async function clearCreatorOpenHandoff(openId?: string | null): Promise<void> {
  const key = openHandoffStorageKey(openId);
  if (!key) return;
  await runStoreTx<void>("readwrite", (store) => {
    store.delete(key);
  });
}

/**
 * Strips server/revision/visibility/id metadata and marks a definition's name
 * as a copy so non-editors opening a game in `/create` cannot accidentally
 * target or replace the original hosted game.
 */
export function sanitizeDefinitionForCreatorCopy(definition: GameDefinition): GameDefinition {
  const baseName = definition.name.trim() || "Untitled Game";
  const suffix = " (Copy)";
  const copyName = baseName.endsWith(suffix)
    ? baseName.slice(0, 120)
    : `${baseName.slice(0, 120 - suffix.length)}${suffix}`;
  const copy: GameDefinition = {
    ...definition,
    name: copyName,
    serverId: CASUAL_SERVER_ID,
  };
  delete copy.id;
  delete copy.revision;
  delete copy.visibility;
  return copy;
}

/** Deletes a consumed handoff draft once the importer has accepted it. */
export async function clearCreatorImportHandoff(draftId?: string | null): Promise<void> {
  const key = handoffStorageKey(draftId);
  if (!key) return;
  await runStoreTx<void>("readwrite", (store) => {
    store.delete(key);
  });
}

function enqueueWorkspaceOp<T>(op: () => Promise<T>, staleFallback: T): Promise<T> {
  const gen = ++workspaceWriteGen;
  const next = workspaceQueue.then(
    () => (gen === workspaceWriteGen ? op() : staleFallback),
    () => (gen === workspaceWriteGen ? op() : staleFallback),
  );
  workspaceQueue = next.catch(() => {});
  return next;
}

/** Persists the active `/create` workspace draft in IndexedDB so reloads never lose progress. */
export function saveCreatorWorkspaceDraft(draft: CreatorWorkspaceDraft): Promise<boolean> {
  return enqueueWorkspaceOp(async () => {
    const res = await runStoreTx<void>("readwrite", (store) => {
      store.put(draft, WORKSPACE_DRAFT_KEY);
    });
    return res.ok;
  }, true);
}

/** Synchronously kicks off a workspace save/clear on pagehide using the cached DB handle. */
export function flushCreatorWorkspaceDraftSync(draft: CreatorWorkspaceDraft | null): void {
  workspaceWriteGen++;
  if (!cachedDb) {
    if (draft) void saveCreatorWorkspaceDraft(draft);
    else void clearCreatorWorkspaceDraft();
    return;
  }
  try {
    const tx = cachedDb.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    if (draft) store.put(draft, WORKSPACE_DRAFT_KEY);
    else store.delete(WORKSPACE_DRAFT_KEY);
  } catch {
    // ignore pagehide storage error
  }
}

/** Reads the autosaved `/create` workspace draft, or null if none exists. */
export async function readCreatorWorkspaceDraft(): Promise<CreatorWorkspaceDraft | null> {
  const res = await runStoreTx<unknown>("readonly", (store) => store.get(WORKSPACE_DRAFT_KEY));
  const val = res.ok ? (res.value as CreatorWorkspaceDraft | undefined) : null;
  return val && val.version === 1 ? val : null;
}

/** Clears the autosaved `/create` workspace draft (e.g. on Reset / New map). */
export function clearCreatorWorkspaceDraft(): Promise<void> {
  return enqueueWorkspaceOp(async () => {
    await runStoreTx<void>("readwrite", (store) => {
      store.delete(WORKSPACE_DRAFT_KEY);
    });
  }, undefined);
}
