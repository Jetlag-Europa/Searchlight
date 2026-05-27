/**
 * One-off script to preload all Brno city district boundaries into BoundaryCache.
 *
 * Run against dev:
 *   DATABASE_URL=postgresql://taibled:devpassword@localhost:5434/taibled \
 *     node --env-file=../../.env --import tsx/esm prisma/seed-brno-boundaries.ts
 *
 * Run against prod:
 *   DATABASE_URL=postgresql://taibled:devpassword@localhost:5435/taibled \
 *     node --env-file=../../.env --import tsx/esm prisma/seed-brno-boundaries.ts
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const OVERPASS_PRIMARY = "https://overpass-api.de/api/interpreter";
const OVERPASS_FALLBACK = "https://overpass.kumi.systems/api/interpreter";

async function main() {
    // Fetch all admin_level=9 relations inside Brno (admin_level=8) in one query.
    const query = `[out:json][timeout:60];
area["name"="Brno"]["admin_level"="8"]->.brno;
rel(area.brno)["admin_level"="9"]["boundary"="administrative"];
out geom;`;

    console.log("Fetching all Brno city districts from Overpass...");

    const encoded = encodeURIComponent(query);
    const opts = { headers: { "User-Agent": "TaibledFork/1.0" }, signal: AbortSignal.timeout(60_000) };
    let res = await fetch(`${OVERPASS_PRIMARY}?data=${encoded}`, opts).catch(() => null);
    if (!res?.ok) {
        console.log("Primary Overpass failed, trying fallback...");
        res = await fetch(`${OVERPASS_FALLBACK}?data=${encoded}`, opts).catch(() => null);
    }
    if (!res?.ok) throw new Error("Both Overpass servers unavailable");

    const data = await res.json() as {
        version: number;
        generator: string;
        osm3s: unknown;
        elements: Array<{ type: string; id: number; tags?: Record<string, string> }>;
    };

    console.log(`Got ${data.elements.length} districts from Overpass`);

    let inserted = 0;
    let updated = 0;

    for (const el of data.elements) {
        const osmId = String(el.id);
        const osmType = el.type === "relation" ? "R" : el.type === "way" ? "W" : "N";
        const name = el.tags?.name ?? osmId;

        // Store this element in the same format as the by-ID endpoint
        // so osmtogeojson() on the client works identically.
        const geojson = { version: data.version, generator: data.generator, osm3s: data.osm3s, elements: [el] };

        const existing = await prisma.boundaryCache.findUnique({
            where: { osmId_osmType: { osmId, osmType } },
        });

        await prisma.boundaryCache.upsert({
            where: { osmId_osmType: { osmId, osmType } },
            create: { osmId, osmType, geojson },
            update: { geojson, lastAccessedAt: new Date() },
        });

        if (existing) {
            console.log(`  updated: ${name} (${osmType}${osmId})`);
            updated++;
        } else {
            console.log(`  inserted: ${name} (${osmType}${osmId})`);
            inserted++;
        }
    }

    console.log(`\nDone — ${inserted} inserted, ${updated} updated.`);
}

main().catch(console.error).finally(() => prisma.$disconnect());
