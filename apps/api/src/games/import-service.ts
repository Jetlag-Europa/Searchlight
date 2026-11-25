import { Prisma } from "@prisma/client";
import {
  CASUAL_GAME_LIMIT,
  CASUAL_SERVER_ID,
  CASUAL_STORAGE_LIMIT_MB,
  computeGameDefinitionChecksum,
  type ExistingGameComparison,
  type GameDefinition,
  type GameImportResponse,
  resolveGameDefinitionId,
  validateGameDefinition,
  type ValidationIssue,
} from "@searchlight/shared";
import prisma from "../lib/prisma.js";
import { audit } from "../lib/audit.js";
import { broadcast } from "../lib/broadcaster.js";
import { isAdmin } from "../lib/permissions.js";
import { compareWithExisting } from "./compare-games.js";

// GameRevision.revision is a PostgreSQL integer.
const MAX_REVISION = 2_147_483_647;

// What an update needs of the game it changes.
const GAME_LOOKUP = { id: true, serverId: true, createdById: true } as const;

export interface ImportActor {
  userId: string;
  canCreateGames(serverId: string): boolean | Promise<boolean>;
  canEditGames(serverId: string): boolean | Promise<boolean>;
}

export interface ImportGameDefinitionParams {
  raw: unknown;
  source?: "api" | "web" | "preload";
  actor?: ImportActor;
  dryRun?: boolean;
  expectedServerId?: string;
  allowUpdate?: boolean;
  // The id of the existing game's revision the caller previewed: an update
  // refuses (409 GAME_CHANGED) if the game has moved on since, rather than
  // replace what they didn't see.
  expectedCurrentRevisionId?: string;
  // For a new game only: an existing game keeps its listing. Casual games
  // are always unlisted.
  unlisted?: boolean;
}

export class ImportConflictError extends Error {
  code: string;
  statusCode: number;
  canUpdate?: boolean;
  existingRevision?: number;
  existing?: ExistingGameComparison;

  constructor(
    message: string,
    code: string,
    canUpdate = false,
    existingRevision?: number,
    existing?: ExistingGameComparison,
  ) {
    super(message);
    this.name = "ImportConflictError";
    this.code = code;
    this.statusCode = 409;
    this.canUpdate = canUpdate;
    this.existingRevision = existingRevision;
    this.existing = existing;
  }
}

export class ImportValidationError extends Error {
  code: string;
  statusCode: number;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];

  constructor(errors: ValidationIssue[], warnings: ValidationIssue[]) {
    super(`Game definition validation failed with ${errors.length} error(s)`);
    this.name = "ImportValidationError";
    this.code = "VALIDATION_FAILED";
    this.statusCode = 400;
    this.errors = errors;
    this.warnings = warnings;
  }
}

export class ImportForbiddenError extends Error {
  code: string;
  statusCode: number;

  constructor(message: string, code = "FORBIDDEN") {
    super(message);
    this.name = "ImportForbiddenError";
    this.code = code;
    this.statusCode = 403;
  }
}

interface ImportContext {
  def: GameDefinition;
  gameKey: string;
  checksum: string;
  warnings: ValidationIssue[];
  source: "api" | "web" | "preload";
  actor?: ImportActor;
  dryRun: boolean;
  allowUpdate: boolean;
  // Refuse the update (409 GAME_CHANGED) unless this is still the current
  // revision once the game is locked: the revision an import previewed, or
  // the one a settings edit started from.
  expectedCurrentRevisionId?: string;
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

// Imports of a game are serialized, and losing the race to create one is
// retried as an update, so this is a safety net: report a conflict rather
// than leak the database error.
function concurrentImport(err: unknown): never {
  if (isUniqueViolation(err)) {
    throw new ImportConflictError(
      "The game was changed by a concurrent import. Try again.",
      "CONCURRENT_IMPORT",
    );
  }
  throw err;
}

// Casual games are open to anyone in one of the registered servers, so each
// creator's share is capped (global admins aren't). Tests lower these.
export const CASUAL_LIMITS = {
  games: CASUAL_GAME_LIMIT,
  bytes: CASUAL_STORAGE_LIMIT_MB * 1024 * 1024,
};

// Whose Casual limits a change to a game on this server counts against, if anyone's.
function limitedUser(serverId: string, actor: ImportActor | undefined): string | null {
  return serverId === CASUAL_SERVER_ID && actor && !isAdmin(actor.userId) ? actor.userId : null;
}

// Serializes a user's Casual writes, so two of them can't both pass the
// limits. NO KEY UPDATE: inserts referencing the user (sessions, events) take
// KEY SHARE, which FOR UPDATE would block or deadlock with.
async function lockUser(tx: Prisma.TransactionClient, userId: string): Promise<void> {
  await tx.$queryRaw`SELECT 1 FROM "User" WHERE "discordId" = ${userId} FOR NO KEY UPDATE`;
}

// The user's Casual games that aren't deleted, and the bytes as stored of all
// their revisions, deleted games' included (else create, play, delete, repeat
// would evade the cap).
async function casualUsage(
  db: Prisma.TransactionClient,
  userId: string,
): Promise<{ games: number; bytes: number }> {
  const [row] = await db.$queryRaw<{ games: number; bytes: bigint }[]>`
    SELECT COUNT(DISTINCT g.id) FILTER (WHERE g."archivedAt" IS NULL)::int AS games,
      COALESCE(SUM(pg_column_size(r.definition)), 0)::bigint AS bytes
    FROM "Game" g LEFT JOIN "GameRevision" r ON r."gameId" = g.id
    WHERE g."serverId" = ${CASUAL_SERVER_ID} AND g."createdById" = ${userId}
  `;
  return { games: row.games, bytes: Number(row.bytes) };
}

function casualGameLimit(): ImportConflictError {
  return new ImportConflictError(
    `You already have ${CASUAL_LIMITS.games} Casual games. Delete one to upload another.`,
    "CASUAL_GAME_LIMIT",
  );
}

/**
 * Throws unless the user's Casual games, with this transaction's change, stay
 * within the limits. Under lockUser. `createsGame` also checks the game count.
 */
async function assertCasualLimits(
  tx: Prisma.TransactionClient,
  userId: string,
  createsGame: boolean,
): Promise<void> {
  let usage = await casualUsage(tx, userId);
  if (createsGame && usage.games > CASUAL_LIMITS.games) throw casualGameLimit();
  if (usage.bytes <= CASUAL_LIMITS.bytes) return;
  // Revisions whose last user went without a prune (it is best effort after a
  // session delete, and absent after upgrades and fork revokes) still count:
  // prune them all before refusing.
  const games = await tx.game.findMany({
    where: { serverId: CASUAL_SERVER_ID, createdById: userId },
    select: { id: true },
    orderBy: { id: "asc" },
  });
  for (const { id } of games) await pruneGame(tx, id);
  usage = await casualUsage(tx, userId);
  if (usage.bytes > CASUAL_LIMITS.bytes) {
    const mb = (bytes: number) => Math.ceil(bytes / (1024 * 1024));
    throw Object.assign(
      new Error(
        `This would bring your Casual games to ${mb(usage.bytes)} MB, over the ${mb(CASUAL_LIMITS.bytes)} MB allowed. Versions that existing sessions still use count toward it. Try a smaller file, or delete a game nobody is playing.`,
      ),
      { statusCode: 413, code: "CASUAL_STORAGE_LIMIT" },
    );
  }
}

/**
 * Deletes the revisions of a Casual or deleted game that nothing uses: not
 * current, no session or active fork link on them, and while the game lives,
 * not its highest (that number must not come back with other content). A
 * deleted game goes with its last session. Official games keep every
 * revision: their managers re-activate old files.
 */
export async function pruneGame(tx: Prisma.TransactionClient, gameId: string): Promise<void> {
  // Serializes with imports, which could otherwise make a revision current
  // while it is deleted here.
  await tx.$queryRaw`SELECT 1 FROM "Game" WHERE id = ${gameId} FOR UPDATE`;
  // SKIP LOCKED: a session being created on a revision holds a lock on it.
  await tx.$executeRaw`
    DELETE FROM "GameRevision" WHERE id IN (
      SELECT r.id FROM "GameRevision" r JOIN "Game" g ON g.id = r."gameId"
      WHERE r."gameId" = ${gameId}
        AND (g."serverId" = ${CASUAL_SERVER_ID} OR g."archivedAt" IS NOT NULL)
        AND r.id IS DISTINCT FROM g."currentRevisionId"
        AND (g."archivedAt" IS NOT NULL
          OR r.revision < (SELECT max(revision) FROM "GameRevision" WHERE "gameId" = ${gameId}))
        AND NOT EXISTS (SELECT 1 FROM "GameSession" s WHERE s."gameRevisionId" = r.id)
        AND NOT EXISTS (
          SELECT 1 FROM "LinkSnapshot" l JOIN "SessionLink" sl ON sl.id = l."linkId"
          WHERE l."gameRevisionId" = r.id AND sl."revokedAt" IS NULL)
      FOR UPDATE OF r SKIP LOCKED)
  `;
  await tx.$executeRaw`
    DELETE FROM "Game" WHERE id = ${gameId} AND "archivedAt" IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM "GameSession" WHERE "gameId" = ${gameId})
  `;
}

/**
 * Validates, authorizes, and transactionally imports or updates a GameDefinition document.
 */
export async function importGameDefinition(
  params: ImportGameDefinitionParams,
): Promise<GameImportResponse> {
  return importDefinition(params).catch(concurrentImport);
}

function serverNotFound(serverId: string, warnings: ValidationIssue[]): ImportValidationError {
  return new ImportValidationError(
    [
      {
        path: "/serverId",
        code: "SERVER_NOT_FOUND",
        message: `Target server "${serverId}" does not exist in the database`,
      },
    ],
    warnings,
  );
}

async function importDefinition(
  params: ImportGameDefinitionParams,
): Promise<GameImportResponse> {
  const {
    raw,
    source = "api",
    actor,
    dryRun = false,
    expectedServerId,
    allowUpdate = false,
    expectedCurrentRevisionId,
    unlisted = false,
  } = params;

  // 1. Authorize against the target server before validating: validation is
  // costly for multi-MB definitions, and its detailed report is only for
  // callers who may import games there.
  if (actor) {
    const serverId = (raw as { serverId?: unknown } | null)?.serverId;
    if (typeof serverId !== "string" || !serverId) {
      throw new ImportValidationError(
        [{ path: "/serverId", code: "SCHEMA_VALIDATION_ERROR", message: "serverId is required" }],
        [],
      );
    }
    // An unregistered server has no permissions to look up, and caching a
    // Discord lookup for it would violate the membership cache's foreign key.
    if (!(await prisma.server.findUnique({ where: { id: serverId }, select: { id: true } }))) {
      throw serverNotFound(serverId, []);
    }
    if (!(await actor.canCreateGames(serverId)) && !(await actor.canEditGames(serverId))) {
      throw new ImportForbiddenError(
        "You do not have permission to import games on this server",
      );
    }
  }

  // 2. Validate document structure & semantics
  const validation = validateGameDefinition(raw);
  if (!validation.valid) {
    throw new ImportValidationError(validation.errors, validation.warnings);
  }

  const def = raw as GameDefinition;
  const gameKey = resolveGameDefinitionId(def);
  const revision = def.revision ?? 1;

  // 3. Validate target server
  if (expectedServerId && expectedServerId !== def.serverId) {
    throw new ImportValidationError(
      [
        {
          path: "/serverId",
          code: "SERVER_MISMATCH",
          message: `Document serverId "${def.serverId}" does not match expected serverId "${expectedServerId}"`,
        },
      ],
      validation.warnings,
    );
  }

  const server = await prisma.server.findUnique({
    where: { id: def.serverId },
  });
  if (!server) {
    throw serverNotFound(def.serverId, validation.warnings);
  }

  // A file's id is unique among its scope's games: the server's, and on
  // Casual Games the importer's own. An import with no one behind it (a
  // preload) would make a Casual game that is nobody's.
  const ownerScope = def.serverId === CASUAL_SERVER_ID ? actor?.userId : "";
  if (ownerScope === undefined) {
    throw new ImportValidationError(
      [
        {
          path: "/serverId",
          code: "CASUAL_PRELOAD",
          message:
            "Casual games can't be preloaded: each one belongs to whoever uploads it. Upload the file on the import page instead.",
        },
      ],
      validation.warnings,
    );
  }
  const inScope = {
    serverId_ownerScope_gameKey: { serverId: def.serverId, ownerScope, gameKey },
  };

  const ctx: ImportContext = {
    def,
    gameKey,
    checksum: computeGameDefinitionChecksum(def),
    warnings: validation.warnings,
    source,
    actor,
    dryRun,
    allowUpdate,
    expectedCurrentRevisionId,
  };

  // 4. Look up the game with this id in that scope. The same id elsewhere is
  // another game.
  const existingGame = await prisma.game.findUnique({ where: inScope, select: GAME_LOOKUP });
  if (existingGame) {
    return importRevision(ctx, existingGame);
  }
  if (expectedCurrentRevisionId !== undefined) {
    // The caller previewed an existing game that has since been deleted.
    throw gameChanged();
  }

  // 5. Brand new game creation
  if (actor && !(await actor.canCreateGames(def.serverId))) {
    throw new ImportForbiddenError(
      "You do not have permission to create games on this server",
    );
  }

  const limited = limitedUser(def.serverId, actor);
  if (limited && (await casualUsage(prisma, limited)).games >= CASUAL_LIMITS.games) {
    throw casualGameLimit();
  }

  if (dryRun) {
    return {
      status: "created",
      gameId: "dry-run",
      gameKey,
      revision,
      checksum: ctx.checksum,
      errors: [],
      warnings: validation.warnings,
    };
  }

  try {
    return await prisma.$transaction(async (tx) => {
      if (limited) await lockUser(tx, limited);
      const game = await tx.game.create({
        data: {
          gameKey,
          serverId: def.serverId,
          ownerScope,
          name: def.name,
          size: def.size ?? "medium",
          unlisted: unlisted || def.serverId === CASUAL_SERVER_ID,
          preloadChecksum: source === "preload" ? ctx.checksum : null,
          createdById: actor?.userId ?? null,
        },
      });

      const rev = await tx.gameRevision.create({
        data: {
          gameId: game.id,
          revision,
          formatVersion: 1,
          definition: def as unknown as Prisma.InputJsonValue,
          checksum: ctx.checksum,
          source,
          createdBy: actor?.userId ?? null,
        },
      });

      await tx.game.update({
        where: { id: game.id },
        data: { currentRevisionId: rev.id },
      });
      if (limited) await assertCasualLimits(tx, limited, true);
      await audit(tx, {
        serverId: def.serverId,
        actorId: actor?.userId ?? null,
        action: "game.create",
        targetId: game.id,
        targetName: def.name,
        details: { revision, source },
      });

      return {
        status: "created" as const,
        gameId: game.id,
        gameKey,
        revision,
        checksum: ctx.checksum,
        errors: [],
        warnings: validation.warnings,
      };
    });
  } catch (err) {
    // A concurrent import created the game first: import this as its revision.
    const raced = isUniqueViolation(err)
      ? await prisma.game.findUnique({ where: inScope, select: GAME_LOOKUP })
      : null;
    if (!raced) throw err;
    return importRevision(ctx, raced);
  }
}

/**
 * Whether the actor may update the game. A Casual game is its creator's:
 * they update it with games.create there (their role), and only games.edit
 * (global admins) covers anyone's. On a server it takes games.edit.
 */
async function canUpdate(
  actor: ImportActor | undefined,
  game: { serverId: string; createdById: string | null },
): Promise<boolean> {
  if (!actor || (await actor.canEditGames(game.serverId))) return true;
  return (
    game.serverId === CASUAL_SERVER_ID &&
    game.createdById !== null &&
    game.createdById === actor.userId &&
    (await actor.canCreateGames(game.serverId))
  );
}

async function assertCanUpdate(
  ctx: ImportContext,
  game: { serverId: string; createdById: string | null },
): Promise<void> {
  if (await canUpdate(ctx.actor, game)) return;
  // Plain imports only find games in the importer's own scope, so this is a
  // server game: the replace route and settings edits check canUpdate first.
  // Those who can import there see its games on /games anyway.
  throw new ImportForbiddenError(
    `A game with id "${ctx.gameKey}" already exists on this server, and you do not have permission to edit games there. To import this file as a new game, change "id" in the file.`,
    "GAME_ID_TAKEN",
  );
}

async function importRevision(
  ctx: ImportContext,
  game: { id: string; serverId: string; createdById: string | null },
): Promise<GameImportResponse> {
  const { def, gameKey, checksum, warnings, source, actor } = ctx;

  await assertCanUpdate(ctx, game);
  const limited = ctx.dryRun ? null : limitedUser(game.serverId, actor);

  // The game's sessions, told once the new current revision is committed.
  let announce: (() => void) | undefined;
  const imported = await prisma.$transaction(async (tx) => {
    // Before the game: lockUser's order everywhere.
    if (limited) await lockUser(tx, limited);
    // Serialize imports of this game, so the checks and the revision number
    // below see every revision committed before this one. The current
    // revision's name and play area are read for the comparison with the
    // file; its whole definition is multi-MB.
    const [locked] = await tx.$queryRaw<
      {
        currentRevisionId: string | null;
        preloadChecksum: string | null;
        name: string;
        size: string;
        createdById: string | null;
        archivedAt: Date | null;
        bounds: unknown;
        center: unknown;
      }[]
    >`
      SELECT g."currentRevisionId", g."preloadChecksum", g.name, g.size, g."createdById",
        g."archivedAt", r.definition->'map'->'bounds' AS bounds, r.definition->'map'->'center' AS center
      FROM "Game" g
      LEFT JOIN "GameRevision" r ON r.id = g."currentRevisionId"
      WHERE g.id = ${game.id}
      FOR UPDATE OF g
    `;
    if (!locked || locked.archivedAt) {
      throw new ImportConflictError("The game was deleted during the import", "GAME_DELETED");
    }
    // An import committed since the caller previewed the game or read the
    // definition it edited: going ahead would replace or undo that import.
    // Revision ids, unlike numbers, are never current again for another game
    // that reuses the id after a delete.
    if (
      ctx.expectedCurrentRevisionId !== undefined &&
      locked.currentRevisionId !== ctx.expectedCurrentRevisionId
    ) {
      throw gameChanged();
    }
    const cur = locked.currentRevisionId
      ? await tx.gameRevision.findUnique({
          where: { id: locked.currentRevisionId },
          select: { checksum: true, revision: true },
        })
      : null;
    const existing = compareWithExisting(
      { ...locked, revision: cur?.revision ?? 0 },
      { name: def.name, bounds: def.map.bounds, center: def.map.center },
      actor?.userId,
    );

    // The preloaded file only changes the game when its content changed since
    // the last API start: whatever is current now was chosen after that, e.g.
    // an upload, and must not be undone on every start.
    if (source === "preload" && cur && checksum === locked.preloadChecksum) {
      return {
        status: "unchanged" as const,
        gameId: game.id,
        gameKey,
        revision: cur.revision,
        checksum: cur.checksum,
        errors: [],
        warnings,
        existing,
      };
    }
    // Recorded for a preload as the file's content is applied below.
    const preloadChecksum = source === "preload" ? checksum : undefined;

    // A. Check if the map is already identical (same checksum)
    if (cur && checksum === cur.checksum) {
      if (preloadChecksum && !ctx.dryRun) {
        await tx.game.update({ where: { id: game.id }, data: { preloadChecksum } });
      }
      return {
        status: "unchanged" as const,
        gameId: game.id,
        gameKey,
        revision: cur.revision,
        checksum,
        errors: [],
        warnings,
        existing,
      };
    }

    // B. Check collision / update permission
    if (cur && !ctx.allowUpdate && source !== "preload") {
      throw new ImportConflictError(
        `Game "${gameKey}" already exists (revision ${cur.revision}). Import it as an update to replace it.`,
        "GAME_EXISTS",
        true,
        cur.revision,
        existing,
      );
    }

    // C. Content identical to an older revision still stored (see pruneGame)
    // re-activates that revision; new content becomes the next one. Existing
    // revisions are never rewritten: sessions are pinned to them.
    const previous = await tx.gameRevision.findUnique({
      where: { gameId_checksum: { gameId: game.id, checksum } },
      select: { id: true, revision: true },
    });
    let targetRevision: number;
    if (previous) {
      targetRevision = previous.revision;
    } else {
      const { _max } = await tx.gameRevision.aggregate({
        where: { gameId: game.id },
        _max: { revision: true },
      });
      targetRevision = Math.max((_max.revision ?? 0) + 1, def.revision ?? 1);
      if (targetRevision > MAX_REVISION) {
        throw new ImportConflictError(
          `Game "${gameKey}" has used up its revision numbers`,
          "REVISION_LIMIT",
        );
      }
    }

    const result = {
      status: "updated" as const,
      gameId: game.id,
      gameKey,
      revision: targetRevision,
      checksum,
      errors: [],
      warnings,
      existing,
    };
    if (ctx.dryRun) {
      return result;
    }

    const revId =
      previous?.id ??
      (
        await tx.gameRevision.create({
          data: {
            gameId: game.id,
            revision: targetRevision,
            formatVersion: 1,
            definition: def as unknown as Prisma.InputJsonValue,
            checksum,
            source,
            createdBy: actor?.userId ?? null,
          },
        })
      ).id;

    const size = def.size ?? "medium";
    await tx.game.update({
      where: { id: game.id },
      data: {
        name: def.name,
        size,
        currentRevisionId: revId,
        preloadChecksum,
      },
    });
    // Official games keep every revision while they live (see pruneGame).
    if (game.serverId === CASUAL_SERVER_ID) await pruneGame(tx, game.id);
    if (limited) await assertCasualLimits(tx, limited, false);
    await audit(tx, {
      serverId: game.serverId,
      actorId: actor?.userId ?? null,
      action: "game.revision",
      targetId: game.id,
      targetName: def.name,
      details: {
        revision: targetRevision,
        source,
        ...(locked.name !== def.name && { name: { from: locked.name, to: def.name } }),
        ...(locked.size !== size && { size: { from: locked.size, to: size } }),
      },
    });
    const sessions = await tx.gameSession.findMany({
      where: { gameId: game.id },
      select: { id: true },
    });
    announce = () => {
      for (const { id } of sessions) {
        broadcast(id, {
          type: "game.revision-changed",
          payloadJson: { gameRevisionId: revId, revision: targetRevision },
        });
      }
    };

    return result;
  });
  announce?.();
  return imported;
}

function gameChanged(): ImportConflictError {
  return new ImportConflictError(
    "This game was changed since this page loaded. Reload the page to see the latest.",
    "GAME_CHANGED",
  );
}

export interface ReplaceGameDefinitionParams {
  game: { id: string; gameKey: string; serverId: string; createdById: string | null };
  raw: unknown;
  actor: ImportActor;
  dryRun?: boolean;
  // As for an import: refuse (409 GAME_CHANGED) unless this is still the
  // game's current revision.
  expectedCurrentRevisionId?: string;
}

/**
 * Replaces this game's definition with a file, whatever its id and serverId:
 * the game keeps its own, as a settings edit pins def.id. It reaches games an
 * import of the file wouldn't, such as another player's Casual game for a
 * global admin. Always an update, for whoever may update the game.
 */
export async function replaceGameDefinition(
  params: ReplaceGameDefinitionParams,
): Promise<GameImportResponse> {
  const { game, raw, actor, dryRun = false, expectedCurrentRevisionId } = params;
  // Before validating, as for an import: the report is for those who may
  // change the game.
  if (!(await canUpdate(actor, game))) {
    throw new ImportForbiddenError("You do not have permission to update this game");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ImportValidationError(
      [{ path: "/", code: "SCHEMA_VALIDATION_ERROR", message: "Expected object" }],
      [],
    );
  }
  const def = { ...(raw as object), id: game.gameKey, serverId: game.serverId } as GameDefinition;
  const validation = validateGameDefinition(def);
  if (!validation.valid) {
    throw new ImportValidationError(validation.errors, validation.warnings);
  }
  return importRevision(
    {
      def,
      gameKey: game.gameKey,
      checksum: computeGameDefinitionChecksum(def),
      warnings: validation.warnings,
      source: "web",
      actor,
      dryRun,
      allowUpdate: true,
      expectedCurrentRevisionId,
    },
    game,
  ).catch(concurrentImport);
}

export interface UpdateGameSettingsParams {
  game: {
    id: string;
    gameKey: string;
    serverId: string;
    currentRevisionId: string | null;
    createdById: string | null;
  };
  // The revision the edit started from.
  baseRevisionId: string;
  name?: string;
  size?: GameDefinition["size"];
  // Already authorized to edit the game's games.
  actor: ImportActor;
}

/**
 * Changes a game's name and size as a new revision of its current definition,
 * like an upload of the edited JSON: an import overwrites Game.name/size from
 * the definition, exports serve it, and sessions stay on their revision.
 */
export async function updateGameSettings(
  params: UpdateGameSettingsParams,
): Promise<{ status: "updated" | "unchanged"; revision: number; checksum: string }> {
  const { game, baseRevisionId, name, size, actor } = params;
  if (game.currentRevisionId !== baseRevisionId) throw gameChanged();

  // Loaded, validated and hashed outside the lock: definitions are multi-MB.
  const base = await prisma.gameRevision.findFirst({
    where: { id: baseRevisionId, gameId: game.id },
    select: { definition: true },
  });
  if (!base) throw gameChanged();

  const def = base.definition as unknown as GameDefinition;
  if (name !== undefined) def.name = name;
  if (size !== undefined) def.size = size;
  // Without an id the key is derived from the name, so a rename would become
  // another game. The checksum materializes the derived id, so pinning it
  // doesn't change it. `revision` stays as stored: reverting an edit then
  // reproduces the old checksum and re-activates that revision.
  def.id = game.gameKey;

  const validation = validateGameDefinition(def);
  if (!validation.valid) {
    throw new ImportValidationError(validation.errors, validation.warnings);
  }

  const result = await importRevision(
    {
      def,
      gameKey: game.gameKey,
      checksum: computeGameDefinitionChecksum(def),
      warnings: validation.warnings,
      source: "web",
      actor,
      dryRun: false,
      allowUpdate: true,
      expectedCurrentRevisionId: baseRevisionId,
    },
    game,
  );
  return {
    status: result.status as "updated" | "unchanged",
    revision: result.revision,
    checksum: result.checksum,
  };
}
