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

### [2026-06-23] better-sqlite3 in an Electron+Vitest repo: dual ABI, local typings, `?raw` DDL
**Context**: Building the local library core (card F3) — wiring `better-sqlite3` so it works both under
Electron (runtime) and under Vitest (Node) without adding dependencies beyond the two the card allows.
**Learning**:
- **Dual ABI, no `postinstall` rebuild.** `pnpm install` builds `better-sqlite3` against the **Node**
  ABI, which is exactly what Vitest (Node) needs — so the unit suite runs the real engine with no mocks.
  Rebuilding for Electron's ABI must therefore be an **explicit, separate** step (`@electron/rebuild`
  via a `rebuild:native` script, also wired into the `dist*` scripts), **never** a `postinstall` — a
  postinstall rebuild would flip the binary to the Electron ABI and break `pnpm test`. `pnpm build`
  (`electron-vite build`) externalizes `better-sqlite3`, so it never loads native code.
- **Local typings instead of `@types/better-sqlite3`.** To keep the dependency surface to exactly the
  two packages the card permits, hand-write a minimal `declare module 'better-sqlite3'` (generic
  `Statement.get<T>()`/`all<T>()`, `SqlScalar`) — enough for the catalog, eslint-strict-clean (no
  `any`), and zero extra deps. Extend it as the API surface grows.
- **DDL lives in real `.sql` files, imported with Vite `?raw`.** Keeps the schema auditable yet shipped
  inlined (no runtime `fs` read). `tsc` needs a `declare module '*.sql?raw'`; Vitest resolves `?raw`
  natively. Verified it survives `electron-vite build` by transiently importing the migration module
  into the main entry — the DDL string is inlined into `out/main/index.js` (bundle 7→31 kB).
- **Named-param binding (v12):** missing keys throw, `boolean` throws (convert to 0/1), `undefined`
  should be coerced to `null`. `INSERT … ON CONFLICT(content_hash) DO UPDATE … RETURNING id` with
  `.get()` returns the **existing** row id on conflict (the dedup primitive), and a NULL `content_hash`
  never conflicts, so message rows always insert — one statement handles both dedup and 1:1 messages.
**Impact**: Don't add `better-sqlite3` to a `postinstall` rebuild, don't add `@types/better-sqlite3`,
and keep migration DDL in `.sql` + `?raw`. The clean-tree gate (`git archive HEAD` → `pnpm install
--frozen-lockfile --offline` → test) confirms the offline native restore from the warm pnpm store.

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
