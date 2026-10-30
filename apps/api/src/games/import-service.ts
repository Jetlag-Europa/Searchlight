import { Prisma } from "@prisma/client";
import {
  CASUAL_SERVER_ID,
  computeGameDefinitionChecksum,
  type ExistingGameComparison,
  type GameDefinition,
  type GameImportResponse,
  resolveGameDefinitionId,
  validateGameDefinition,
  type ValidationIssue,
} from "@searchlight/shared";
import prisma from "../lib/prisma.js";
import { compareWithExisting } from "./compare-games.js";

// GameRevision.revision is a PostgreSQL integer.
const MAX_REVISION = 2_147_483_647;

export interface ImportActor {
  userId?: string | null;
  type: "cookie" | "token";
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
  // The existing game's revision the caller previewed: an update refuses if
  // the game has moved on since, rather than replace what they didn't see.
  expectedRevision?: number;
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

// The file's id belongs to a game the caller may not change. Which server it
// is on, or whose it is, is none of the caller's business.
function gameIdTaken(gameKey: string, reason = `The id "${gameKey}" is already used by another game.`) {
  return new ImportForbiddenError(
    `${reason} To import this file as a new game, change "id" in the file.`,
    "GAME_ID_TAKEN",
  );
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
  expectedRevision?: number;
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

/**
 * Validates, authorizes, and transactionally imports or updates a GameDefinition document.
 */
export async function importGameDefinition(
  params: ImportGameDefinitionParams,
): Promise<GameImportResponse> {
  try {
    return await importDefinition(params);
  } catch (err) {
    // Imports of a game are serialized, and losing the race to create one is
    // retried as an update, so this is a safety net: report a conflict rather
    // than leak the database error.
    if (isUniqueViolation(err)) {
      throw new ImportConflictError(
        "The game was changed by a concurrent import. Try again.",
        "CONCURRENT_IMPORT",
      );
    }
    throw err;
  }
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
    expectedRevision,
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

  const ctx: ImportContext = {
    def,
    gameKey,
    checksum: computeGameDefinitionChecksum(def),
    warnings: validation.warnings,
    source,
    actor,
    dryRun,
    allowUpdate,
    expectedRevision,
  };

  // 4. Look up existing game by gameKey
  const existingGame = await prisma.game.findUnique({
    where: { gameKey },
    select: { id: true, serverId: true, createdById: true },
  });
  if (existingGame) {
    return importRevision(ctx, existingGame);
  }

  // 5. Brand new game creation
  if (actor && !(await actor.canCreateGames(def.serverId))) {
    throw new ImportForbiddenError(
      "You do not have permission to create games on this server",
    );
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
      const game = await tx.game.create({
        data: {
          gameKey,
          serverId: def.serverId,
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
      ? await prisma.game.findUnique({
          where: { gameKey },
          select: { id: true, serverId: true, createdById: true },
        })
      : null;
    if (!raced) throw err;
    return importRevision(ctx, raced);
  }
}

/**
 * Throws unless the actor may update the game. Games can't move between
 * servers. A Casual game is its creator's: they update it with games.create
 * there (their role), and only games.edit (global admins) covers anyone's.
 */
async function assertCanUpdate(
  ctx: ImportContext,
  game: { serverId: string; createdById: string | null },
): Promise<void> {
  const { def, gameKey, actor } = ctx;
  if (def.serverId !== game.serverId) throw gameIdTaken(gameKey);
  if (!actor || (await actor.canEditGames(game.serverId))) return;

  if (game.serverId === CASUAL_SERVER_ID) {
    const ownGame = game.createdById !== null && game.createdById === actor.userId;
    if (ownGame && (await actor.canCreateGames(game.serverId))) return;
    throw gameIdTaken(gameKey);
  }
  throw gameIdTaken(
    gameKey,
    `A game with id "${gameKey}" already exists, and you do not have permission to edit games on this server.`,
  );
}

async function importRevision(
  ctx: ImportContext,
  game: { id: string; serverId: string; createdById: string | null },
): Promise<GameImportResponse> {
  const { def, gameKey, checksum, warnings, source, actor } = ctx;

  await assertCanUpdate(ctx, game);

  return prisma.$transaction(async (tx) => {
    // Serialize imports of this game, so the checks and the revision number
    // below see every revision committed before this one. The current
    // revision's name and play area are read for the comparison with the
    // file; its whole definition is multi-MB.
    const [locked] = await tx.$queryRaw<
      {
        currentRevisionId: string | null;
        preloadChecksum: string | null;
        name: string;
        createdById: string | null;
        bounds: unknown;
        center: unknown;
      }[]
    >`
      SELECT g."currentRevisionId", g."preloadChecksum", g.name, g."createdById",
        r.definition->'map'->'bounds' AS bounds, r.definition->'map'->'center' AS center
      FROM "Game" g
      LEFT JOIN "GameRevision" r ON r.id = g."currentRevisionId"
      WHERE g.id = ${game.id}
      FOR UPDATE OF g
    `;
    if (!locked) {
      throw new ImportConflictError("The game was deleted during the import", "GAME_DELETED");
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

    // B. Check the game is still the one the caller previewed
    const currentRevision = cur?.revision ?? 0;
    if (ctx.expectedRevision !== undefined && currentRevision !== ctx.expectedRevision) {
      throw new ImportConflictError(
        `"${locked.name}" changed since you previewed it (now revision ${currentRevision}). Check the import again.`,
        "REVISION_CHANGED",
        false,
        currentRevision,
        existing,
      );
    }

    // C. Check collision / update permission
    if (cur && !ctx.allowUpdate && source !== "preload") {
      throw new ImportConflictError(
        `Game "${gameKey}" already exists (revision ${cur.revision}). Import with allowUpdate to replace it.`,
        "GAME_EXISTS",
        true,
        cur.revision,
        existing,
      );
    }

    // D. Content identical to an older revision re-activates that revision;
    // new content becomes the next one. Existing revisions are never rewritten:
    // sessions are pinned to them.
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

    await tx.game.update({
      where: { id: game.id },
      data: {
        name: def.name,
        size: def.size ?? "medium",
        currentRevisionId: revId,
        archivedAt: null,
        preloadChecksum,
      },
    });

    return result;
  });
}
