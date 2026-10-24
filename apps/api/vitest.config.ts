import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // tsc compiles the tests into dist/ too. Vitest 4 no longer skips dist by
    // default, and running both copies at once breaks the database tests.
    exclude: [...configDefaults.exclude, "**/dist/**", "**/dist-seed/**"],
    // The dev database from docker-compose.dev.yml unless DATABASE_URL is set.
    env: {
      DATABASE_URL:
        process.env.DATABASE_URL ||
        "postgresql://taibled:devpassword@localhost:5433/taibled",
      SESSION_COOKIE_SECRET:
        "c9d29e40c390d4d575f1382884f55165cd43f127dc1c7708325643afd0a3c4c6",
      FRONTEND_ORIGIN: "http://localhost",
      // Remaining required vars — not exercised by the events route, but env.ts
      // throws on startup if any are missing.
      DISCORD_CLIENT_ID: "test",
      DISCORD_CLIENT_SECRET: "test",
      DISCORD_REDIRECT_URI: "http://localhost/auth/callback",
      DISCORD_BOT_TOKEN: "test",
    },
  },
});
