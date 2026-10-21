/** Compact JSON of nested arrays of numbers, as GeoJSON positions are. */
const POSITIONS = /^[-+\d.eE,[\]nul]*$/;

/**
 * A game definition as a file to download: indented like
 * `JSON.stringify(value, null, indent)`, but with each GeoJSON `coordinates`
 * array on one line. Indenting put every number of every boundary on a line
 * of its own, making files about 4.5x larger than compact JSON; a game
 * that's mostly boundaries now stays within about 10% of it. It parses back
 * to the same value.
 */
export function formatGameDefinitionJson(
  definition: object,
  indent: string | number = 2,
): string {
  // Coordinates go in as NUL-wrapped strings, which are unwrapped after. A
  // file whose own text holds a NUL is rare enough to just indent in full.
  if (JSON.stringify(definition).includes("\\u0000")) {
    return `${JSON.stringify(definition, null, indent)}\n`;
  }
  const text = JSON.stringify(
    definition,
    (key, value) => {
      if (key !== "coordinates" || !Array.isArray(value)) return value;
      const json = JSON.stringify(value);
      return POSITIONS.test(json) ? `\0${json}\0` : value;
    },
    indent,
  );
  return `${text.replace(/"\\u0000(.*?)\\u0000"/g, (_, json: string) => json)}\n`;
}
