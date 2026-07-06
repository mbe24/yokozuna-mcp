# Development

```sh
npm run dev               # tsx watch (needs SUMO_* in the shell env)
npm test                  # unit tests (no network)
npm run test:integration  # opt-in; needs SUMO_ACCESS_ID/KEY in env; creates+deletes 1 tiny job
npm run lint
npm run typecheck
```

Full local quality gate (the same steps CI runs):

```sh
npm run typecheck && npm run lint && npm run build && npm test
```

Layout: `src/config.ts` (env → typed config) · `src/http/` (rate-limited fetch client,
errors, cookies) · `src/sumo/` (Search Job API, job lifecycle/keepalive, time ranges) ·
`src/format/` (log flattening + token-economical rendering) · `src/tools/` (MCP tool
definitions) · `src/server.ts`/`src/index.ts` (wiring + stdio entry).

## CI & releases

- **CI** (`.github/workflows/ci.yml`) runs on every pull request and push to `main`:
  `npm ci` → typecheck → lint → build → unit tests (Node 20, ubuntu).
- **Release** (`.github/workflows/release.yml`) runs on a `v*` tag push. It first
  verifies the tag matches `package.json` `version`, then **waits for the CI run on
  the tagged commit** (polling for it to appear and conclude, up to ~25 minutes) and
  publishes with `npm publish --provenance` only if CI concluded green. A failed or
  never-appearing CI run fails the release — nothing publishes.

Release flow:

1. Bump `package.json` `version` and update `CHANGELOG.md`.
2. Commit to `main`, tag the commit `v<version>`, and push both
   (`git push --follow-tags`) — the release workflow waits out CI and publishes
   only on green.

## Documentation

The docs are mkdocs Material, built by ReadTheDocs from `mkdocs.yml` +
`docs/` (`.readthedocs.yaml` pins the build). Build locally with:

```sh
pip install -r docs/requirements.txt
mkdocs build --strict     # or: mkdocs serve
```

`strict: true` means broken internal links fail the build — same as ReadTheDocs.

## Publishing details

The package is publish-ready: `files` allowlist (`dist`, `README.md`, `LICENSE` only —
no sources, tests, or env files in the tarball), a `bin` entry with a shebang that
survives the build, and a `prepublishOnly` hook that rebuilds `dist` on publish. Verify
the tarball contents with `npm pack --dry-run`. Publishing normally happens via the
release workflow (above); a manual `npm publish` also works. Once published,
`npx -y yokozuna-mcp` works as-is.

Brand assets live in `assets/` (logo) and `.github/` (social preview); the SVGs are the
source of truth and `npm run assets` re-rasterizes the PNGs (dev-only
`@resvg/resvg-js`, excluded from the published tarball).
