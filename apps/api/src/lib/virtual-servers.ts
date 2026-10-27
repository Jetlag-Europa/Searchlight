import { CASUAL_SERVER_ID } from "@searchlight/shared";

// Virtual servers have no real Discord guild, so guild-membership checks must be
// skipped for them (a Discord member lookup would 404 -> 403 for everyone).
export const VIRTUAL_SERVER_IDS = new Set<string>([CASUAL_SERVER_ID]);

// The only permission a role can be granted on a virtual server (through its
// management guild's roles): the rest stay with global admins.
export const VIRTUAL_SERVER_PERMISSIONS = ["games.create"];
