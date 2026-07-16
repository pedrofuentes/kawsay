### ADR-0017: Clear the dev-dependency CVEs via `pnpm.overrides` (patched `tar`/`esbuild`) + a Vite 5→6 bump
**Date**: 2026-06-24
**Status**: Accepted
**Tier**: auto-with-audit. Every package touched is a **devDependency or a build-time transitive** — none
ships in the production Electron bundle, opens a network/external origin, or alters the local-only runtime
(ADR-0008, AC-4); this is the audit note for the security fix (issue #31 — auto-tier, no milestone gate).

**Context**
Dependabot flagged 14 open alerts (**8 high + 6 medium**), **all `development`-scope**, that M1 DoD §4
requires cleared before sign-off (issue #31). None reaches the shipped bundle (it loads built static files +
the native better-sqlite3 binary; there is no dev server), so `pnpm audit --prod` was already clean — but the
alerts must still go:
- **vite** (2 high + 4 medium) — dev-server `server.fs.deny` bypass, optimized-deps `.map` path traversal,
  `launch-editor` NTLMv2 disclosure. Vulnerable range `<= 6.4.2`, **first patched `6.4.3` — no Vite-5
  backport exists**.
- **esbuild** (1 medium) — dev server accepts cross-site requests. Needs `>= 0.25.0`; pulled transitively by
  Vite (5.4 → 0.21.5).
- **tar** (6 high + 1 medium) — transitive of `@electron/rebuild@3.7.2` (the Node-20 pin) via
  `@electron/node-gyp`, used by `pnpm rebuild:native` to extract trusted, lockfile-pinned, integrity-verified
  Electron headers. Needs `>= 7.5.16`; `@electron/rebuild@3.7.2` declares `tar@^6`.

**Decision**
- Bump the direct **`vite`** devDependency `^5.4.21 → ^6.4.3` — the minimal patched version (`^6.4.3`
  resolves deterministically to `6.4.3`, the last 6.x). This is the Vite-major move ADR-0010 deferred to "its
  own ADR"; it does **not** disturb the pinned `electron-vite@^4` toolchain, whose peer range is
  `vite ^5 || ^6 || ^7` and which (with `@vitejs/plugin-react@^4`, `@tailwindcss/vite@^4`, `vitest@3`) already
  declares Vite-6 support. Vite 6 pulls `esbuild ^0.25.0`, which alone clears the esbuild advisory.
- Add **`pnpm.overrides`** forcing the two purely-transitive offenders to patched releases: `tar: ^7.5.16`
  and `esbuild: ^0.25.0`. tar 7.5.16 already coexists in-tree under electron-builder's
  `@electron/rebuild@4 → node-gyp@12`, and the electron node-gyp fork calls only the API stable across tar
  6→7 (`tar.extract({ file, strip, filter, onwarn, cwd })`), so the override is safe for the native rebuild;
  the esbuild pin is belt-and-suspenders so no path can reintroduce a pre-0.25 esbuild.

**Alternatives considered**
- **Bump `@electron/rebuild` 3.7.2 → 4.x for a natively-patched tar** (issue #31's stated fallback) —
  rejected as the primary fix: `@electron/rebuild@4` requires Node `>= 22.12`, forcing a raise of the
  `engines.node >= 20` baseline (ADR-0010's deliberate Node-20 pin). Held in reserve **only if** the tar
  override ever breaks the native rebuild.
- **Stay on Vite 5, override only esbuild/tar** — impossible: the vite advisories have no Vite-5 fix, so
  Vite 6 is mandatory to clear the 2 high + 4 medium vite alerts.
- **Jump to the latest Vite 7/8** — rejected: a larger, riskier major bump than the CVEs require; 6.4.3 is
  the minimal clearing version and sits inside every tool's peer range.
- **Accept-risk / suppress the alerts** — rejected: all are cleanly patchable without breaking the build;
  DoD §4 wants them gone, not waived.

**Consequences**
- All 14 alerts clear: `pnpm audit` goes **11 → 0** and `pnpm audit --prod` stays clean (dev-scope only).
  `pnpm typecheck` / `lint` / `test` (506 passing) / `build` (now `vite v6.4.3`) are green; the native
  `better-sqlite3` rebuild still extracts the Electron headers via tar 7.5.16 unchanged.
- The project is now on the Vite 6 line (the move ADR-0010 anticipated); a later `electron-vite@5` bump
  (which needs Vite 6+) is unblocked should it ever be wanted.
- Two `pnpm.overrides` are now load-bearing for security: if a future dependency legitimately needs an older
  `tar`/`esbuild`, the override must be revisited (revert is a one-line change). No runtime `dependencies`
  semantics changed and no feature dependency was removed.
