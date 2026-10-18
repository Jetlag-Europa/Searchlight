import type { ValidationIssue } from "./validate.js";

// A game's details: when its event is and where its rules are. They describe
// the game, not its map, so they aren't part of a revision: a game file may
// carry them, but import copies them onto the game and leaves them out of the
// stored definition and its checksum. Changing them never makes a new revision.

export const GAME_DETAIL_KEYS = ["date", "endDate", "rulesUrl"] as const;
export type GameDetailKey = (typeof GAME_DETAIL_KEYS)[number];

/** Details as a game file or a request gives them: absent keys say nothing. */
export type GameDetailsInput = Partial<Record<GameDetailKey, string | null>>;

/** A game's details as stored: dates as `YYYY-MM-DD`. */
export interface GameDetails {
  date: string | null;
  endDate: string | null;
  rulesUrl: string | null;
}

/** The definition without its details, and the details it set. */
export function splitGameDetails<T extends object>(
  definition: T,
): { map: Omit<T, GameDetailKey>; details: GameDetailsInput } {
  const map = { ...definition } as Record<string, unknown>;
  const details: GameDetailsInput = {};
  for (const key of GAME_DETAIL_KEYS) {
    if (key in map) {
      const value = map[key];
      if (typeof value === "string" || value === null) details[key] = value;
      delete map[key];
    }
  }
  return { map: map as Omit<T, GameDetailKey>, details };
}

/** `YYYY-MM-DD` naming a day that exists (no 2026-02-30). */
export function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/** An https URL with a host, as the Rules button opens it. */
export function isRulesUrl(value: string): boolean {
  if (value.length > 2048 || /\s/.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.length > 0;
  } catch {
    return false;
  }
}

/**
 * Problems with a game's details, for game files and edits alike: an
 * impossible date, an end date without a start or before it, a rules link
 * that isn't https.
 */
export function validateGameDetails(details: GameDetailsInput, basePath = ""): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const { date, endDate, rulesUrl } = details;
  if (date != null && !isCalendarDate(date)) {
    issues.push({ path: `${basePath}/date`, code: "INVALID_DATE", message: `"${date}" isn't a date as YYYY-MM-DD` });
  }
  if (endDate != null) {
    if (!isCalendarDate(endDate)) {
      issues.push({ path: `${basePath}/endDate`, code: "INVALID_DATE", message: `"${endDate}" isn't a date as YYYY-MM-DD` });
    } else if (date == null) {
      issues.push({ path: `${basePath}/endDate`, code: "END_DATE_WITHOUT_DATE", message: "An end date needs a date" });
    } else if (isCalendarDate(date) && endDate < date) {
      issues.push({
        path: `${basePath}/endDate`,
        code: "END_DATE_BEFORE_DATE",
        message: `The end date (${endDate}) is before the date (${date})`,
      });
    }
  }
  if (rulesUrl != null && !isRulesUrl(rulesUrl)) {
    issues.push({ path: `${basePath}/rulesUrl`, code: "INVALID_RULES_URL", message: "The rules link must be an https URL" });
  }
  return issues;
}

/** Newest event first; games without a date after those with one, by name. */
export function compareByEventDate(
  a: { date: string | null; name: string },
  b: { date: string | null; name: string },
): number {
  if (a.date !== b.date) {
    if (a.date === null) return 1;
    if (b.date === null) return -1;
    return a.date < b.date ? 1 : -1;
  }
  return a.name.localeCompare(b.name);
}
