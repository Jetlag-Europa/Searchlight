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
  NODE_ENV: process.env["NODE_ENV"] ?? "development",
  PORT: parseInt(process.env["PORT"] ?? "3000", 10),
};
