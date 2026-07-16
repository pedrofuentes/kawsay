### ADR-0024: Bump better-sqlite3 12.9.0 → 12.11.1 for Electron 42 native compatibility
**Date**: 2026-06-24
**Status**: Accepted (enables ADR-0007 / card P1, AC-5)
**Tier**: auto-with-audit (the one dependency change in P1). This ADR is the audit note.

**Context**
Card P1 rebuilds `better-sqlite3` from source for Electron 42's ABI at package time. The pinned `12.9.0`
fails to compile against Electron 42's V8 (13.x): `v8::External::New` now takes a required `tag` argument
and `Object::SetNativeDataProperty` is an ambiguous overload. The Node-ABI binary used by Vitest is a
downloaded *prebuilt*, so the source never compiled locally and the break only surfaces at package time —
`pnpm dist` (and the same rebuild on CI) cannot produce a loadable native module. better-sqlite3 shipped the
fixes after 12.9.0: 12.10.1 "Fix V8 external API usage for Electron 42" and 12.11.1 "Fix Electron v42 build
errors on Windows".

**Decision**
Bump the exact-pinned `better-sqlite3` to `12.11.1` (same major). 12.11.1 (not 12.10.1) is required because
AC-5 also ships a Windows `.exe`, and the Windows Electron-42 build fix only landed in 12.11.1. The exact
pin (no caret) is preserved — native-module ABI builds must stay deterministic.

**Alternatives considered**
- *Keep 12.9.0 and use prebuilt Electron binaries instead of a source build* — rejected: 12.9.0 predates
  Electron 42 so publishes no Electron-42 prebuilt, and ADR-0007 deliberately builds native deps from source
  (`buildDependenciesFromSource: true`) for reproducibility.
- *Bump only to 12.10.1* — rejected: fixes macOS/general V8 but not the Windows Electron-42 build, and AC-5
  needs both installers.
- *Stay on 12.9.0 / downgrade Electron* — rejected: leaves AC-5 unsatisfiable.

**Consequences**
- ✅ `better-sqlite3` compiles for Electron 42 on macOS (arm64 + x64, both verified) and is configured for
  the Windows runner; the packaged app loads it at startup (verified by launch).
- ✅ Same major version; the full test suite (which loads the real module on the Node ABI) stays green.
- ⚠️ A regression-floor test (`tests/unit/packaging-config.test.ts`) pins `better-sqlite3 ≥ 12.11.1`, because
  the Node-ABI prebuilt hides Electron-ABI compile breaks from the ordinary test run — a downgrade would
  otherwise only fail at package time.
- ⚠️ 12.11.1 (like all ≥ 12.10.1) ships **no Node-20 prebuilt** (only `node-v127`/`v137`/`v141`/`v147` =
  Node 22/24/25/…). The `ci.yml` Verify job now pins **Node 22**, so Windows CI picks up the `node-v127` prebuilt rather than compiling native code from source on the runner;
  see LEARNINGS 2026-06-24.
- Called out for review per the card's "only electron-builder" constraint: this is a required compatibility
  bump of an existing runtime dependency, not a new package.
