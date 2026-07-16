### ADR-0026: Release pipeline — GitHub Actions workflow publishing unsigned v1 installers to GitHub Releases
**Date**: 2026-06-25
**Status**: Accepted (implements ADR-0007; complements ADR-0023/0024/0025)
**Tier**: human-required for each production publish — the workflow's publish job runs in a protected GitHub
Environment with required reviewers (@pedrofuentes), so a release blocks until approved (MISSION §9; PRD
AC-5). Authoring the workflow is reversible config (`auto-with-audit`); this ADR is the audit note. The
pipeline performs **no code-signing** and adds **no runtime network egress** — no auto-updater/feed is
bundled (ADR-0023), so AC-4 is untouched.

**Context**
ADR-0007 chose `electron-builder` → GitHub Releases and named the publish contract (`provider: github`,
`--publish always`, `GH_TOKEN`, protected Environment). Card P1 (ADR-0023) made `pnpm dist` build and launch
the installers locally while keeping the automated build **non-publishing** (`--publish never`). What
remained was the CI surface that turns a pushed release tag into published GitHub Release assets — the
`.github/workflows/release.yml` already referenced by ARCHITECTURE §1/§8 but not yet written. The cofounder
approved publishing **v0.1.0 UNSIGNED** (gate #120; ADR-0025).

**Decision**
Add `.github/workflows/release.yml`:
1. **Triggers**: push of a `v*` tag (e.g. `v0.1.0`) plus manual `workflow_dispatch` (electron-builder derives
   the release tag from `package.json` `version` when dispatched without a git tag).
2. **Matrix**: `macos-latest` + `windows-latest` — matching `ci.yml` and the P1-verified single-runner
   cross-build (one Apple Silicon `macos-latest` produces both the arm64 build and the x64 from-source
   cross-build; ADR-0023). Each runner reuses CI's exact pinned toolchain (Node 22 + the pinned pnpm/Node
   setup, `pnpm install --frozen-lockfile`, `pnpm build`), then `electron-builder --publish always`.
3. **Native module**: electron-builder's own `npmRebuild`/`buildDependenciesFromSource` rebuilds
   `better-sqlite3` for Electron's ABI at package time (ADR-0023); `actions/setup-python` pins **Python 3.11**
   because node-gyp needs distutils (removed in 3.12; ADR-0007/ARCHITECTURE §8).
4. **Publish**: electron-builder's native GitHub provider (the `publish:` block already in
   `electron-builder.yml`) creates the Release for the tag and uploads the `.dmg`/`.zip`/`.exe` assets,
   authenticated with the repo-scoped `GITHUB_TOKEN` (`GH_TOKEN`). `--publish always` lives **only** in the
   workflow — `package.json`'s `dist*` scripts stay `--publish never`, preserving ADR-0023's structural
   "a local/automated build can never publish a release" guarantee (and the `dist` `--publish never`
   assertion in `tests/unit/packaging-config.test.ts`).
5. **Unsigned (ADR-0025)**: `CSC_IDENTITY_AUTO_DISCOVERY: false` so electron-builder produces unsigned
   artifacts instead of failing while trying to discover a macOS signing identity. No certs/secrets are
   added; code-signing + notarization (and re-enabling the asar-integrity fuse) remain the deferred human
   step.
6. **Least privilege + human gate**: top-level `permissions: contents: read`; the publish job widens to
   `contents: write` only (create the release + upload assets) and runs in the protected `release`
   Environment, so the first production publish blocks on the required reviewer. `concurrency` with
   `cancel-in-progress: false` never interrupts an in-flight release.
7. **Supply chain**: every `uses:` is pinned to a full 40-char commit SHA with a `# vX.Y.Z` comment, reusing
   `ci.yml`'s SHAs for the shared actions (checkout, pnpm/action-setup, setup-node).

**Alternatives considered**
- *Build per-OS, then a separate job publishes via `softprops/action-gh-release`* — viable and marginally
  more least-privilege (build legs need no write token), but adds three more third-party actions to pin
  (upload-/download-artifact + the release action) and diverges from ADR-0007's `--publish always` contract
  and the already-wired `electron-builder.yml` `publish` block. electron-builder's native multi-OS publish is
  simpler and is the documented decision.
- *Per-arch macOS runners (`macos-14` arm64 + `macos-13` x64) as ADR-0007 first sketched* — unnecessary: P1
  verified one `macos-latest` runner builds both arches (x64 native compiled from source), and a single
  runner matches `ci.yml`.
- *Add a `release`/`publish` npm script carrying `--publish always`* — rejected: it would place a publishing
  command in `package.json` that a developer could run locally, weakening ADR-0023's structural guarantee and
  tripping the packaging-config test that asserts `dist` is `--publish never`. The `always` flag is confined
  to the gated workflow.
- *Sign/notarize in v1* — rejected per ADR-0025 / gate #120 (approved to ship unsigned); signing is the
  deferred human step.

**Consequences**
- ✅ Pushing `v0.1.0` (after the coordinator tags) builds and publishes the macOS + Windows installers to a
  GitHub Release, satisfying AC-5's build-and-publish, with the first publish held for human approval.
- ✅ Unsigned artifacts build cleanly (no signing attempt); zero new runtime dependencies, certs, or secrets.
- ✅ Minimal token scope; publishing cannot happen from a local/automated `pnpm dist`.
- ⚠️ Both matrix legs publish to the same tagged Release; electron-builder dedupes by tag (find-or-create),
  and `concurrency` + the one-time human approval keep this controlled. If a future release needs strict
  single-writer publishing, switch to the build-artifacts-then-one-publish-job shape above.
- ⚠️ The Windows runner compiles `better-sqlite3` from source for the Electron ABI; if a runner-image
  toolchain regression (cf. node-gyp vs. Visual Studio, LEARNINGS 2026-06-24) breaks that compile, pin the
  build tools/prebuilt path in this workflow — a release-time check, not a blocker for the unsigned v1.
