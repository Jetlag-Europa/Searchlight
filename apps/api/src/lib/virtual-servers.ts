import { CASUAL_SERVER_ID } from "@searchlight/shared";

// Virtual servers have no real Discord guild, so guild-membership checks must be
// skipped for them (a Discord member lookup would 404 -> 403 for everyone).
export const VIRTUAL_SERVER_IDS = new Set<string>([CASUAL_SERVER_ID]);

// What anyone in one of the registered servers holds on a virtual server: the
// rest stays with global admins. (Role mappings and Server.managementGuildId no
// longer grant anything there; they stay so the previous release can be rolled
// back to.)
export const VIRTUAL_SERVER_PERMISSIONS = ["games.create"];
