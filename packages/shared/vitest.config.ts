import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // tsc compiles the tests into dist/ too, and Vitest 4 no longer skips dist
    // by default.
    exclude: [...configDefaults.exclude, "**/dist/**"],
  },
});
