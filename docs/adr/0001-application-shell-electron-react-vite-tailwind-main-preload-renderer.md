### ADR-0001: Application shell — Electron + React + Vite + Tailwind (main / preload / renderer)
**Date**: 2026-06-23
**Status**: Accepted
**Tier**: auto (the pre-authorized §3 stack; reversible architecture).

**Context**
MISSION §3 fixes the stack: a cross-platform (macOS + Windows) **local desktop app** in **TypeScript
(strict)** with **Electron + React + Vite + Tailwind**, no backend. MISSION §3 also records the
deliberate evaluation of **Tauri v2** and the choice of Electron. We need a concrete process/build
structure to implement against.

**Decision**
Three Electron processes: **main** (Node, full privilege — fs/DB/subprocess/security), **preload**
(the sole `contextBridge` bridge), **renderer** (sandboxed React 18 + Vite + Tailwind v4, pure UI).
Build with **`electron-vite`** (one config for the main/preload/renderer triple; renderer HMR);
**ESM** throughout; **pnpm**. Tests: **Vitest** (unit/integration) + **Playwright** (e2e + the AC-4
Chromium harness + visual verification). Renderer is organized by **feature**; `electron/main` by
**responsibility**; shared DTOs/channel constants in `shared/`.

**Alternatives considered**
- *Tauri v2 (Rust + system WebView)* — leaner/tighter, but **rejected in MISSION §3** for autonomous-
  fleet velocity, the day-one JS ingestion ecosystem (`exifr`, `yauzl`, mail/chat parsers), and proven
  large-local-data performance. Revisit only if footprint/security outweigh those.
- *Three separate Vite configs vs `electron-vite`* — chose `electron-vite` (cleaner main/preload/
  renderer handling + HMR), per the cataloging research.
- *CommonJS* — rejected; ESM is the modern default and matches AGENTS (ESM).

**Consequences**
- ✅ A familiar, well-supported shell with a fast renderer dev loop and a huge ingestion ecosystem.
- ✅ Clear process boundaries that make the sandbox + zero-egress model enforceable (ADR-0005).
- ⚠️ Electron's larger binary footprint vs Tauri (accepted trade-off, MISSION §3).
- ⚠️ Native module (`better-sqlite3`) requires per-arch rebuilds in packaging (handled in ADR-0007).

