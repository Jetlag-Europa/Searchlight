export interface User {
  discordId: string;
  username: string;
  displayName: string;
  avatarUrl: string;
}

export interface MeResponse {
  user: User;
}
