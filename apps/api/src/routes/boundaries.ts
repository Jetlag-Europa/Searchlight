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

export async function boundaryRoutes(app: FastifyInstance) {
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

            const query = `[out:json];${OSM_TYPE_MAP[osmType]}(${osmId});out geom;`;
            const encoded = encodeURIComponent(query);

            const tryFetch = (url: string) =>
                fetch(`${url}?data=${encoded}`, {
                    headers: { "User-Agent": "TaibledFork/1.0" },
                    signal: AbortSignal.timeout(OVERPASS_TIMEOUT_MS),
                });

            let response = await tryFetch(OVERPASS_PRIMARY).catch(() => null);
            if (!response?.ok) {
                response = await tryFetch(OVERPASS_FALLBACK).catch(() => null);
            }
            if (!response?.ok) {
                throw Object.assign(
                    new Error("Overpass API unavailable"),
                    { statusCode: 502 },
                );
            }

            const data = await response.json();

            await prisma.boundaryCache.create({
                data: { osmId, osmType, geojson: data },
            });

            return data;
        },
    );
}
