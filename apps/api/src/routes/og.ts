import type { FastifyInstance } from "fastify";
import { Type } from "@sinclair/typebox";
import prisma from "../lib/prisma.js";
import { env } from "../lib/env.js";
import { findActiveLink } from "../lib/game-access.js";
import { gameMapPng, OG_IMAGE_HEIGHT, OG_IMAGE_WIDTH } from "../lib/og-map.js";

// Link previews. Discord, Slack and the like read a page's Open Graph tags
// without running its scripts, so the web app's static /play page shows them
// only the site-wide tags. The web server sends their requests for /play here
// instead (apps/web/nginx.conf), and serves /og/ from here for the image, so
// these URLs are on the web app's origin.

const SITE_NAME = "Searchlight";

function notFound(msg = "Not found") {
  return Object.assign(new Error(msg), { statusCode: 404 });
}
const THEME_COLOR = "#1F2F3F";

function escapeHtml(text: string) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

interface Preview {
  title: string;
  description: string;
  url: string;
  // The link a person sees if a browser of theirs is taken for a bot. /play
  // would serve them this page again; /play/index.html is the app's page.
  pageUrl: string;
  image?: { url: string; alt: string };
}

function previewPage({ title, description, url, pageUrl, image }: Preview) {
  const meta = (attr: "name" | "property", key: string, content: string) =>
    `<meta ${attr}="${key}" content="${escapeHtml(content)}" />`;
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8" />',
    `<title>${escapeHtml(title)}</title>`,
    meta("name", "robots", "noindex"),
    meta("name", "description", description),
    meta("name", "theme-color", THEME_COLOR),
    meta("property", "og:site_name", SITE_NAME),
    meta("property", "og:type", "website"),
    meta("property", "og:url", url),
    meta("property", "og:title", title),
    meta("property", "og:description", description),
    ...(image
      ? [
          meta("property", "og:image", image.url),
          meta("property", "og:image:type", "image/png"),
          meta("property", "og:image:width", String(OG_IMAGE_WIDTH)),
          meta("property", "og:image:height", String(OG_IMAGE_HEIGHT)),
          meta("property", "og:image:alt", image.alt),
          meta("name", "twitter:card", "summary_large_image"),
          meta("name", "twitter:image", image.url),
          meta("name", "twitter:image:alt", image.alt),
        ]
      : [meta("name", "twitter:card", "summary")]),
    meta("name", "twitter:title", title),
    meta("name", "twitter:description", description),
    "</head>",
    "<body>",
    `<p><a href="${escapeHtml(pageUrl)}">${escapeHtml(title)}</a></p>`,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

export async function ogRoutes(app: FastifyInstance) {
  // GET /og/play?token= — the preview page for a game link
  app.get(
    "/play",
    { schema: { querystring: Type.Object({ token: Type.Optional(Type.String()) }) } },
    async (req, reply) => {
      const { token } = req.query as { token?: string };
      const url = new URL("/play", env.FRONTEND_ORIGIN);
      const pageUrl = new URL("/play/index.html", env.FRONTEND_ORIGIN);
      if (token) {
        url.searchParams.set("token", token);
        pageUrl.searchParams.set("token", token);
      }

      const link = token ? await findActiveLink(token) : null;
      const revision = link?.game.currentRevision;
      let preview: Preview;
      if (!link || !revision) {
        preview = {
          title: "Link no longer active",
          description: "This game link has been revoked or doesn't exist.",
          url: url.href,
          pageUrl: pageUrl.href,
        };
      } else {
        const { name, server } = link.game;
        // The revision in the image's URL makes a new revision a new image,
        // which platforms that cache images by URL then fetch.
        const image = new URL(
          `/og/game-links/${encodeURIComponent(link.token)}/map.png`,
          env.FRONTEND_ORIGIN,
        );
        image.searchParams.set("v", revision.id);
        preview = {
          title: name,
          description: `Start a session of ${name} from ${server.name} in ${SITE_NAME}, a map planner for Jet Lag: The Game's Hide and Seek.`,
          url: url.href,
          pageUrl: pageUrl.href,
          image: { url: image.href, alt: `Map of ${name}` },
        };
      }

      return reply
        .header("Cache-Control", "no-cache")
        .header("X-Robots-Tag", "noindex")
        .type("text/html; charset=utf-8")
        .send(previewPage(preview));
    },
  );

  // GET /og/game-links/:token/map.png — the game's map, for the preview
  app.get(
    "/game-links/:token/map.png",
    { schema: { params: Type.Object({ token: Type.String() }) } },
    async (req, reply) => {
      const { token } = req.params as { token: string };
      const link = await findActiveLink(token);
      const revisionId = link?.game.currentRevision?.id;
      if (!revisionId) throw notFound("Link is invalid or has been revoked");

      // Only the parts the image draws: a game's question datasets can run
      // to megabytes.
      const png = await gameMapPng(revisionId, async () => {
        const [row] = await prisma.$queryRaw<{ playArea: unknown; zones: unknown }[]>`
          SELECT definition->'map'->'playArea' AS "playArea",
                 definition->'hidingZones'->'features' AS "zones"
          FROM "GameRevision" WHERE id = ${revisionId}`;
        return row && { map: { playArea: row.playArea }, hidingZones: { features: row.zones } };
      });
      if (!png) throw notFound("This game has no play area");

      return reply
        // Short enough that a revoked link's image soon stops being served
        // from caches, such as Cloudflare's.
        .header("Cache-Control", "public, max-age=3600")
        .header("X-Robots-Tag", "noindex")
        .type("image/png")
        .send(png);
    },
  );
}
