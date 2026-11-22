import type { ValidationIssue } from "./game-definition/index.js";
export * from "./game-definition/index.js";
export * from "./question-history.js";

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
  googleMapType?: string;
  showGoogleTransit?: boolean;
  hideGooglePlaces?: boolean;
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

/**
 * Casual Games (formerly Home Games), a server with no Discord guild of its
 * own. Its games are always unlisted and visible only to their creator and
 * global admins; sessions of them start from game links. Who may create them
 * comes from roles in its management guild (JetLag EU), mapped on /admin.
 */
export const CASUAL_SERVER_ID = "home-games";

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
  /** Discord id of whoever first imported it; null for preloaded and older games. */
  createdById: string | null;
}

export interface GameImportResponse {
  status: "created" | "updated" | "unchanged";
  gameId: string;
  gameKey: string;
  revision: number;
  checksum: string;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  /** Set when the import updates an existing game: the one with the file's id in its scope (the server, or on Casual Games the importer's own games), or the game being replaced. */
  existing?: ExistingGameComparison;
}

/**
 * The game an import would update, compared with the file, so a file that
 * reuses another game's id by mistake can be caught before it replaces it.
 * Also sent for POST /games/:gameId/import, for the game it replaces.
 */
export interface ExistingGameComparison {
  name: string;
  /** Its current revision, before the import. */
  revision: number;
  /** That revision's id: an update sent with it as expectedCurrentRevisionId only replaces this revision. */
  currentRevisionId: string | null;
  /** Whether the importer created it; null when its creator isn't recorded. */
  createdByYou: boolean | null;
  /** The file looks like a different game (name or play area differ). */
  likelyMistake: boolean;
  /** Human-readable reasons, e.g. 'Named "London 2026"; this file: "Paris 2026"'. */
  differences: string[];
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

// ── Usage counts ──────────────────────────────────────────────────────────────

/**
 * What the web app counts at POST /usage, for the admin page: local play and
 * the Map Creator never reach the server otherwise. Only a count per day and
 * event is kept, nothing about who or which game.
 */
export const USAGE_EVENTS = [
  "local-session:file",
  "local-session:url",
  "local-session:game-link",
  // Another session of a game already saved in the browser.
  "local-session:saved",
  "creator:opened",
  "creator:export-json",
  "creator:export-kml",
] as const;

export type UsageEvent = (typeof USAGE_EVENTS)[number];

export interface UsageResponse {
  counts: { event: UsageEvent; last7d: number; last30d: number; total: number }[];
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

// A viewer follows the session live but can't change it, and never sees the
// hider's position.
export type SessionRole = "creator" | "member" | "viewer";

export interface GameSessionSummary {
  id: string;
  gameId: string;
  gameName: string;
  serverId: string;
  name: string;
  visibility: SessionVisibility;
  role: SessionRole;
  createdAt: string;
  hiderLat: number | null;
  hiderLng: number | null;
  planningModeEnabled: boolean;
  // Zones (stations) a player disabled by hand in the zone sidebar.
  disabledZoneIds: string[];
  // The session's event sequence that list is as of: read together, so the
  // app can tell which of two lists (a load's, a save's reply, an event's)
  // is the newer. An API from before sends none.
  disabledZonesSequence?: number;
  gameRevisionId: string;
  sessionRevision?: number | null;
  currentRevision?: number | null;
  hasNewerRevision?: boolean;
}

// Limits on the zone IDs one PATCH /sessions/:id may disable or enable, and
// on the session's disabled list. Game imports don't limit zone IDs (a zone
// without one takes its name), hence the generous length; the biggest games
// so far have under 500 zones, with IDs under 60 characters.
export const MAX_ZONE_ID_LENGTH = 1000;
export const MAX_DISABLED_ZONES = 5000;

export interface SessionsResponse {
  sessions: GameSessionSummary[];
}

// ── Session links ─────────────────────────────────────────────────────────────

// "join" makes the opener a member, "view" a viewer, and "fork" gives them a
// copy of the session as it was when the link was made.
export type SessionLinkType = "join" | "view" | "fork";

export interface SessionLinkSummary {
  id: string;
  token: string;
  linkType: SessionLinkType;
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

// Sent whenever the session's disabled zones change, with the whole list.
export interface ZonesDisabledEvent {
  type: "zones.disabled";
  payloadJson: { disabledZoneIds: string[] };
}

export interface SessionRevisionUpgradedEvent {
  type: "session.revision-upgraded";
  payloadJson: {
    sessionId: string;
    gameRevisionId: string;
    revision: number;
  };
}

// Sent live (not stored) when the creator makes a participant a member or a
// viewer, so that participant's open boards reload with their new role.
export interface ParticipantRoleChangedEvent {
  type: "participant.role-changed";
  payloadJson: { userId: string; role: Exclude<SessionRole, "creator"> };
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
