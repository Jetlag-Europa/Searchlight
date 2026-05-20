# TaibledFork

Personal fork of [taibeled/JetLagHideAndSeek](https://github.com/taibeled/JetLagHideAndSeek) — an Astro + React app for generating elimination maps in Jet Lag: The Game's Hide and Seek mode.

Self-hosted at `https://hideandseek.lucifersserver.com`.

## Workspace layout

```
apps/
  web/       Astro frontend (this is the shipped app)
  api/       Node/Fastify backend — scaffolded in Phase 1
packages/
  shared/    Shared TypeScript types — populated in Phase 1+
```

## Common commands

```bash
pnpm install              # install all workspace deps
pnpm dev                  # run the web dev server
pnpm build                # build all packages
pnpm --filter web build   # build only the frontend
pnpm --filter api build   # build only the backend
pnpm --filter web lint    # lint + format the frontend
pnpm --filter web test    # run frontend tests
```

To target a specific package for any script: `pnpm --filter <name> <script>`.

## References

- `docs/PLAN.md` — roadmap (phases 0–6)
- `docs/ARCHITECTURE.md` — current state of the frontend fork
- `docs/JOURNAL.md` — append-only change log
- `apps/web/HOW TO RUN.txt` — production hosting procedure
