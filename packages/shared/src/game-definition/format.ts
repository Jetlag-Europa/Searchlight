/** Nested arrays of numbers only, as GeoJSON positions are. */
const isPositions = (value: unknown): boolean =>
  Array.isArray(value) &&
  value.every((v) => typeof v === "number" || isPositions(v));

/**
 * A game definition as a file to download: indented like
 * `JSON.stringify(value, null, indent)`, but with each GeoJSON `coordinates`
 * array on one line. Indenting put every number of every boundary on a line
 * of its own, making files about 4.5x larger than compact JSON; this stays
 * within about 10% of it. It parses back to the same value.
 */
export function formatGameDefinitionJson(
  definition: unknown,
  indent: string | number = 2,
): string {
  // Coordinates go in as NUL-wrapped strings, which are unwrapped after. A
  // file whose own text holds a NUL is rare enough to just indent in full.
  let hasNul = false;
  const text = JSON.stringify(
    definition,
    (key, value) => {
      if (key.includes("\0") || (typeof value === "string" && value.includes("\0"))) {
        hasNul = true;
      }
      return key === "coordinates" && isPositions(value)
        ? `\0${JSON.stringify(value)}\0`
        : value;
    },
    indent,
  );
  if (hasNul) return `${JSON.stringify(definition, null, indent)}\n`;
  return `${text.replace(/"\\u0000(.*?)\\u0000"/g, (_, json: string) => json)}\n`;
}
