// ── Canonical Game POI Categories ───────────────────────────────────────────

/** The 13 rulebook points-of-interest categories that questions can use. */
export const POI_CATEGORIES = [
  "airport",
  "zoo",
  "aquarium",
  "golf_course",
  "museum",
  "cinema",
  "hospital",
  "library",
  "consulate",
  "park",
  "theme_park",
  "mountain",
  "rail",
] as const;

export type POICategory = (typeof POI_CATEGORIES)[number];
