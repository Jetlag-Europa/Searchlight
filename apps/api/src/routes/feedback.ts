import type { FastifyInstance } from "fastify";
import { Type } from "@sinclair/typebox";
import prisma from "../lib/prisma.js";
import { resolveSession } from "../lib/session.js";
import { env } from "../lib/env.js";
import { postNewFeedbackWebhook, updateBugReproduceWebhook, updateFeatureVoteWebhook, postBugFixedWebhook } from "../lib/discord-webhook.js";

const MAX_IMAGES = 3;
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;

function isAdmin(userId: string): boolean {
  return env.ADMIN_DISCORD_IDS.split(",").map((s) => s.trim()).filter(Boolean).includes(userId);
}

function notFound(msg = "Not found") {
  return Object.assign(new Error(msg), { statusCode: 404 });
}
function forbidden(msg = "Forbidden") {
  return Object.assign(new Error(msg), { statusCode: 403 });
}

function mapItem(
  i: {
    id: string; type: string; title: string; description: string;
    severity: string | null; status: string; createdAt: Date;
    user: { discordId: string; displayName: string; avatarUrl: string };
    votes: { userId: string; voteType: string; user: { discordId: string; displayName: string } }[];
    images: { id: string }[];
  },
  viewerUserId: string | null,
  includeVoters = false,
) {
  const upvotes = i.votes.filter((v) => v.voteType === "up");
  const downvotes = i.votes.filter((v) => v.voteType === "down");
  const viewerVote = viewerUserId ? (i.votes.find((v) => v.userId === viewerUserId)?.voteType ?? null) : null;
  return {
    id: i.id,
    type: i.type as "bug" | "feature",
    title: i.title,
    description: i.description,
    severity: i.severity ?? undefined,
    status: i.status as "open" | "closed",
    author: { discordId: i.user.discordId, displayName: i.user.displayName, avatarUrl: i.user.avatarUrl },
    upvoteCount: upvotes.length,
    downvoteCount: downvotes.length,
    userVote: viewerVote as "up" | "down" | null,
    ...(includeVoters && { voters: upvotes.map((v) => ({ discordId: v.user.discordId, displayName: v.user.displayName })) }),
    imageIds: i.images.map((img) => img.id),
    createdAt: i.createdAt.toISOString(),
  };
}

const include = {
  user: { select: { discordId: true, displayName: true, avatarUrl: true } },
  votes: { select: { userId: true, voteType: true, user: { select: { discordId: true, displayName: true } } } },
  images: { select: { id: true } },
} as const;

export async function feedbackRoutes(app: FastifyInstance) {
  // GET /feedback — public list of open items sorted by vote count
  app.get("/", {}, async (req) => {
    let userId: string | null = null;
    try { userId = (await resolveSession(req)).user.discordId; } catch { /* unauthenticated */ }

    const items = await prisma.feedback.findMany({
      where: { status: "open" },
      include,
      orderBy: { createdAt: "desc" },
    });

    items.sort((a, b) => b.votes.length - a.votes.length);
    return { items: items.map((i) => mapItem(i, userId)) };
  });

  // GET /feedback/admin — all items including closed (admin only)
  app.get("/admin", {}, async (req) => {
    const { user } = await resolveSession(req);
    if (!isAdmin(user.discordId)) throw forbidden("Admin only");

    const items = await prisma.feedback.findMany({
      include,
      orderBy: { createdAt: "desc" },
    });

    return { items: items.map((i) => mapItem(i, user.discordId, true)) };
  });

  // POST /feedback — create (auth required, images as base64 in body)
  app.post(
    "/",
    {
      bodyLimit: 12 * 1024 * 1024,
      schema: {
        body: Type.Object({
          type: Type.Union([Type.Literal("bug"), Type.Literal("feature")]),
          title: Type.String({ minLength: 1, maxLength: 200 }),
          description: Type.String({ minLength: 1, maxLength: 5000 }),
          severity: Type.Optional(Type.Union([
            Type.Literal("low"), Type.Literal("medium"), Type.Literal("high"),
          ])),
          images: Type.Optional(Type.Array(Type.Object({
            filename: Type.String(),
            mimeType: Type.String(),
            data: Type.String(),
          }), { maxItems: MAX_IMAGES })),
        }),
      },
    },
    async (req, reply) => {
      const { user } = await resolveSession(req);
      const { type, title, description, severity, images = [] } = req.body as {
        type: "bug" | "feature";
        title: string;
        description: string;
        severity?: "low" | "medium" | "high";
        images?: Array<{ filename: string; mimeType: string; data: string }>;
      };

      for (const img of images) {
        if (Buffer.from(img.data, "base64").length > MAX_IMAGE_BYTES) {
          throw Object.assign(new Error(`Image "${img.filename}" exceeds 3 MB`), { statusCode: 400 });
        }
      }

      const feedback = await prisma.$transaction(async (tx) => {
        const created = await tx.feedback.create({
          data: {
            userId: user.discordId,
            type,
            title,
            description,
            severity: type === "bug" ? (severity ?? null) : null,
          },
        });
        if (images.length > 0) {
          await tx.feedbackImage.createMany({
            data: images.map((img) => ({
              feedbackId: created.id,
              filename: img.filename,
              mimeType: img.mimeType,
              data: Buffer.from(img.data, "base64"),
            })),
          });
        }
        return created;
      });

      // Fire webhook and store the Discord message ID (fire-and-forget)
      postNewFeedbackWebhook(feedback, user.displayName)
        .then((messageId) => {
          if (messageId) {
            return prisma.feedback.update({ where: { id: feedback.id }, data: { discordMessageId: messageId } });
          }
        })
        .catch((err) => req.log.warn({ err }, "[webhook] Failed to post feedback webhook"));

      return reply.status(201).send({ id: feedback.id });
    },
  );

  // GET /feedback/images/:imageId — serve image binary (public)
  app.get(
    "/images/:imageId",
    { schema: { params: Type.Object({ imageId: Type.String() }) } },
    async (req, reply) => {
      const { imageId } = req.params as { imageId: string };
      const image = await prisma.feedbackImage.findUnique({ where: { id: imageId } });
      if (!image) return reply.status(404).send();
      return reply
        .header("Content-Type", image.mimeType)
        .header("Cache-Control", "public, max-age=31536000, immutable")
        .send(image.data);
    },
  );

  // POST /feedback/:id/vote — cast/toggle/switch vote (auth required)
  app.post(
    "/:id/vote",
    {
      schema: {
        params: Type.Object({ id: Type.String() }),
        body: Type.Object({ voteType: Type.Union([Type.Literal("up"), Type.Literal("down")]) }),
      },
    },
    async (req, reply) => {
      const { user } = await resolveSession(req);
      const { id } = req.params as { id: string };
      const { voteType } = req.body as { voteType: "up" | "down" };

      const feedback = await prisma.feedback.findUnique({
        where: { id },
        include: { user: { select: { displayName: true } } },
      });
      if (!feedback || feedback.status === "closed") throw notFound();

      const existing = await prisma.feedbackVote.findUnique({
        where: { feedbackId_userId: { feedbackId: id, userId: user.discordId } },
      });

      let newUserVote: "up" | "down" | null;
      if (existing) {
        if (existing.voteType === voteType) {
          await prisma.feedbackVote.delete({ where: { id: existing.id } });
          newUserVote = null;
        } else {
          await prisma.feedbackVote.update({ where: { id: existing.id }, data: { voteType } });
          newUserVote = voteType;
        }
      } else {
        await prisma.feedbackVote.create({ data: { feedbackId: id, userId: user.discordId, voteType } });
        newUserVote = voteType;
      }

      // Update the Discord embed vote counts (fire-and-forget)
      if (feedback.discordMessageId) {
        const messageId = feedback.discordMessageId;
        const authorName = feedback.user.displayName;
        if (feedback.type === "bug") {
          prisma.feedbackVote.count({ where: { feedbackId: id, voteType: "up" } })
            .then((count) => updateBugReproduceWebhook(messageId, feedback, count, authorName))
            .catch((err) => req.log.warn({ err }, "[webhook] Failed to update bug reproduce count"));
        } else {
          Promise.all([
            prisma.feedbackVote.count({ where: { feedbackId: id, voteType: "up" } }),
            prisma.feedbackVote.count({ where: { feedbackId: id, voteType: "down" } }),
          ])
            .then(([up, down]) => updateFeatureVoteWebhook(messageId, feedback, up, down, authorName))
            .catch((err) => req.log.warn({ err }, "[webhook] Failed to update feature vote counts"));
        }
      }

      return reply.status(200).send({ userVote: newUserVote });
    },
  );

  // PATCH /feedback/:id/status — close / reopen (admin only)
  app.patch(
    "/:id/status",
    {
      schema: {
        params: Type.Object({ id: Type.String() }),
        body: Type.Object({ status: Type.Union([Type.Literal("open"), Type.Literal("closed")]) }),
      },
    },
    async (req, reply) => {
      const { user } = await resolveSession(req);
      if (!isAdmin(user.discordId)) throw forbidden("Admin only");

      const { id } = req.params as { id: string };
      const { status } = req.body as { status: "open" | "closed" };

      const feedback = await prisma.feedback.findUnique({ where: { id } });
      if (!feedback) throw notFound();

      await prisma.feedback.update({ where: { id }, data: { status } });

      // Notify Discord when a bug is closed/fixed (fire-and-forget)
      if (status === "closed" && feedback.type === "bug") {
        postBugFixedWebhook(feedback.title, user.displayName)
          .catch((err) => req.log.warn({ err }, "[webhook] Failed to post bug fixed webhook"));
      }

      return reply.status(204).send();
    },
  );
}
