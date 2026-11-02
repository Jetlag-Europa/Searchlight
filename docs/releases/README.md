# Releases

`CHANGELOG.md` records every notable change as it lands on `main`. A release
picks out the highlights since the last release, and is published on
[GitHub Releases](https://github.com/Jetlag-Europa/Searchlight/releases).

Each file here is the body of one release, named after its version. Keep it to
the highlights, for the two groups who read it: game makers, who import games,
and players. Leave out individual games, internal fixes and server admin steps,
which stay in the changelog's **Upgrading** lines, and link the list of commits
since the last release (`compare/v2.0.0...v2.1.0`) for everything else. Use full URLs for
links, since the body is also shown on GitHub, where relative links don't
resolve.

The app shows a major or minor release's notes once to every player who used
an earlier release, and again from the map's menu. It understands paragraphs,
`##` headings, bullet lists, bold, code and links, and shows anything else as
plain text.

A release describes how it differs from the last one. Leave out fixes for
problems that came up after the last release and were fixed before this one:
players of the last release never saw them. Before listing a fix, check that
the problem was there at the last release's tag.

## Versions

- **Major** (3.0): a change to how Searchlight works as a whole, like 2.0's importable
  games.
- **Minor** (2.1): a batch of new features. Players get a "what changed" notice.
- **Patch** (2.1.1): fixes only.

| Release | Commit | Covers |
| --- | --- | --- |
| 1.0.0 | `4394c1b6d` (2026-09-26) | JetLagHideAndSeek's fork up to Jules's last change |
| 2.0.0 | the commit that adds this file | Importable games, and everything since 1.0 |

## Publishing a release

1. Write `docs/releases/<version>.md` and set `"version"` to it in the root
   `package.json`, `apps/api/package.json`, `apps/web/package.json` and
   `packages/shared/package.json`. Merge that to `main`.
2. Wait for the merge commit's "Docker images" run to finish, then publish the
   release on that commit:

   ```bash
   gh release create v2.1.0 --target main --title "Searchlight 2.1" \
       --notes-file docs/releases/2.1.0.md
   ```

The "Release images" workflow then tags the commit's images with the version,
such as `2.1.0` and `2.1`, so servers can stay on a release (see `DEPLOY.md`).
