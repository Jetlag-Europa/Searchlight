// TEMPORARY: hardcoded per-game visibility gate.
//
// This exists only until the real invite-link system lands (people with
// permissions create Home Games and invite others via links). To remove it:
// delete this file and its two call sites in routes/games.ts, plus the
// `userPassesGameGate` helper in lib/permissions.ts.

// Virtual servers have no real Discord guild, so guild-membership checks must be
// skipped for them (a Discord member lookup would 404 → 403 for everyone). The
// server itself is still listed for all users; its games are gated below.
export const VIRTUAL_SERVER_IDS = new Set<string>(["home-games"]);

export interface GameVisibilityGate {
  sentinelValue: string; // game this gate applies to
  requireGuildId: string; // real Discord guild to check the user's roles in
  requireRoleId: string; // role the user must hold in that guild to see the game
}

// A game listed here is visible only to users holding `requireRoleId` in
// `requireGuildId`. Games not listed here are visible to anyone who can see
// their server (existing behaviour).
export const GAME_VISIBILITY_GATES: GameVisibilityGate[] = [
  {
    sentinelValue: "__bundled-exter-rotterdam-2026__",
    requireGuildId: "1190673594649415730", // JetLag EU
    requireRoleId: "1514353477231312966",
  },
];

export function gateForSentinel(sentinelValue: string): GameVisibilityGate | undefined {
  return GAME_VISIBILITY_GATES.find((g) => g.sentinelValue === sentinelValue);
}
