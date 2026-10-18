import type { Prisma } from "@prisma/client";
import { GAME_DETAIL_KEYS, type GameDetailKey, type GameDetails, type GameDetailsInput } from "@searchlight/shared";

// A game's details (date, end date, rules link) live on the Game row; see
// GAME_DETAIL_KEYS in @searchlight/shared.

// Dates are calendar days, stored as DATE: read and written at UTC midnight.
export const toDbDate = (date: string | null): Date | null =>
  date === null ? null : new Date(`${date}T00:00:00.000Z`);
export const fromDbDate = (date: Date | null): string | null =>
  date === null ? null : date.toISOString().slice(0, 10);

export function rowDetails(row: {
  date: Date | null;
  endDate: Date | null;
  rulesUrl: string | null;
}): GameDetails {
  return { date: fromDbDate(row.date), endDate: fromDbDate(row.endDate), rulesUrl: row.rulesUrl };
}

export function detailsData(details: Partial<GameDetails>): Prisma.GameUncheckedUpdateInput {
  const data: Prisma.GameUncheckedUpdateInput = {};
  if (details.date !== undefined) data.date = toDbDate(details.date);
  if (details.endDate !== undefined) data.endDate = toDbDate(details.endDate);
  if (details.rulesUrl !== undefined) data.rulesUrl = details.rulesUrl;
  return data;
}

/** The same keys set to the same values (JSONB doesn't keep key order). */
export function sameDetailsInput(a: GameDetailsInput | null, b: GameDetailsInput | null): boolean {
  const key = (d: GameDetailsInput | null) =>
    d === null ? "null" : JSON.stringify(GAME_DETAIL_KEYS.map((k) => (k in d ? d[k] : "<unset>")));
  return key(a) === key(b);
}

// The keys a file sets together: a file giving a date without an end date
// clears the end date (a one-day event), so the two always fit each other.
const GROUPS: GameDetailKey[][] = [["date", "endDate"], ["rulesUrl"]];

function groupValue(details: GameDetailsInput | null | undefined, group: GameDetailKey[]): string | undefined {
  if (!details || !group.some((key) => key in details)) return undefined;
  return JSON.stringify(group.map((key) => details[key] ?? null));
}

/**
 * What a game file changes in a game's details. A file only speaks for the
 * groups it sets: one without a rules link leaves the game's alone. A
 * preloaded file only applies a group whose value changed since the last start
 * (`preloaded`, the details it had then), so edits made since on the games
 * page stay until the file itself changes.
 */
export function fileDetailsPatch(
  file: GameDetailsInput,
  current: GameDetails,
  preloaded?: GameDetailsInput | null,
): Partial<GameDetails> {
  const patch: Partial<GameDetails> = {};
  for (const group of GROUPS) {
    const value = groupValue(file, group);
    if (value === undefined) continue;
    if (preloaded !== undefined && value === groupValue(preloaded, group)) continue;
    for (const key of group) {
      const next = file[key] ?? null;
      if (current[key] !== next) patch[key] = next;
    }
  }
  return patch;
}
