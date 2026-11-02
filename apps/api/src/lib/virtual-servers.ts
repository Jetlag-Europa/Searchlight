// Virtual servers have no real Discord guild, so guild-membership checks must be
// skipped for them (a Discord member lookup would 404 -> 403 for everyone).
export { VIRTUAL_SERVER_IDS } from "@searchlight/shared";
