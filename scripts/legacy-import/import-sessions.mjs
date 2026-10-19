// One-off import of the old Searchlight's sessions (the Azure "writemap" prod,
// fork commit c7363de) into the current database. See README.md for the run
// book; this file only depends on @prisma/client and @searchlight/shared, so it
// runs inside the API container against its DATABASE_URL.
//
//   node import-sessions.mjs --export legacy-export.json --map question-map.json \
//     --report report.json [--apply]
//   node import-sessions.mjs --rollback report.json [--apply]
//
// Without --apply the whole import runs in a transaction that is rolled back,
// so the report shows exactly what an applied run would write.
//
// What it imports: sessions (pinned to their game's current revision, with an
// empty event log), participants, questions, strokes, share links and their
// snapshots, and the users they reference that the database doesn't have yet.
// Existing users are left as they are. Questions are remapped with
// question-map.json; one with no equivalent in the current game is dropped
// and listed in the report, since the app would hide it anyway. So is one
// the app's question schema rejects.
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const args = parseArgs(process.argv.slice(2));
const apiDir = args["api-dir"] ?? "/app/apps/api";
const require = createRequire(`${apiDir}/package.json`);
const { PrismaClient } = require("@prisma/client");
const { deriveFeatureQuestionId } = await import(
  pathToFileURL(require.resolve("@searchlight/shared")).href
);

// A tentacle answer names a site; the app matches it to the layer's sites by
// exact coordinates, which the restored layers round to 6 decimals.
const TENTACLE_SNAP_METRES = 250;
const FAMILY_OF = { matching: "matching", measuring: "measuring", tentacles: "tentacles" };
const CUSTOM_TYPES = {
  matching: ["custom-zone", "custom-points"],
  measuring: ["custom-measure"],
  tentacles: ["custom"],
};

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Error(`Unexpected argument ${a}`);
    const key = a.slice(2);
    if (key === "apply") out.apply = true;
    else out[key] = argv[++i];
  }
  return out;
}

// The old columns are timestamps without time zone, written in UTC.
function date(value) {
  if (value == null) return null;
  const s = String(value);
  return new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`);
}

function metresBetween([lng1, lat1], [lng2, lat2]) {
  const rad = Math.PI / 180;
  const a =
    Math.sin(((lat2 - lat1) * rad) / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lng2 - lng1) * rad) / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.sqrt(a));
}

// The question IDs a revision offers, as the web app compiles them, with the
// sites of each tentacle layer.
function offeredQuestions(definition) {
  const ids = new Set();
  const tentacleSites = new Map();
  if (definition.radars === true || (Array.isArray(definition.radars) && definition.radars.length)) {
    ids.add("radius");
  }
  if (definition.thermometer === true) ids.add("thermometer");
  for (const feat of definition.features ?? []) {
    const features = feat.data?.features ?? [];
    const points = features.length > 0 && features.every((f) => f.geometry?.type === "Point");
    for (const kind of feat.enabledFor ?? []) {
      if (kind === "tentacle" && !points) continue;
      const id = deriveFeatureQuestionId(kind, feat.name);
      ids.add(id);
      if (kind === "tentacle") tentacleSites.set(id, features);
    }
  }
  return { ids, tentacleSites };
}

function mapEntry(questionMap, sentinel, family, type, payload) {
  const value = questionMap.games[sentinel]?.questions?.[family]?.[type];
  if (!value) return null;
  if (value.byAdminLevel) {
    return value.byAdminLevel[String(payload?.data?.cat?.adminLevel)] ?? null;
  }
  if (value.adminLevel !== undefined && payload?.data?.cat?.adminLevel !== value.adminLevel) {
    return null;
  }
  return value;
}

// The app loads stored questions without parsing them, so one its question
// schema (apps/web/src/maps/schema.ts) rejects must not be imported. The old
// app saved a few: a cleared radius field (null) and a mistyped longitude.
function malformed(payload) {
  const data = payload?.data;
  if (!data || typeof data !== "object") return "no data";
  const lat = (v) => typeof v === "number" && v >= -90 && v <= 90;
  const lng = (v) => typeof v === "number" && v >= -180 && v <= 180;
  if (payload.id === "thermometer") {
    if (!lat(data.latA) || !lng(data.lngA) || !lat(data.latB) || !lng(data.lngB)) return "position out of range";
    // The thermometer operator can't split the map along a zero-length line.
    if (data.latA === data.latB && data.lngA === data.lngB) return "thermometer start and end are the same point";
    return null;
  }
  if (!lat(data.lat) || !lng(data.lng)) return "position out of range";
  if ((payload.id === "radius" || payload.id === "tentacles") && "radius" in data) {
    if (typeof data.radius !== "number" || data.radius < 0) return `radius is ${JSON.stringify(data.radius)}`;
  }
  return null;
}

// Returns { payload } or { dropped: reason }, plus notes for the report.
function remapQuestion(payload, ctx) {
  const family = payload?.id;
  const bad = malformed(payload);
  if (bad) return { dropped: `malformed: ${bad}`, label: `${family}:${payload?.data?.type ?? payload?.data?.locationType ?? ""}`, status: "malformed" };
  if (family === "radius" || family === "thermometer") {
    if (!ctx.offered.ids.has(family)) return { dropped: `the game has no ${family} question` };
    return { payload, status: "generic" };
  }
  if (!FAMILY_OF[family]) return { dropped: `unknown question family ${family}` };

  const data = { ...payload.data };
  const typeKey = family === "tentacles" ? "locationType" : "type";
  const oldType = data[typeKey];
  if (CUSTOM_TYPES[family].includes(oldType)) {
    if (family === "tentacles" && !Array.isArray(data.places)) {
      return { dropped: "player-drawn tentacle without places" };
    }
    return { payload, status: "custom" };
  }

  const entry = mapEntry(ctx.questionMap, ctx.sentinel, family, oldType, payload);
  const level = data.cat?.adminLevel;
  const label = `${family}:${oldType}${level !== undefined && (oldType === "zone" || oldType === "letter-zone") ? `@${level}` : ""}`;
  if (!entry) return { dropped: `no mapping entry for ${label}`, label };
  if (!entry.questionId) return { dropped: entry.reason ?? entry.status, label, status: entry.status };
  if (!ctx.offered.ids.has(entry.questionId)) {
    return { dropped: `the game doesn't offer ${entry.questionId}`, label };
  }

  data[typeKey] = entry.questionId;
  delete data.cat;
  let snap;
  if (family === "tentacles") {
    // The current layer lists the sites; a stale copy isn't needed.
    delete data.places;
    if (data.location) {
      const sites = ctx.offered.tentacleSites.get(entry.questionId) ?? [];
      const from = data.location.geometry?.coordinates;
      let best = null;
      for (const site of sites) {
        const d = metresBetween(from, site.geometry.coordinates);
        if (!best || d < best.d) best = { site, d };
      }
      snap = {
        from: data.location.properties?.name,
        to: best?.site.properties?.name,
        metres: best ? Math.round(best.d * 10) / 10 : null,
      };
      if (!best || best.d > TENTACLE_SNAP_METRES) {
        return { dropped: `tentacle answer ${snap.from} has no site within ${TENTACLE_SNAP_METRES} m`, label, snap };
      }
      data.location = {
        type: "Feature",
        geometry: { type: "Point", coordinates: best.site.geometry.coordinates },
        ...(best.site.id !== undefined ? { id: best.site.id } : {}),
        properties: { name: best.site.properties?.name ?? data.location.properties?.name },
      };
    }
  }
  return { payload: { ...payload, data }, status: entry.status, label, to: entry.questionId, snap };
}

function remapQuestionList(rows, ctx, onResult) {
  const kept = [];
  for (const row of [...rows].sort((a, b) => a.ordinal - b.ordinal)) {
    const result = remapQuestion(row.payloadJson, ctx);
    onResult(row, result);
    if (result.payload) kept.push({ ...row, payloadJson: result.payload, ordinal: kept.length });
  }
  return kept;
}

function groupBy(rows, key) {
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row[key])) map.set(row[key], []);
    map.get(row[key]).push(row);
  }
  return map;
}

class DryRun extends Error {}

async function runImport(prisma) {
  const legacy = JSON.parse(await readFile(args.export, "utf8"));
  const questionMap = JSON.parse(await readFile(args.map, "utf8"));
  const report = {
    mode: args.apply ? "apply" : "dry-run",
    startedAt: new Date().toISOString(),
    legacyExportedAt: legacy.exportedAt,
    counts: {},
    questionOutcomes: {},
    perGame: {},
    dropped: [],
    tentacleSnaps: [],
    skippedSessions: [],
    createdUserIds: [],
    importedSessionIds: [],
  };
  const bump = (obj, key, n = 1) => (obj[key] = (obj[key] ?? 0) + n);

  const oldGames = new Map(legacy.games.map((g) => [g.id, g]));
  const targetGames = await prisma.game.findMany({
    include: { currentRevision: { select: { id: true, revision: true, definition: true } } },
  });
  const byKey = new Map(targetGames.map((g) => [g.gameKey, g]));

  // Resolve every old game to its current game and revision up front.
  const gameCtx = new Map();
  for (const old of legacy.games) {
    const gameKey = questionMap.games[old.sentinel]?.gameId;
    const target = gameKey && byKey.get(gameKey);
    if (!target?.currentRevision) {
      gameCtx.set(old.id, { error: `no current game for ${old.sentinel}` });
      continue;
    }
    if (target.serverId !== old.serverId) {
      gameCtx.set(old.id, { error: `${gameKey} moved from server ${old.serverId} to ${target.serverId}` });
      continue;
    }
    gameCtx.set(old.id, {
      sentinel: old.sentinel,
      gameKey,
      game: target,
      revisionId: target.currentRevision.id,
      revision: target.currentRevision.revision,
      offered: offeredQuestions(target.currentRevision.definition),
      questionMap,
    });
  }

  const existingSessions = new Set(
    (await prisma.gameSession.findMany({
      where: { id: { in: legacy.sessions.map((s) => s.id) } },
      select: { id: true },
    })).map((s) => s.id),
  );

  const sessions = [];
  for (const s of legacy.sessions) {
    const ctx = gameCtx.get(s.gameId);
    if (existingSessions.has(s.id)) {
      report.skippedSessions.push({ id: s.id, reason: "already in the database" });
    } else if (!ctx || ctx.error) {
      report.skippedSessions.push({ id: s.id, reason: ctx?.error ?? `unknown old game ${s.gameId}` });
    } else {
      sessions.push(s);
    }
  }
  const sessionIds = new Set(sessions.map((s) => s.id));
  const sessionCtx = new Map(sessions.map((s) => [s.id, gameCtx.get(s.gameId)]));
  const inSessions = (rows) => rows.filter((r) => sessionIds.has(r.sessionId));

  const participants = inSessions(legacy.participants);
  const strokes = inSessions(legacy.strokes);
  const links = inSessions(legacy.links);
  const linkIds = new Set(links.map((l) => l.id));
  const snapshots = legacy.linkSnapshots.filter((n) => linkIds.has(n.linkId));
  const linkSession = new Map(links.map((l) => [l.id, l.sessionId]));

  // Questions, remapped per session.
  const questionsBySession = groupBy(inSessions(legacy.questions), "sessionId");
  const questions = [];
  for (const s of sessions) {
    const ctx = sessionCtx.get(s.id);
    const game = (report.perGame[ctx.gameKey] ??= { sessions: 0, questions: 0, kept: 0, dropped: 0 });
    game.sessions++;
    const kept = remapQuestionList(questionsBySession.get(s.id) ?? [], ctx, (row, r) => {
      game.questions++;
      if (r.payload) game.kept++;
      else game.dropped++;
      bump(report.questionOutcomes, r.payload ? r.status ?? "mapped" : "dropped");
      if (!r.payload) {
        report.dropped.push({ sessionId: s.id, game: ctx.gameKey, question: r.label ?? row.payloadJson?.id, reason: r.dropped });
      }
      if (r.snap) report.tentacleSnaps.push({ sessionId: s.id, game: ctx.gameKey, to: r.to, kept: !!r.payload, ...r.snap });
    });
    questions.push(...kept);
  }

  const snapshotRows = snapshots.map((n) => {
    const ctx = sessionCtx.get(linkSession.get(n.linkId));
    const kept = remapQuestionList(n.questions ?? [], ctx, (row, r) => {
      bump(report.questionOutcomes, r.payload ? `snapshot-${r.status ?? "mapped"}` : "snapshot-dropped");
      if (!r.payload) {
        report.dropped.push({ snapshotId: n.id, game: ctx.gameKey, question: r.label ?? row.payloadJson?.id, reason: r.dropped });
      }
    });
    return { ...n, questions: kept, gameRevisionId: ctx.revisionId };
  });

  // Users: everyone the imported rows reference who isn't in the database yet.
  const referenced = new Set([
    ...sessions.map((s) => s.creatorId),
    ...participants.map((p) => p.userId),
    ...strokes.map((k) => k.userId),
    ...links.map((l) => l.createdById),
  ]);
  const existingUsers = new Set(
    (await prisma.user.findMany({ where: { discordId: { in: [...referenced] } }, select: { discordId: true } })).map(
      (u) => u.discordId,
    ),
  );
  const oldUsers = new Map(legacy.users.map((u) => [u.discordId, u]));
  const newUsers = [...referenced].filter((id) => !existingUsers.has(id)).map((id) => {
    const u = oldUsers.get(id);
    if (!u) throw new Error(`Old user ${id} is referenced but not exported`);
    return u;
  });
  report.createdUserIds = newUsers.map((u) => u.discordId);
  report.counts.existingUsersReused = existingUsers.size;

  // Unique keys must not clash with rows the database already has.
  const clashes = [];
  const check = async (label, model, field, values) => {
    if (values.length === 0) return;
    const found = await prisma[model].findMany({ where: { [field]: { in: values } }, select: { [field]: true } });
    if (found.length) clashes.push(`${label}: ${found.length} (e.g. ${found[0][field]})`);
  };
  await check("question ids", "sessionQuestion", "id", questions.map((q) => q.id));
  await check("question clientUuids", "sessionQuestion", "clientUuid", questions.map((q) => q.clientUuid));
  await check("stroke ids", "stroke", "id", strokes.map((k) => k.id));
  await check("stroke clientUuids", "stroke", "clientUuid", strokes.map((k) => k.clientUuid));
  await check("link ids", "sessionLink", "id", links.map((l) => l.id));
  await check("link tokens", "sessionLink", "token", links.map((l) => l.token));
  await check("snapshot ids", "linkSnapshot", "id", snapshotRows.map((n) => n.id));
  if (clashes.length) throw new Error(`Rows clash with existing data:\n  ${clashes.join("\n  ")}`);

  let zeroHiders = 0;
  const run = async (tx) => {
    const many = async (model, data) => {
      for (let i = 0; i < data.length; i += 500) {
        await tx[model].createMany({ data: data.slice(i, i + 500) });
      }
      report.counts[model] = data.length;
    };
    await many(
      "user",
      newUsers.map((u) => ({
        discordId: u.discordId,
        username: u.username,
        displayName: u.displayName,
        avatarUrl: u.avatarUrl,
        // Nothing reads the OAuth tokens after login; the next login sets them.
        discordAccessToken: "",
        discordRefreshToken: "",
        discordTokenExpiresAt: new Date(0),
        ...(u.preferences ? { preferences: u.preferences } : {}),
        createdAt: date(u.createdAt),
        updatedAt: date(u.updatedAt),
      })),
    );
    await many(
      "gameSession",
      sessions.map((s) => {
        const ctx = sessionCtx.get(s.id);
        // Like migration 20261017003000: (0, 0) meant "no hider position".
        const zero = s.hiderLat === 0 && s.hiderLng === 0;
        if (zero) zeroHiders++;
        return {
          id: s.id,
          gameId: ctx.game.id,
          serverId: ctx.game.serverId,
          creatorId: s.creatorId,
          name: s.name,
          visibility: s.visibility,
          hiderLat: zero ? null : s.hiderLat,
          hiderLng: zero ? null : s.hiderLng,
          planningModeEnabled: s.planningModeEnabled,
          gameRevisionId: ctx.revisionId,
          eventSequence: 0,
          createdAt: date(s.createdAt),
          updatedAt: date(s.updatedAt),
        };
      }),
    );
    await many(
      "sessionParticipant",
      participants.map((p) => ({
        sessionId: p.sessionId,
        userId: p.userId,
        role: p.role,
        invitedAt: date(p.invitedAt),
        acceptedAt: date(p.acceptedAt),
        revokedAt: date(p.revokedAt),
      })),
    );
    await many(
      "sessionQuestion",
      questions.map((q) => ({
        id: q.id,
        sessionId: q.sessionId,
        payloadJson: q.payloadJson,
        ordinal: q.ordinal,
        clientUuid: q.clientUuid,
        createdAt: date(q.createdAt),
        updatedAt: date(q.updatedAt),
      })),
    );
    await many(
      "stroke",
      strokes.map((k) => ({
        id: k.id,
        sessionId: k.sessionId,
        userId: k.userId,
        payloadJson: k.payloadJson,
        clientUuid: k.clientUuid,
        createdAt: date(k.createdAt),
        deletedAt: date(k.deletedAt),
      })),
    );
    await many(
      "sessionLink",
      links.map((l) => ({
        id: l.id,
        token: l.token,
        sessionId: l.sessionId,
        createdById: l.createdById,
        linkType: l.linkType,
        revokedAt: date(l.revokedAt),
        createdAt: date(l.createdAt),
      })),
    );
    await many(
      "linkSnapshot",
      snapshotRows.map((n) => ({
        id: n.id,
        linkId: n.linkId,
        questions: n.questions.map((q) => ({ payloadJson: q.payloadJson, ordinal: q.ordinal, clientUuid: q.clientUuid })),
        gameRevisionId: n.gameRevisionId,
        createdAt: date(n.createdAt),
      })),
    );
    report.counts.zeroHiderPositionsCleared = zeroHiders;
    report.importedSessionIds = sessions.map((s) => s.id);
    report.revisions = Object.fromEntries(
      [...gameCtx.values()].filter((c) => !c.error).map((c) => [c.gameKey, c.revision]),
    );
    if (!args.apply) throw new DryRun();
  };

  try {
    await prisma.$transaction(run, { timeout: 300_000, maxWait: 30_000 });
  } catch (err) {
    if (!(err instanceof DryRun)) throw err;
  }
  report.finishedAt = new Date().toISOString();
  return report;
}

// Deletes what an applied import created: its sessions (participants,
// questions, strokes, links and snapshots cascade) and the users it created
// that have nothing else in the database since.
async function runRollback(prisma) {
  const imported = JSON.parse(await readFile(args.rollback, "utf8"));
  if (imported.mode !== "apply") throw new Error("That report is from a dry run; nothing to roll back");
  const report = { mode: args.apply ? "rollback" : "rollback-dry-run", sessions: 0, users: 0, keptUsers: [] };
  const run = async (tx) => {
    report.sessions = (await tx.gameSession.deleteMany({ where: { id: { in: imported.importedSessionIds } } })).count;
    for (const discordId of imported.createdUserIds) {
      const u = await tx.user.findUnique({
        where: { discordId },
        include: {
          _count: {
            select: {
              sessions: true,
              createdSessions: true,
              sessionParticipants: true,
              strokes: true,
              events: true,
              createdLinks: true,
              createdGameLinks: true,
            },
          },
        },
      });
      if (!u) continue;
      if (Object.values(u._count).some((n) => n > 0)) {
        report.keptUsers.push(discordId);
        continue;
      }
      await tx.serverMembershipCache.deleteMany({ where: { userId: discordId } });
      await tx.user.delete({ where: { discordId } });
      report.users++;
    }
    if (!args.apply) throw new DryRun();
  };
  try {
    await prisma.$transaction(run, { timeout: 300_000 });
  } catch (err) {
    if (!(err instanceof DryRun)) throw err;
  }
  return report;
}

const prisma = new PrismaClient();
try {
  if (args.rollback) {
    console.log(JSON.stringify(await runRollback(prisma), null, 2));
  } else {
    if (!args.export || !args.map || !args.report) {
      throw new Error("usage: import-sessions.mjs --export <json> --map <question-map.json> --report <out.json> [--apply]");
    }
    const report = await runImport(prisma);
    await writeFile(args.report, JSON.stringify(report, null, 2));
    const { dropped, tentacleSnaps, skippedSessions, createdUserIds, importedSessionIds, ...summary } = report;
    console.log(
      JSON.stringify(
        {
          ...summary,
          sessions: importedSessionIds.length,
          skippedSessions: skippedSessions.length,
          createdUsers: createdUserIds.length,
          droppedQuestions: dropped.length,
          tentacleSnapsOver1m: tentacleSnaps.filter((t) => t.metres > 1).length,
        },
        null,
        2,
      ),
    );
  }
} finally {
  await prisma.$disconnect();
}
