import type { FastifyInstance } from "fastify";
import { Type } from "@sinclair/typebox";
import { resolveSession } from "../lib/session.js";
import { overpassJson } from "../lib/overpass.js";

// POST /overpass — generic Overpass proxy. The frontend funnels every Overpass
// query through here so requests reach the self-hosted instance (LocalOverpass,
// possibly behind Cloudflare Access) instead of the browser hitting public servers
// directly — the browser can't safely hold the CF-Access service token. Auth is
// enforced via resolveSession (throws 401 when unauthenticated), so this is not an
// open proxy. The raw Overpass JSON is returned unchanged.
export async function overpassRoutes(app: FastifyInstance) {
    app.post(
        "/overpass",
        {
            schema: {
                body: Type.Object({
                    query: Type.String({ minLength: 1, maxLength: 100_000 }),
                }),
            },
        },
        async (req) => {
            await resolveSession(req);
            const { query } = req.body as { query: string };
            // Frontend queries use [timeout:60] and can be heavy (large poly: zone
            // filters); allow more headroom than the boundary-route default.
            return overpassJson(query, { timeoutMs: 90_000 });
        },
    );
}
