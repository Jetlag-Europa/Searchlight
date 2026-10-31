function devLoginToken(): string {
  const val = process.env["DEV_LOGIN_TOKEN"] ?? "";
  if (val && val.length < 32) {
    throw new Error("DEV_LOGIN_TOKEN must be at least 32 characters (or unset to disable dev login)");
  }
  return val;
}

// Test login needs no credential, so a production API refuses to start with it.
function enableTestAuth(): boolean {
  const on = process.env["ENABLE_TEST_AUTH"] === "1";
  if (on && process.env["NODE_ENV"] === "production") {
    throw new Error("ENABLE_TEST_AUTH=1 is not allowed with NODE_ENV=production");
  }
  return on;
}

function required(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

export const env = {
  DATABASE_URL: required("DATABASE_URL"),
  DISCORD_CLIENT_ID: required("DISCORD_CLIENT_ID"),
  DISCORD_CLIENT_SECRET: required("DISCORD_CLIENT_SECRET"),
  DISCORD_REDIRECT_URI: required("DISCORD_REDIRECT_URI"),
  SESSION_COOKIE_SECRET: required("SESSION_COOKIE_SECRET"),
  SESSION_COOKIE_DOMAIN: process.env["SESSION_COOKIE_DOMAIN"],
  FRONTEND_ORIGIN: required("FRONTEND_ORIGIN"),
  DISCORD_BOT_TOKEN: required("DISCORD_BOT_TOKEN"),
  NODE_ENV: process.env["NODE_ENV"] ?? "development",
  PORT: parseInt(process.env["PORT"] ?? "3000", 10),
  HOST: process.env["HOST"] ?? "0.0.0.0",
  ADMIN_DISCORD_IDS: process.env["ADMIN_DISCORD_IDS"] ?? "",
  // Test-only: when "1", enables POST /auth/test-login (mints a session cookie
  // for a seeded user, skipping Discord) for Playwright e2e. NEVER set in prod.
  ENABLE_TEST_AUTH: enableTestAuth(),
  TEST_AUTH_USER_ID: process.env["TEST_AUTH_USER_ID"] ?? "e2e-test-user",
  // Preview deployments only: when set, enables /auth/dev-login, which logs in as
  // any Discord user ID given this token. NEVER set in prod.
  // Always off on the tracker stack: the token is shared by every preview, and
  // logging in as someone with locations.view would show the live locations.
  DEV_LOGIN_TOKEN: (devLoginToken(), ""),
  // The Google Maps location sharing reader (searchlight-tracker). Its container
  // joins this stack's network under this name.
  LOCATION_TRACKER_URL: process.env["LOCATION_TRACKER_URL"] || "http://location-tracker:8080",
  // How long the location log keeps positions; 0 turns the log off.
  LOCATION_LOG_DAYS: Number(process.env["LOCATION_LOG_DAYS"] ?? "7"),
};
