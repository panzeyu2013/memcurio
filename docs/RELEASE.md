# RELEASE

Checklist and mechanics for shipping `@memcurio/dsh-plugin` tarball releases
(modeled on the dsh-mcp-scope release conventions: full local/CI gate before
any release mutation, serialized publication, CHANGELOG-composed notes,
tgz + `.sha256` assets, no re-publishing over an existing release).

## Current release vehicle

- **Tag-driven GitHub Release** shipping the packed
  `memcurio-dsh-plugin-<version>.tgz` (+ `.sha256` sidecar) as the asset.
  Install per instance:
  `dsh plugin --profile <profile> add https://github.com/<owner>/memcurio/releases/download/v<version>/memcurio-dsh-plugin-<version>.tgz`
  (or `add file:./memcurio-dsh-plugin-<version>.tgz` after a local pack).
- **npm publishing is prepared but disabled**: `publishConfig.access: public`
  is set; the release workflow keeps the `npm publish` step commented out
  with a comment block explaining the re-enable path (add the `NPM_TOKEN`
  repository secret, restore `id-token: write` for `--provenance`).

## Local pre-flight (run before tagging)

```sh
bun install --frozen-lockfile
bun run build && bun run typecheck && bun run lint && bun test
bun run pack:check          # rebuild + allowlist + dist reverse check
bun pm pack --dry-run       # tarball content dry-run
bun run pack:tgz            # → .smoke/memcurio-dsh-plugin-<version>.tgz
node scripts/release-notes.mjs <version> --out /tmp/release-notes.md   # section must exist
```

All must be green and `git status --short` empty except the release commit.

## Versioning

- SemVer; the first functional release is **v0.0.1** (developer preview).
- `package.json#version`, the `CHANGELOG.md` section
  (`## [X.Y.Z] - YYYY-MM-DD`), and the git tag `vX.Y.Z` MUST agree — the
  release workflow fails otherwise.
- Every release needs a dated CHANGELOG section; missing/empty sections fail
  the workflow (notes are composed from that section).

## Steps

1. On `main`, bump `package.json#version` and add the CHANGELOG section;
   update any tarball-name examples in `README.md` / `docs/*` that embed the
   version. Commit (`docs(release): prepare vX.Y.Z` style).
2. Run the local pre-flight above.
3. Push `main` (CI runs the full chain), then tag:
   `git tag vX.Y.Z && git push origin vX.Y.Z`.
4. The `Release` workflow (`.github/workflows/release.yml`) runs the full
   gate again, verifies tag/version match, composes notes from the
   CHANGELOG, packs the tarball + sha256, refuses to overwrite an existing
   published release, and creates the GitHub Release with the tgz assets.
5. Sanity-install the release asset into a real DSH profile:
   `dsh plugin --profile <profile> add <asset-url>` then restart the
   instance (profile bundle list changed).

### Manual dispatch / dry run

`workflow_dispatch` with `version` (+ `dry_run: true`) runs the gate and
notes composition only — no Release mutation. Chamber norm: validate any
workflow/script/pin change with one dry run before the formal tag.

## Requirements per environment

- CI/release runners: bun 1.3.14 (pinned, same as local) + node 22 (the
  plugin entry runs under node:sqlite once the host loads it; CI imports
  `dist/plugin/index.js`).
- Local smoke of the tarball into a real DSH instance needs a live
  `dsh` CLI + profile (see `docs/design/s0-spike-plan.md` for the
  real-environment spike scope). The sandbox/CI gates cover everything else
  deterministically.
- npm publishing additionally requires an `NPM_TOKEN` secret and a
  provenance decision (`id-token: write` + `--provenance`).

## Safety norms

- Never re-publish over an existing published release (workflow fails
  closed; stale drafts are deleted first).
- Tag pushes run the same CI chain as `main` — a tag can never carry an
  untested commit.
- `dist/` is committed and drift-checked (`git diff --exit-code -- dist/`);
  `prepare` only verifies artifacts (consumers never build).
- `*.tgz` and `.smoke/` are git-ignored; the release artifact is exactly the
  bytes the local gates produced (sha256 sidecar shipped alongside).
