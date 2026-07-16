### ADR-0023: Packaging finalization (card P1) — fuse-flip mechanism, non-publishing auto-builds, ABI ordering
**Date**: 2026-06-24
**Status**: Accepted (refines ADR-0007)
**Tier**: auto-with-audit. No new *package* is added (electron-builder + @electron/rebuild already present);
the one dependency change is a patch-level bump of the existing `better-sqlite3` for Electron-42 native
compatibility (ADR-0024). Every choice here is reversible config + dev assets, and the local-only runtime
(ADR-0008, AC-4) is untouched. This ADR is the audit note.

**Context**
ADR-0007 chose `electron-builder` → GitHub Releases and named the *what* (dmg+zip / nsis, asarUnpack the
native modules, flip `@electron/fuses` + ASAR integrity, unsigned v1, human-required publish). Card P1
turns that skeleton into a `pnpm dist` that actually builds and launches, which forced several concrete
*how* decisions ADR-0007 left open.

**Decision**
1. **Flip fuses via electron-builder's native `electronFuses` config**, not a custom `afterPack` hook.
   electron-builder 26 flips `@electron/fuses` (its own bundled copy, via `dynamicImport`) "right before
   signing" and re-applies the macOS ad-hoc signature when `resetAdHocDarwinSignature: true`. The
   `electronFuses` block mirrors `electron/fuses/fuses.ts` `FUSE_CONFIG` and is kept in lock-step by
   `tests/unit/packaging-config.test.ts`. **`resetAdHocDarwinSignature: true` is mandatory**: flipping a
   fuse rewrites the binary and invalidates its signature, and Apple Silicon refuses to launch a binary
   with a broken signature — without the re-sign the *unsigned* v1 build would not start on arm64. Net:
   **zero new packages** (no direct `@electron/fuses`, no hook module). One fuse is the exception —
   `enableEmbeddedAsarIntegrityValidation` is deferred on the unsigned v1 build (ADR-0025).
2. **The automated/local build never publishes.** `dist`/`dist:mac`/`dist:win` pass `--publish never`, so
   a developer or CI build can never upload a GitHub Release. The `publish: github` block exists *only* for
   the human-gated release workflow (protected GitHub Environment, @pedrofuentes approval). This makes the
   "first production publish is HUMAN-REQUIRED" gate (ADR-0007, PRD AC-5) structural, not procedural. No
   `electron-updater`/`autoUpdater` is bundled, so the publish provider introduces no runtime network feed
   and the zero-egress guarantee (AC-4) is untouched.
3. **`pnpm dist` rebuilds the native module via electron-builder's own `npmRebuild`, not a pre-step.** The
   skeleton chained `pnpm rebuild:native` (the standalone `@electron/rebuild` 3.7.2 CLI) before the build;
   that is dropped from `dist`/`dist:mac`/`dist:win` because electron-builder already rebuilds
   `better-sqlite3` from source for Electron's ABI during packaging, and the standalone CLI additionally
   mis-resolves the module out of a nested git worktree (see LEARNINGS). The `rebuild:native` script is kept
   for switching a dev checkout to the Electron ABI by hand. Ordering still matters: tests run on Node's
   ABI, `pnpm dist` leaves `better-sqlite3` on Electron's ABI, so `pnpm dist` runs *after* the test gate and
   `pnpm rebuild better-sqlite3` restores the Node ABI for subsequent `pnpm test` runs (see LEARNINGS).
4. **Placeholder MIT icons** (`resources/icon.icns/.ico/.png`) are generated dependency-free and
   auto-discovered via `buildResources`; replacing them with final brand art is a later visual task.

**Alternatives considered**
- *Custom `afterPack` hook + direct `@electron/fuses` devDependency* — rejected: more code, a new dep, and
  it would have to re-implement the ad-hoc re-sign that electron-builder already does correctly.
- *Keep `publish: github` active for `pnpm dist` (rely on the absence of a tag to avoid publishing)* —
  rejected: `--publish never` is explicit and cannot be defeated by CI env heuristics.
- *Ship `enableEmbeddedAsarIntegrityValidation` active in v1* — rejected: macOS asar-integrity validation
  requires code signing, so on the unsigned v1 build the renderer fails to load from the asar
  (ERR_FILE_NOT_FOUND). It is deferred to the signing step (ADR-0025).

**Consequences**
- ✅ `pnpm dist` builds the macOS dmg/zip (arm64 + x64) locally with the native catalog engine loading under
  Electron's ABI and the hardening fuses active — verified by launching the packaged app (the renderer and
  the eagerly-loaded `better-sqlite3` 12.11.1 both come up clean).
- ✅ The only dependency change is the `better-sqlite3` patch bump (ADR-0024); no new package is added.
- ✅ An automated build cannot publish a release; publishing remains a deliberate human act.
- ⚠️ Running `pnpm test` immediately after `pnpm dist` fails until `pnpm rebuild better-sqlite3` restores
  the Node ABI — documented in LEARNINGS and handled by ordering in the release workflow.
- ⚠️ Windows `.exe` cannot be cross-built on macOS (native module + NSIS); it is produced on the Windows CI
  runner. The config is verified correct; the artifact itself is built/smoke-launched on `windows-latest`.
