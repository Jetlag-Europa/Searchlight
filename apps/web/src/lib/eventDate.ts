import { isRulesUrl } from "@searchlight/shared";

// A game's event day(s), `YYYY-MM-DD`, are calendar days: formatted in UTC,
// where they were stored, so no time zone shows the day before.
const utcDay = (date: string) => new Date(`${date}T00:00:00Z`);

const dayFormat = new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
});

/** "19 Sep 2026", or "2–3 Oct 2026" for a multi-day event. */
export function formatEventDate(date: string, endDate?: string | null): string {
    if (!endDate || endDate === date) return dayFormat.format(utcDay(date));
    return dayFormat.formatRange(utcDay(date), utcDay(endDate));
}

/** The rules link, if it is one the Rules button may open. */
export function rulesLink(url: string | null | undefined): string | null {
    return url && isRulesUrl(url) ? url : null;
}
