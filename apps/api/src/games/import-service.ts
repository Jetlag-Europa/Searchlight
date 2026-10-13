import { type GameListing, Prisma } from "@prisma/client";
import {
  computeGameDefinitionChecksum,
  type GameDefinition,
  type GameImportResponse,
  resolveGameDefinitionId,
  validateGameDefinition,
  type ValidationIssue,
} from "@searchlight/shared";
import prisma from "../lib/prisma.js";

// GameRevision.revision is a PostgreSQL integer.
const MAX_REVISION = 2_147_483_647;

export interface ImportActor {
  userId?: string | null;
  type: "cookie" | "token";
  canCreateGames(serverId: string): boolean | Promise<boolean>;
  canEditGames(serverId: string): boolean | Promise<boolean>;
  // games.create-unlisted: create unlisted games, which the actor then owns.
  canCreateUnlistedGames(serverId: string): boolean | Promise<boolean>;
}

export interface ImportGameDefinitionParams {
  raw: unknown;
  source?: "api" | "web" | "preload";
  actor?: ImportActor;
  dryRun?: boolean;
  expectedServerId?: string;
  allowUpdate?: boolean;
  // Listing of a newly created game (default listed). Updates never change it.
  listing?: GameListing;
}

export class ImportConflictError extends Error {
  code: string;
  statusCode: number;
  canUpdate?: boolean;
  existingRevision?: number;

  constructor(
    message: string,
    code: string,
    canUpdate = false,
    existingRevision?: number,
  ) {
    super(message);
    this.name = "ImportConflictError";
    this.code = code;
    this.statusCode = 409;
    this.canUpdate = canUpdate;
    this.existingRevision = existingRevision;
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

  constructor(message: string) {
    super(message);
    this.name = "ImportForbiddenError";
    this.code = "FORBIDDEN";
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
}

// The fields of an existing game that an import checks.
const GAME_SELECT = { id: true, serverId: true, listing: true, ownerId: true } as const;

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
    listing: requestedListing,
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
    if (
      !(await actor.canCreateGames(serverId)) &&
      !(await actor.canEditGames(serverId)) &&
      !(await actor.canCreateUnlistedGames(serverId))
    ) {
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
  };

  // 4. Look up existing game by gameKey
  const existingGame = await prisma.game.findUnique({
    where: { gameKey },
    select: GAME_SELECT,
  });
  if (existingGame) {
    return importRevision(ctx, existingGame);
  }

  // 5. Brand new game creation. Uploaders with only games.create-unlisted
  // create unlisted games, which they then own and manage.
  let listing: GameListing = requestedListing ?? "listed";
  if (actor && !(await actor.canCreateGames(def.serverId))) {
    if (!(await actor.canCreateUnlistedGames(def.serverId))) {
      throw new ImportForbiddenError(
        "You do not have permission to create games on this server",
      );
    }
    if (requestedListing === "listed") {
      throw new ImportForbiddenError(
        "You can only create private games on this server",
      );
    }
    listing = "unlisted";
  }
  const ownerId = actor?.type === "cookie" ? (actor.userId ?? null) : null;

  if (dryRun) {
    return {
      status: "created",
      gameId: "dry-run",
      gameKey,
      revision,
      checksum: ctx.checksum,
      listing,
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
          listing,
          ownerId,
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
        listing,
        errors: [],
        warnings: validation.warnings,
      };
    });
  } catch (err) {
    // A concurrent import created the game first: import this as its revision.
    const raced = isUniqueViolation(err)
      ? await prisma.game.findUnique({
          where: { gameKey },
          select: GAME_SELECT,
        })
      : null;
    if (!raced) throw err;
    return importRevision(ctx, raced);
  }
}

async function importRevision(
  ctx: ImportContext,
  game: Prisma.GameGetPayload<{ select: typeof GAME_SELECT }>,
): Promise<GameImportResponse> {
  const { def, gameKey, checksum, warnings, source, actor } = ctx;

  // Prohibit cross-server updates. The id is taken; which server owns it is
  // none of the caller's business.
  if (def.serverId !== game.serverId) {
    throw new ImportForbiddenError(
      `Game id "${gameKey}" is already used by a game on another server`,
    );
  }
  // Editors update any game; owners update theirs while they may still
  // import games on its server.
  if (
    actor &&
    !(await actor.canEditGames(game.serverId)) &&
    !(
      actor.type === "cookie" &&
      game.ownerId != null &&
      game.ownerId === actor.userId &&
      ((await actor.canCreateGames(game.serverId)) ||
        (await actor.canCreateUnlistedGames(game.serverId)))
    )
  ) {
    throw new ImportForbiddenError(
      "You do not have permission to edit games on this server",
    );
  }

  return prisma.$transaction(async (tx) => {
    // Serialize imports of this game, so the checks and the revision number
    // below see every revision committed before this one.
    const [locked] = await tx.$queryRaw<{ currentRevisionId: string | null }[]>`
      SELECT "currentRevisionId" FROM "Game" WHERE id = ${game.id} FOR UPDATE
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

    // A. Check if the map is already identical (same checksum)
    if (cur && checksum === cur.checksum) {
      return {
        status: "unchanged" as const,
        gameId: game.id,
        gameKey,
        revision: cur.revision,
        checksum,
        listing: game.listing,
        errors: [],
        warnings,
      };
    }

    // B. Check collision / update permission
    if (cur && !ctx.allowUpdate && source !== "preload") {
      throw new ImportConflictError(
        `Map "${def.name}" (${gameKey}) already exists (Revision ${cur.revision}). Check "Update existing map" to update it.`,
        "GAME_EXISTS",
        true,
        cur.revision,
      );
    }

    // C. Content identical to an older revision re-activates that revision;
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
      listing: game.listing,
      errors: [],
      warnings,
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
      },
    });

    return result;
  });
}
