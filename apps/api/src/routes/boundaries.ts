import type { FastifyInstance } from "fastify";
import { Type } from "@sinclair/typebox";
import prisma from "../lib/prisma.js";
import { resolveSession } from "../lib/session.js";
import { overpassFetch } from "../lib/overpass.js";

const OSM_TYPE_MAP: Record<string, string> = {
    W: "way",
    R: "relation",
    N: "node",
};

// lastAccessedAt only needs day-level precision; writing it on every hit made
// each cached read a read plus a write.
const TOUCH_INTERVAL_MS = 24 * 60 * 60 * 1000;

// osmId is interpolated into the Overpass query and used as the cache key, so
// accept only the canonical decimal form of a positive id: anything else could
// inject Overpass QL, and "01"/"001" would each get their own cache row. OSM ids
// are below 2^40 today; 16 digits leaves headroom and stays an exact JS number.
const OSM_ID_PATTERN = "^[1-9][0-9]{0,15}$";

// An empty result (unknown id, or an Overpass timeout that still returned 200)
// isn't worth keeping forever, and caching it would let anyone fill the table
// by walking through ids that don't exist.
async function cacheBoundary(osmId: string, osmType: string, data: any) {
    if (!data?.elements?.length) return;
    await prisma.boundaryCache.create({ data: { osmId, osmType, geojson: data } });
}

async function touchBoundaryCache(entry: { osmId: string; osmType: string; lastAccessedAt: Date }) {
    if (Date.now() - entry.lastAccessedAt.getTime() < TOUCH_INTERVAL_MS) return;
    await prisma.boundaryCache.update({
        where: { osmId_osmType: { osmId: entry.osmId, osmType: entry.osmType } },
        data: { lastAccessedAt: new Date() },
    });
}

export async function boundaryRoutes(app: FastifyInstance) {
    // GET /boundaries/R/12345 — fetch by known OSM ID, cache in DB
    app.get(
        "/:osmType/:osmId",
        {
            schema: {
                params: Type.Object({
                    osmType: Type.Union([
                        Type.Literal("W"),
                        Type.Literal("R"),
                        Type.Literal("N"),
                    ]),
                    osmId: Type.String({ pattern: OSM_ID_PATTERN }),
                }),
            },
        },
        async (req) => {
            await resolveSession(req);
            const { osmType, osmId } = req.params as {
                osmType: "W" | "R" | "N";
                osmId: string;
            };

            const cached = await prisma.boundaryCache.findUnique({
                where: { osmId_osmType: { osmId, osmType } },
            });
            if (cached) {
                await touchBoundaryCache(cached);
                return cached.geojson;
            }

            const response = await overpassFetch(`[out:json];${OSM_TYPE_MAP[osmType]}(${osmId});out geom;`);
            if (!response) throw Object.assign(new Error("Overpass API unavailable"), { statusCode: 502 });

            const data = await response.json();
            await cacheBoundary(osmId, osmType, data);
            return data;
        },
    );

    // GET /boundaries/by-point?lat=X&lng=Y&adminLevel=N
    // Two-phase: lightweight ID query first, then cache check, full geometry only on miss.
    app.get(
        "/by-point",
        {
            schema: {
                querystring: Type.Object({
                    lat: Type.Number(),
                    lng: Type.Number(),
                    adminLevel: Type.Integer({ minimum: 2, maximum: 12 }),
                }),
            },
        },
        async (req) => {
            await resolveSession(req);
            const { lat, lng, adminLevel } = req.query as { lat: number; lng: number; adminLevel: number };

            // Phase 1: get the relation ID only (no geometry — fast)
            const idQuery = `[out:json];is_in(${lat},${lng})->.a;rel(pivot.a)["admin_level"="${adminLevel}"]["boundary"="administrative"];out ids;`;
            const idResponse = await overpassFetch(idQuery);
            if (!idResponse) throw Object.assign(new Error("Overpass API unavailable"), { statusCode: 502 });

            const idData = await idResponse.json();
            const firstEl = (idData.elements as Array<{ type: string; id: number }> | undefined)?.[0];
            if (!firstEl) return { elements: [] };

            const osmId = String(firstEl.id);
            const osmType = firstEl.type === "relation" ? "R" : firstEl.type === "way" ? "W" : "N";

            // Phase 2: check cache
            const cached = await prisma.boundaryCache.findUnique({
                where: { osmId_osmType: { osmId, osmType } },
            });
            if (cached) {
                app.log.info({ osmId, osmType }, "boundary cache hit");
                await touchBoundaryCache(cached);
                return cached.geojson;
            }

            // Phase 3: cache miss — fetch full geometry
            app.log.info({ osmId, osmType, adminLevel }, "boundary cache miss, fetching geometry");
            const geoResponse = await overpassFetch(`[out:json];${OSM_TYPE_MAP[osmType]}(${osmId});out geom;`);
            if (!geoResponse) throw Object.assign(new Error("Overpass API unavailable (geometry)"), { statusCode: 502 });

            const geoData = await geoResponse.json();
            await cacheBoundary(osmId, osmType, geoData);
            return geoData;
        },
    );

}
