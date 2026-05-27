import type { FastifyInstance } from "fastify";
import { Type } from "@sinclair/typebox";
import prisma from "../lib/prisma.js";
import { resolveSession } from "../lib/session.js";

const OVERPASS_PRIMARY = "https://overpass-api.de/api/interpreter";
const OVERPASS_FALLBACK = "https://overpass.kumi.systems/api/interpreter";
const OVERPASS_TIMEOUT_MS = 30_000;

const OSM_TYPE_MAP: Record<string, string> = {
    W: "way",
    R: "relation",
    N: "node",
};

async function overpassFetch(query: string): Promise<Response | null> {
    const encoded = encodeURIComponent(query);
    const opts = {
        headers: { "User-Agent": "TaibledFork/1.0" },
        signal: AbortSignal.timeout(OVERPASS_TIMEOUT_MS),
    };
    const primary = await fetch(`${OVERPASS_PRIMARY}?data=${encoded}`, opts).catch(() => null);
    if (primary?.ok) return primary;
    const fallback = await fetch(`${OVERPASS_FALLBACK}?data=${encoded}`, opts).catch(() => null);
    return fallback?.ok ? fallback : null;
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
                    osmId: Type.String({ minLength: 1 }),
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
                await prisma.boundaryCache.update({
                    where: { osmId_osmType: { osmId, osmType } },
                    data: { lastAccessedAt: new Date() },
                });
                return cached.geojson;
            }

            const response = await overpassFetch(`[out:json];${OSM_TYPE_MAP[osmType]}(${osmId});out geom;`);
            if (!response) throw Object.assign(new Error("Overpass API unavailable"), { statusCode: 502 });

            const data = await response.json();
            await prisma.boundaryCache.create({ data: { osmId, osmType, geojson: data } });
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
                await prisma.boundaryCache.update({
                    where: { osmId_osmType: { osmId, osmType } },
                    data: { lastAccessedAt: new Date() },
                });
                return cached.geojson;
            }

            // Phase 3: cache miss — fetch full geometry
            app.log.info({ osmId, osmType, adminLevel }, "boundary cache miss, fetching geometry");
            const geoResponse = await overpassFetch(`[out:json];${OSM_TYPE_MAP[osmType]}(${osmId});out geom;`);
            if (!geoResponse) throw Object.assign(new Error("Overpass API unavailable (geometry)"), { statusCode: 502 });

            const geoData = await geoResponse.json();
            await prisma.boundaryCache.create({ data: { osmId, osmType, geojson: geoData } });
            return geoData;
        },
    );
}
