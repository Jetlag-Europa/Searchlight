import type { ValidationIssue } from "./game-definition/index.js";
export * from "./games.js";
export * from "./game-definition/index.js";

// ── Auth / User ──────────────────────────────────────────────────────────────

export interface User {
  discordId: string;
  username: string;
  displayName: string;
  avatarUrl: string;
}

export interface UserPreferences {
  defaultUnit?: string;
  customInitPreference?: string;
  baseTileLayer?: string;
  thunderforestApiKey?: string;
  animateMapMovements?: boolean;
  autoSave?: boolean;
  warningAlarm?: boolean;
  autoZoom?: boolean;
  defaultCustomQuestions?: boolean;
  allowGooglePlusCodes?: boolean;
  penToolbarVisible?: boolean;
  showZoneNames?: boolean;
  autoLockQuestions?: boolean;
}

export interface MeResponse {
  user: User;
  preferences: UserPreferences;
}

// ── Servers / Roles ───────────────────────────────────────────────────────────

export interface Server {
  id: string;
  name: string;
  iconUrl: string | null;
}

export interface DiscordRole {
  id: string;
  name: string;
  color: number;
  position: number;
}

export interface RolePermissionEntry {
  discordRoleId: string;
  permission: string;
}

export interface ServerWithPermissions extends Server {
  permissions: string[];
  /**
   * False for a server listed only because the user has sessions there
   * (joined from a game link or an invite link) without being in its Discord
   * guild: its game catalog is closed to them, so they can't start sessions.
   */
  isMember: boolean;
}

export interface ServersResponse {
  servers: ServerWithPermissions[];
}

export interface ServerRolesResponse {
  roles: DiscordRole[];
  mappings: RolePermissionEntry[];
}

// ── Games ─────────────────────────────────────────────────────────────────────

export interface Game {
  id: string;
  gameKey: string;
  serverId: string;
  name: string;
  size: "small" | "medium" | "large";
  /** Sessions start only from game links; only the games page lists it, for game managers. */
  unlisted: boolean;
  currentRevisionId?: string | null;
  archivedAt?: string | null;
}

export interface GameImportResponse {
  status: "created" | "updated" | "unchanged";
  gameId: string;
  gameKey: string;
  revision: number;
  checksum: string;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

export interface GamesResponse {
  games: Game[];
}

/**
 * PATCH /games/:gameId/settings: the settings the games page edits. A change
 * is saved as a new revision of the game's definition.
 */
export interface GameSettingsUpdate {
  /** The revision the edit started from; a game changed since is refused (409). */
  baseRevisionId: string;
  name?: string;
  size?: Game["size"];
}

export interface GameSettingsResponse {
  status: "updated" | "unchanged";
  revision: number;
  game: Game;
}

/**
 * Usage of one game, summed over its sessions. Server admins see it on the
 * games page; nothing in it identifies a session or a player.
 */
export interface GameStats {
  gameId: string;
  /** Sessions with at least one player connected right now. */
  liveSessions: number;
  /** Distinct players connected to those sessions right now. */
  livePlayers: number;
  /** Sessions created or changed in the last 24 hours / 7 days. */
  activeSessions24h: number;
  activeSessions7d: number;
  totalSessions: number;
  /** Distinct players who ever joined a session of the game. */
  players: number;
  /** Questions across all sessions. */
  questions: number;
  /** When a session of the game was last created or changed. */
  lastActivityAt: string | null;
}

export interface GameStatsResponse {
  stats: GameStats[];
}

// ── Game links ────────────────────────────────────────────────────────────────

export interface GameLinkSummary {
  id: string;
  token: string;
  createdAt: string;
  createdByDisplayName: string;
}

export interface GameLinksResponse {
  links: GameLinkSummary[];
}

// ── Sessions ──────────────────────────────────────────────────────────────────

export type SessionVisibility = "private" | "shared";

export interface GameSessionSummary {
  id: string;
  gameId: string;
  gameName: string;
  serverId: string;
  name: string;
  visibility: SessionVisibility;
  role: "creator" | "member";
  createdAt: string;
  hiderLat: number | null;
  hiderLng: number | null;
  planningModeEnabled: boolean;
  gameRevisionId: string;
  sessionRevision?: number | null;
  currentRevision?: number | null;
  hasNewerRevision?: boolean;
}

export interface SessionsResponse {
  sessions: GameSessionSummary[];
}

// ── Session links ─────────────────────────────────────────────────────────────

export interface SessionLinkSummary {
  id: string;
  token: string;
  linkType: "join" | "fork";
  createdAt: string;
}

export interface SessionLinksResponse {
  links: SessionLinkSummary[];
}

export interface CreateLinkResponse {
  id: string;
  token: string;
}

// ── Presence ─────────────────────────────────────────────────────────────────

export interface PresenceUser {
  userId: string;
  displayName: string;
  avatarUrl: string;
}

export type PresenceEvent =
  | { type: "presence.snapshot"; payloadJson: { users: PresenceUser[] } }
  | { type: "presence.join"; payloadJson: PresenceUser }
  | { type: "presence.leave"; payloadJson: { userId: string } };

export interface HiderUpdateEvent {
  type: "hider.update";
  payloadJson: { hiderLat: number | null; hiderLng: number | null };
}

export interface PlanningToggleEvent {
  type: "planning.toggle";
  payloadJson: { planningModeEnabled: boolean };
}

export interface SessionRevisionUpgradedEvent {
  type: "session.revision-upgraded";
  payloadJson: {
    sessionId: string;
    gameRevisionId: string;
    revision: number;
  };
}

export interface EventRecord {
  id: string;
  sessionId: string;
  userId: string;
  sequence: number;
  type: string;
  payloadJson: unknown;
  clientUuid: string;
  clientCreatedAt: string;
  serverReceivedAt: string;
}
