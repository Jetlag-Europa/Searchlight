# Changelog

## Phase 0 — pnpm workspace restructure (2026-05-21)

Converts the repo from a flat Astro project to a pnpm workspace layout
in preparation for the Node backend added in Phase 1.

### Changes

- **`apps/web/`** — Astro frontend relocated here from the repo root via
  `git mv`; full git history preserved on all files. Package renamed to
  `@taibled/web`. `tsconfig.json` now extends root `tsconfig.base.json`
  in addition to `astro/tsconfigs/strict`.
- **`apps/api/`** — placeholder `@taibled/api` package. Contains a stub
  `src/index.ts` and a NodeNext TypeScript config. Fastify, Prisma, and
  auth wired in Phase 1.
- **`packages/shared/`** — placeholder `@taibled/shared` package with an
  empty `src/index.ts` and a declaration-emitting TypeScript config.
  Populated in Phase 1+.
- **Root `package.json`** — `private: true`, `packageManager: pnpm@11.1.3`,
  `pnpm dev` / `pnpm build` convenience scripts.
- **`pnpm-workspace.yaml`** — declares `apps/*` and `packages/*`; includes
  `allowBuilds` for `esbuild`, `sharp`, and
  `@vaadin/vaadin-usage-statistics` so `pnpm install` is non-interactive.
- **`tsconfig.base.json`** — shared strict TypeScript settings extended by
  all packages.
- **`README.md`** — replaced with workspace orientation doc.
- **`.gitignore`** — extended to cover `apps/*/dist` and `packages/*/dist`.

### Acceptance criteria verified

1. `pnpm install` at root — clean (1173 packages, no substantive peer-dep errors).
2. `pnpm --filter web build` — `1 page(s) built`, no errors.
3. `pnpm --filter api build` — emits `apps/api/dist/index.js`.
4. `pnpm --filter shared build` — emits `packages/shared/dist/index.js` + `.d.ts`.
5. `git log --follow` on moved files shows full pre-restructure history.
6. Browser verification (criterion 2 from spec) — pending manual test by operator.
