### ADR-0007: Packaging & distribution via electron-builder → GitHub Releases
**Date**: 2026-06-23
**Status**: Accepted
**Tier**: auto for CI build/packaging; **the first production publish of each release is human-required**
(MISSION §9; PRD AC-5).

**Context**
v1 must build into installable **macOS** and **Windows** artifacts published to **GitHub Releases** and
launch (AC-5). `better-sqlite3` is a native module (Electron ABI) and `ffmpeg`/`ffprobe` are bundled
binaries — both complicate packaging. No backend, no app store (MISSION §2).

**Decision**
Use **`electron-builder`**. Targets: macOS **`.dmg` + `.zip`** (`arm64`+`x64`), Windows **NSIS `.exe`**
(**`x64` only in v1**). Publish to **GitHub Releases** (`provider: github`, `--publish
always`, `GH_TOKEN`). Rebuild native modules for Electron's ABI (`npmRebuild: true`,
`buildDependenciesFromSource: true`) and **`asarUnpack`** `better-sqlite3` + `ffmpeg-static` +
`ffprobe-static` (a `.node`/binary can't load from inside asar). **CI matrix on per-arch native
runners** (`macos-14` arm64, `macos-13` x64, `windows-latest` x64) — native modules can't be
cross-compiled; pin **Node 22** + **Python 3.11** (node-gyp needs `distutils`). Flip `@electron/fuses` +
ASAR integrity at package time. **Ship unsigned in v1** (`mac.identity: null`; NSIS unsigned) — one-time
Gatekeeper/SmartScreen prompt; signing/notarization deferred (MISSION §2). The **first production
publish of each release runs in a protected GitHub Environment with required reviewers** (@pedrofuentes).

**`win-arm64` is dropped from v1.** AC-5 requires every published artifact to be **smoke-launched**, and
there is **no hosted arm64 Windows CI runner** to do so; a cross-compiled-but-unsmoke-tested binary
cannot satisfy AC-5. Windows-on-ARM runs x64 builds under emulation, so x64-only still serves those
users. `win-arm64` is a post-v1 target, gated on a native arm64 Windows runner.

**Alternatives considered**
- *Electron Forge* — equally viable; `electron-builder` chosen for its first-class multi-target
  GitHub-Releases publish and the directly-applicable `octomux` reference (`better-sqlite3` + multi-arch).
- *Universal macOS binary* — deferred; per-arch `.dmg`s are simpler to build on native runners.
- *Ship `win-arm64` cross-compiled but unsmoke-tested* — **rejected**: it would publish an artifact no
  CI job can launch, contradicting AC-5's "builds **and launches**". x64-only (emulated on WoA) chosen
  for v1; native arm64 revisited when a hosted runner exists.
- *`fluent-ffmpeg`* — rejected (deprecated/read-only 2024); call bundled binaries via `spawn` directly.

**Consequences**
- ✅ Reproducible installers for both OSes, published automatically on tag; satisfies AC-5.
- ✅ Native module + ffmpeg binaries load correctly in the packaged app.
- ✅ Every published artifact is on a **native runner that smoke-launches it** — no unverifiable arch.
- ⚠️ Unsigned v1 means a one-time "unidentified developer" prompt — acceptable for a known-family v1.
- ⚠️ Windows-on-ARM users run the x64 build under emulation in v1; a native `win-arm64` build is a
  post-v1 milestone gated on a hosted arm64 Windows runner.
- 🔒 The human-required publish gate (protected Environment) is enforced outside CI logic, so an
  automated build can never publish a release unattended.
