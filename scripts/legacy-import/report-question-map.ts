// Reports how the old Searchlight's questions map onto the preloaded games.
//
// The old prod ("writemap", fork commit c7363de) stored each question with a
// family (matching, measuring, tentacles) and an old type ID such as
// "bern-canton" or "peak-full". question-map.json maps every old type ever
// asked, per old game sentinel, to the question ID the current game offers
// (deriveFeatureQuestionId), or to null with the reason it has no equivalent.
// A one-off import of the old sessions uses it to remap question payloads.
//
// Run: pnpm exec tsx scripts/legacy-import/report-question-map.ts <asked.tsv>...
// Each TSV has the columns sentinelValue, fam, t, n (count), as exported from
// the old DB. Exits 1 if a row has no mapping entry, or an entry points at a
// question the game doesn't offer.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deriveFeatureQuestionId } from "../../packages/shared/src/index.js";

const ROOT_DIR = resolve(fileURLToPath(import.meta.url), "../../..");

type Family = "matching" | "measuring" | "tentacles";
interface Entry {
  questionId: string | null;
  status: string;
  layer?: string;
  reason?: string;
  // For zone questions: the payload's cat.adminLevel this entry applies to.
  adminLevel?: number;
}
// A zone type asked at several admin levels maps per level.
type MapValue = Entry | { byAdminLevel: Record<string, Entry> };
interface QuestionMap {
  games: Record<string, { gameId: string; questions: Record<Family, Record<string, MapValue>> }>;
}

const KIND: Record<Family, string> = { matching: "matching", measuring: "measuring", tentacles: "tentacle" };

async function offeredQuestionIds(gameId: string): Promise<Set<string>> {
  const file = resolve(ROOT_DIR, "games/preloaded", `${gameId}.game.json`);
  const game = JSON.parse(await readFile(file, "utf8"));
  const ids = new Set<string>();
  for (const feat of game.features ?? []) {
    // The app offers tentacles on point layers only.
    const points = feat.data.features.every((f: { geometry: { type: string } }) => f.geometry.type === "Point");
    for (const kind of feat.enabledFor) {
      if (kind !== "tentacle" || points) ids.add(deriveFeatureQuestionId(kind, feat.name));
    }
  }
  return ids;
}

async function main() {
  const tsvs = process.argv.slice(2);
  if (tsvs.length === 0) {
    console.error("usage: report-question-map.ts <asked.tsv>...");
    process.exit(2);
  }
  const map: QuestionMap = JSON.parse(
    await readFile(resolve(ROOT_DIR, "scripts/legacy-import/question-map.json"), "utf8"),
  );
  const offered = new Map<string, Set<string>>();
  for (const [sentinel, g] of Object.entries(map.games)) {
    offered.set(sentinel, await offeredQuestionIds(g.gameId));
  }

  let problems = 0;
  for (const tsv of tsvs) {
    const rows = (await readFile(tsv, "utf8"))
      .trim()
      .split("\n")
      .slice(1)
      .map((line) => line.split("\t"))
      .filter((cols) => cols.length === 4 && !cols[0].startsWith("("));
    const totals = { generic: 0, custom: 0, mapped: 0, unmappable: 0 };
    const unmappable: string[] = [];
    for (const [sentinel, fam, type, n] of rows) {
      const count = Number(n);
      if (fam === "radius" || fam === "thermometer") {
        totals.generic += count;
        continue;
      }
      const game = map.games[sentinel];
      const value = game?.questions[fam as Family]?.[type];
      if (!value) {
        console.error(`✗ ${sentinel} ${fam} ${type}: no mapping entry`);
        problems++;
        continue;
      }
      // The TSVs don't split rows by admin level, so a per-level row counts as
      // mapped only if every level maps.
      const levels = "byAdminLevel" in value ? Object.values(value.byAdminLevel) : [value];
      const entry = levels.find((e) => !e.questionId) ?? levels[0];
      for (const level of levels.slice(1)) {
        if (level.questionId && !offered.get(sentinel)?.has(level.questionId)) {
          console.error(`✗ ${sentinel} ${fam} ${type}: ${level.questionId} is not offered by ${game.gameId}`);
          problems++;
        }
      }
      if (entry.status === "custom") {
        totals.custom += count;
      } else if (entry.questionId) {
        if (!offered.get(sentinel)?.has(entry.questionId)) {
          console.error(`✗ ${sentinel} ${fam} ${type}: ${entry.questionId} is not offered by ${game.gameId}`);
          problems++;
          continue;
        }
        if (entry.questionId !== deriveFeatureQuestionId(KIND[fam as Family], entry.layer ?? "")) {
          console.error(`✗ ${sentinel} ${fam} ${type}: ${entry.questionId} doesn't match layer "${entry.layer}"`);
          problems++;
        }
        totals.mapped += count;
      } else {
        totals.unmappable += count;
        unmappable.push(`  ${game.gameId} ${fam} ${type} ×${count}: ${entry.status}, ${entry.reason}`);
      }
    }
    const feature = totals.custom + totals.mapped + totals.unmappable;
    console.log(`${tsv}:`);
    console.log(`  radar/thermometer ${totals.generic}, feature questions ${feature}:`);
    console.log(`  mapped ${totals.mapped}, custom ${totals.custom}, unmappable ${totals.unmappable}`);
    if (unmappable.length) console.log(unmappable.join("\n"));
    console.log();
  }
  if (problems) {
    console.error(`${problems} problem(s)`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
