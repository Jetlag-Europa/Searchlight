// ── Auth / User ──────────────────────────────────────────────────────────────

export interface User {
  discordId: string;
  username: string;
  displayName: string;
  avatarUrl: string;
}

export interface MeResponse {
  user: User;
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
  serverId: string;
  name: string;
  sentinelValue: string;
  kmlPath: string;
  mapLocationJson: unknown; // OpenStreetMap Feature JSON
  hidingRadius: number;
  hidingRadiusUnits: "miles" | "kilometers";
  tierRadiusOverrides?: Record<string, number> | null;
  size: "small" | "medium" | "large";
}

export interface GamesResponse {
  games: Game[];
}

export interface CreateGameBody {
  serverId: string;
  name: string;
  sentinelValue: string;
  kmlPath: string;
  mapLocationJson: unknown;
  hidingRadius: number;
  hidingRadiusUnits: "miles" | "kilometers";
  size?: "small" | "medium" | "large";
}

export interface UpdateGameBody {
  name?: string;
  hidingRadius?: number;
  hidingRadiusUnits?: "miles" | "kilometers";
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
  visibility: SessionVisibility;
}

export interface UpdateSessionBody {
  name?: string;
  visibility?: SessionVisibility;
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
  createdAt: string;
}

export interface SessionInvitesResponse {
  invites: SessionInviteDetail[];
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
  replacementId?: string;
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

// ── Events ────────────────────────────────────────────────────────────────────

export interface EventRecord {
  id: string;
  sessionId: string;
  userId: string;
  type: string;
  payloadJson: unknown;
  clientUuid: string;
  clientCreatedAt: string;
  serverReceivedAt: string;
}

export interface EventsResponse {
  events: EventRecord[];
}
