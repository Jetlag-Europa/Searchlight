// Virtual servers have no real Discord guild, so guild-membership checks must be
// skipped for them (a Discord member lookup would 404 -> 403 for everyone).
export const VIRTUAL_SERVER_IDS = new Set<string>(["home-games"]);
