import { type GameDefinition, resolveGameDefinitionId } from "./schema.js";

/**
 * Computes SHA-256 of a UTF-8 string without Node built-ins.
 */
function sha256Utf8(str: string): string {
  function rightRotate(value: number, amount: number) {
    return (value >>> amount) | (value << (32 - amount));
  }

  const mathPow = Math.pow;
  const maxWord = mathPow(2, 32);
  const bytes = new TextEncoder().encode(str);
  const bitLength = bytes.length * 8;

  const words: number[] = [];
  for (let i = 0; i < bytes.length; i++) {
    words[i >> 2] |= bytes[i] << ((3 - (i % 4)) * 8);
  }

  // Padding
  words[bytes.length >> 2] |= 0x80 << ((3 - (bytes.length % 4)) * 8);

  const totalWords = (((bytes.length + 8) >> 6) + 1) * 16;
  while (words.length < totalWords) {
    words.push(0);
  }
  words[totalWords - 2] = Math.floor(bitLength / maxWord);
  words[totalWords - 1] = bitLength >>> 0;

  // Constants & Initial hash values
  const hash: number[] = [];
  const k: number[] = [];
  let primeCounter = 0;
  const isComposite: Record<number, number> = {};
  for (let candidate = 2; primeCounter < 64; candidate++) {
    if (!isComposite[candidate]) {
      for (let i = 0; i < 313; i += candidate) {
        isComposite[i] = candidate;
      }
      hash[primeCounter] = (mathPow(candidate, 0.5) * maxWord) | 0;
      k[primeCounter++] = (mathPow(candidate, 1 / 3) * maxWord) | 0;
    }
  }

  for (let j = 0; j < words.length; j += 16) {
    const w = words.slice(j, j + 16);
    const oldHash = [...hash];

    for (let i = 0; i < 64; i++) {
      if (i >= 16) {
        const w15 = w[i - 15];
        const w2 = w[i - 2];
        const s0 = rightRotate(w15, 7) ^ rightRotate(w15, 18) ^ (w15 >>> 3);
        const s1 = rightRotate(w2, 17) ^ rightRotate(w2, 19) ^ (w2 >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
      }

      const s0 =
        rightRotate(hash[0], 2) ^ rightRotate(hash[0], 13) ^ rightRotate(hash[0], 22);
      const maj = (hash[0] & hash[1]) ^ (hash[0] & hash[2]) ^ (hash[1] & hash[2]);
      const t2 = (s0 + maj) | 0;
      const s1 =
        rightRotate(hash[4], 6) ^ rightRotate(hash[4], 11) ^ rightRotate(hash[4], 25);
      const ch = (hash[4] & hash[5]) ^ (~hash[4] & hash[6]);
      const t1 = (hash[7] + s1 + ch + k[i] + w[i]) | 0;

      hash[7] = hash[6];
      hash[6] = hash[5];
      hash[5] = hash[4];
      hash[4] = (hash[3] + t1) | 0;
      hash[3] = hash[2];
      hash[2] = hash[1];
      hash[1] = hash[0];
      hash[0] = (t1 + t2) | 0;
    }

    for (let i = 0; i < 8; i++) {
      hash[i] = (hash[i] + oldHash[i]) | 0;
    }
  }

  let result = "";
  for (let i = 0; i < 8; i++) {
    for (let j = 3; j >= 0; j--) {
      const b = (hash[i] >>> (j * 8)) & 0xff;
      result += b.toString(16).padStart(2, "0");
    }
  }
  return result;
}

/**
 * Normalizes defaults on game definition prior to hashing.
 */
export function materializeCanonicalDefaults(
  definition: GameDefinition,
): GameDefinition {
  const cloned: GameDefinition = JSON.parse(JSON.stringify(definition));
  const id = resolveGameDefinitionId(cloned);
  cloned.id = id;
  cloned.revision = cloned.revision ?? 1;
  cloned.size = cloned.size ?? "medium";
  cloned.visibility = cloned.visibility ?? { kind: "server-members" };

  if (cloned.hidingZones && !cloned.hidingZones.unit) {
    cloned.hidingZones.unit = "meters";
  }

  return cloned;
}

/**
 * Deterministically sorts all object keys recursively, normalizes -0 to 0,
 * rejects non-finite numbers, and preserves array element order.
 */
export function normalizeValue(val: unknown): unknown {
  if (val === null || val === undefined) {
    return val;
  }
  if (typeof val === "number") {
    if (!Number.isFinite(val)) {
      throw new Error(`Non-finite number encountered during canonicalization: ${val}`);
    }
    return Object.is(val, -0) ? 0 : val;
  }
  if (typeof val === "string" || typeof val === "boolean") {
    return val;
  }
  if (Array.isArray(val)) {
    return val.map((item) => normalizeValue(item));
  }
  if (typeof val === "object") {
    const sortedObj: Record<string, unknown> = {};
    const keys = Object.keys(val as Record<string, unknown>).sort();
    for (const key of keys) {
      const propVal = (val as Record<string, unknown>)[key];
      if (propVal !== undefined) {
        sortedObj[key] = normalizeValue(propVal);
      }
    }
    return sortedObj;
  }
  throw new Error(`Unsupported value type encountered during canonicalization: ${typeof val}`);
}

export function canonicalizeJson(value: unknown): string {
  const normalized = normalizeValue(value);
  return JSON.stringify(normalized);
}

export function canonicalizePrettyJson(value: unknown): string {
  const normalized = normalizeValue(value);
  return JSON.stringify(normalized, null, 2);
}

export function computeGameDefinitionChecksum(definition: GameDefinition): string {
  const materialized = materializeCanonicalDefaults(definition);
  const canonical = canonicalizeJson(materialized);
  return sha256Utf8(canonical);
}
