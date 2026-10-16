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
  pastebinApiKey?: string;
  animateMapMovements?: boolean;
  alwaysUsePastebin?: boolean;
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
  currentRevisionId?: string | null;
  archivedAt?: string | null;
}

export interface GameRevisionSummary {
  id: string;
  gameId: string;
  revision: number;
  formatVersion: number;
  checksum: string;
  source: string;
  createdBy: string | null;
  createdAt: string;
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

export interface GameRevisionsResponse {
  revisions: GameRevisionSummary[];
}
export interface GamesResponse {
  games: Game[];
}

export interface CreateGameBody {
  serverId: string;
  name: string;
  gameKey?: string;
  size?: "small" | "medium" | "large";
}

export interface UpdateGameBody {
  name?: string;
  size?: "small" | "medium" | "large";
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
  gameRevisionId?: string | null;
  sessionRevision?: number | null;
  currentRevision?: number | null;
  hasNewerRevision?: boolean;
}
export interface SessionParticipantDetail {
  userId: string;
  displayName: string;
  avatarUrl: string;
  role: "creator" | "member";
  acceptedAt: string | null;
}

export interface GameSessionDetail extends GameSessionSummary {
  participants: SessionParticipantDetail[];
}

export interface SessionsResponse {
  sessions: GameSessionSummary[];
}

export interface CreateSessionBody {
  gameId: string;
  name: string;
  /** Defaults to private; inviting someone makes the session shared. */
  visibility?: SessionVisibility;
}

export interface UpdateSessionBody {
  name?: string;
  visibility?: SessionVisibility;
  hiderLat?: number | null;
  hiderLng?: number | null;
}

// ── Invites ───────────────────────────────────────────────────────────────────

export interface InviteSummary {
  id: string;
  sessionId: string;
  sessionName: string;
  gameName: string;
  invitedByDisplayName: string;
  inviteType: "join" | "fork";
  createdAt: string;
}

export interface PendingInvitesResponse {
  invites: InviteSummary[];
}

export interface SendInviteBody {
  invitedUserId: string;
  inviteType?: "join" | "fork";
}

export interface ForkAcceptResponse {
  sessionId: string;
}

export interface SessionInviteDetail {
  id: string;
  invitedUserId: string;
  invitedUserDisplayName: string;
  invitedByUserId: string;
  inviteType: "join" | "fork";
  createdAt: string;
}

export interface SessionInvitesResponse {
  invites: SessionInviteDetail[];
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

export interface LinkInfoResponse {
  valid: boolean;
  sessionName?: string;
  gameName?: string;
  linkType?: "join" | "fork";
}

export interface RedeemLinkResponse {
  sessionId: string;
  linkType: "join" | "fork";
}

// ── User search ───────────────────────────────────────────────────────────────

export interface UserSearchResult {
  discordId: string;
  displayName: string;
  username: string;
  avatarUrl: string;
}

export interface UserSearchResponse {
  users: UserSearchResult[];
}

// ── Session content ───────────────────────────────────────────────────────────

export interface StrokeRecord {
  id: string;
  clientUuid: string;
  userId: string;
  payloadJson: unknown; // GeoJSON Feature
  createdAt: string;
}

export interface StrokesResponse {
  strokes: StrokeRecord[];
}

export interface SaveStrokeBody {
  clientUuid: string;
  payloadJson: unknown;
}

export interface QuestionRecord {
  clientUuid: string;
  ordinal: number;
  payloadJson: unknown;
}

export interface QuestionsResponse {
  questions: QuestionRecord[];
}

export interface ReplaceQuestionsBody {
  questions: QuestionRecord[];
  replacementId: string;
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

export interface EventsResponse {
  events: EventRecord[];
  nextAfter: number | null;
}

export interface EventCursorResponse {
  sequence: number;
}
