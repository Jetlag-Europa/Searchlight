import { env } from "./env.js";

// Identity the feedback webhook posts under. `username`/`avatar_url` are only
// honoured by Discord on message *create* (POST), not on edits (PATCH) — edited
// messages keep the identity they were created with. `avatar_url` must be a
// publicly reachable URL, so we serve the logo from the web app's public dir
// (per-origin, so dev and live each use their own host).
const WEBHOOK_IDENTITY = {
  username: "Searchlight",
  avatar_url: `${env.FRONTEND_ORIGIN}/searchlight.png`,
};

const SEVERITY_LABEL: Record<string, string> = {
  low: "🟡 Low",
  medium: "🟠 Medium",
  high: "🔴 High",
};

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1) + "…";
}

function feedbackUrl(): string {
  return `${env.FRONTEND_ORIGIN}/feedback`;
}

function envLabel(): string {
  return env.FRONTEND_ORIGIN.includes("dev.") ? "Dev" : "Live";
}

function bugEmbed(
  feedback: { title: string; description: string; severity: string | null },
  reproduceCount: number,
  authorName: string,
) {
  return {
    title: "🐛 New Bug Report",
    url: feedbackUrl(),
    color: 0xed4245,
    fields: [
      { name: "Title", value: feedback.title, inline: false },
      {
        name: "Severity",
        value: feedback.severity ? (SEVERITY_LABEL[feedback.severity] ?? feedback.severity) : "Not specified",
        inline: true,
      },
      { name: "Reproduces", value: String(reproduceCount), inline: true },
      { name: "Description", value: truncate(feedback.description, 500), inline: false },
      { name: "​", value: `[🔗 View Feedback Page](${feedbackUrl()})`, inline: false },
    ],
    footer: { text: `Submitted by ${authorName} · ${envLabel()}` },
    timestamp: new Date().toISOString(),
  };
}

function featureEmbed(
  feedback: { title: string; description: string },
  upvoteCount: number,
  downvoteCount: number,
  authorName: string,
) {
  return {
    title: "✨ New Feature Request",
    url: feedbackUrl(),
    color: 0x5865f2,
    fields: [
      { name: "Title", value: feedback.title, inline: false },
      { name: "Description", value: truncate(feedback.description, 500), inline: false },
      { name: "▲ Upvotes", value: String(upvoteCount), inline: true },
      { name: "▼ Downvotes", value: String(downvoteCount), inline: true },
      { name: "​", value: `[🔗 View Feedback Page](${feedbackUrl()})`, inline: false },
    ],
    footer: { text: `Submitted by ${authorName} · ${envLabel()}` },
    timestamp: new Date().toISOString(),
  };
}

function featureClosedEmbed(feedbackTitle: string, resolution: "added" | "denied", closedByName: string) {
  const added = resolution === "added";
  return {
    title: added ? "✅ Feature Added" : "❌ Feature Denied",
    url: feedbackUrl(),
    color: added ? 0x57f287 : 0xed4245,
    fields: [
      { name: "Title", value: feedbackTitle, inline: false },
      { name: "​", value: `[🔗 View Feedback Page](${feedbackUrl()})`, inline: false },
    ],
    footer: { text: `Marked as ${added ? "added" : "denied"} by ${closedByName} · ${envLabel()}` },
    timestamp: new Date().toISOString(),
  };
}

function bugFixedEmbed(feedbackTitle: string, closedByName: string) {
  return {
    title: "✅ Bug Fixed",
    url: feedbackUrl(),
    color: 0x57f287,
    fields: [
      { name: "Title", value: feedbackTitle, inline: false },
      { name: "​", value: `[🔗 View Feedback Page](${feedbackUrl()})`, inline: false },
    ],
    footer: { text: `Marked as fixed by ${closedByName} · ${envLabel()}` },
    timestamp: new Date().toISOString(),
  };
}

async function patchWebhookMessage(messageId: string, body: object): Promise<void> {
  const res = await fetch(`${env.DISCORD_FEEDBACK_WEBHOOK_URL}/messages/${messageId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Webhook PATCH failed: ${res.status}`);
}

export async function postNewFeedbackWebhook(
  feedback: { type: string; title: string; description: string; severity: string | null },
  authorName: string,
): Promise<string | null> {
  if (!env.DISCORD_FEEDBACK_WEBHOOK_URL) return null;

  const embed = feedback.type === "bug"
    ? bugEmbed(feedback, 0, authorName)
    : featureEmbed(feedback, 0, 0, authorName);

  const res = await fetch(`${env.DISCORD_FEEDBACK_WEBHOOK_URL}?wait=true`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...WEBHOOK_IDENTITY, embeds: [embed] }),
  });

  if (!res.ok) throw new Error(`Webhook POST failed: ${res.status}`);

  const data = await res.json() as { id: string };
  return data.id;
}

export async function updateBugReproduceWebhook(
  messageId: string,
  feedback: { title: string; description: string; severity: string | null },
  reproduceCount: number,
  authorName: string,
): Promise<void> {
  if (!env.DISCORD_FEEDBACK_WEBHOOK_URL) return;
  await patchWebhookMessage(messageId, { embeds: [bugEmbed(feedback, reproduceCount, authorName)] });
}

export async function updateFeatureVoteWebhook(
  messageId: string,
  feedback: { title: string; description: string },
  upvoteCount: number,
  downvoteCount: number,
  authorName: string,
): Promise<void> {
  if (!env.DISCORD_FEEDBACK_WEBHOOK_URL) return;
  await patchWebhookMessage(messageId, { embeds: [featureEmbed(feedback, upvoteCount, downvoteCount, authorName)] });
}

export async function postFeatureClosedWebhook(feedbackTitle: string, resolution: "added" | "denied", closedByName: string): Promise<void> {
  if (!env.DISCORD_FEEDBACK_WEBHOOK_URL) return;

  const res = await fetch(env.DISCORD_FEEDBACK_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...WEBHOOK_IDENTITY, embeds: [featureClosedEmbed(feedbackTitle, resolution, closedByName)] }),
  });

  if (!res.ok) throw new Error(`Webhook POST failed: ${res.status}`);
}

export async function postBugFixedWebhook(feedbackTitle: string, closedByName: string): Promise<void> {
  if (!env.DISCORD_FEEDBACK_WEBHOOK_URL) return;

  const res = await fetch(env.DISCORD_FEEDBACK_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...WEBHOOK_IDENTITY, embeds: [bugFixedEmbed(feedbackTitle, closedByName)] }),
  });

  if (!res.ok) throw new Error(`Webhook POST failed: ${res.status}`);
}
