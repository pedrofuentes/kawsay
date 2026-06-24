# Learnings — Kawsay

> **This file is written by AI agents.** When you discover something about this project
> that isn't documented elsewhere, add it here. Do NOT write to AGENTS.md.
>
> Periodically, a human or agent should review this file and promote stable learnings
> into the appropriate companion doc (ARCHITECTURE.md, TESTING-STRATEGY.md, etc.).

## Format

```markdown
### [YYYY-MM-DD] Short description
**Context**: What were you doing when you discovered this?
**Learning**: What did you learn?
**Impact**: How should this affect future work?
```

## Learnings

<!-- Add new learnings below this line, most recent first -->

### [2026-06-23] electron-vite 5 needs Vite 6 types; electron 42 self-downloads its binary
**Context**: Scaffolding the app shell (card F1) — getting `pnpm typecheck` and `pnpm build` green on
the Vite 5.4 toolchain pinned for the renderer, then smoke-launching the built app.
**Learning**:
- `electron-vite@5`'s config typings import `BuildEnvironmentOptions`, a Vite **6+** type absent from
  Vite 5.4, so `tsc` rejects `build.lib` / `build.rollupOptions` in `electron.vite.config.ts` even
  though the config runs fine. `electron-vite@4.0.1` is the newest major with Vite-5-compatible types
  (see ADR-0010). Symptom to recognise: `Cannot find name 'BuildEnvironmentOptions'` only under `tsc`.
- A sandboxed Electron preload **cannot `require` from `node_modules`**, so the preload must be emitted
  as CommonJS (`index.cjs`) with `zod` **bundled in** (exclude it from `externalizeDepsPlugin`). Main
  and renderer remain ESM.
- `electron@42` ships **no `postinstall`**; `require('electron')` lazily runs `install.js` to download
  the binary on first `pnpm dev`/launch. So `pnpm install` + `pnpm build` succeed with no binary and
  pnpm's build-script approval is irrelevant for electron. If an env interrupts that first download, the
  cached zip under `~/Library/Caches/electron/<hash>/` can be extracted straight into
  `node_modules/.../electron/dist/` (no network) to recover.
**Impact**: Keep `electron-vite` at `^4` until the project adopts Vite 6+. Don't try to "fix" the
preload by externalizing zod. Don't add electron to `pnpm.onlyBuiltDependencies` expecting a postinstall.
