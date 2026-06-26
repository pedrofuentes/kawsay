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

### [2026-06-25] Electron `net.request` is the only guard-respecting downloader, and its `IncomingMessage` is event-based (not a Node `Readable`)
**Context**: Card #131 (ADR-0027 Decision 6) — building the opt-in, checksum-verified model download manager
that must not bypass the AC-4 zero-egress guard.
**Learning**:
- `network-guard.ts` installs **only** `session.webRequest.onBeforeRequest`, which governs the
  **Chromium/Electron-session network stack only**. Node `http`/`https`/`net` traffic **bypasses it
  entirely**. So any privileged egress (the model download) **must** use **Electron `net.request`/`net.fetch`
  on the guarded `session`** to actually pass through the chokepoint — a Node-primitive downloader would
  silently defeat the guarantee. The AC-4 allow/deny proof therefore lives in the `webRequest` allowlist test
  (`tests/ac4/network-guard.test.ts`), not in the Node-prototype egress spies (which never observe the
  Chromium-stack download).
- Electron's `net` `IncomingMessage` **extends `EventEmitter`, not a Node `Readable`**: it emits
  `data`(Buffer)/`end`/`error`/`aborted` and has **no** `pause`/`resume`/`Symbol.asyncIterator`. To consume
  it as a stream you must **bridge the events to an `AsyncIterable`** yourself (a chunk queue + a wake
  promise), attaching the listeners **eagerly when the response arrives** so an early `data` event isn't
  dropped before iteration starts.
- Follow GitHub's `302` natively with `redirect: 'follow'` and `credentials: 'omit'`; the signed
  `release-assets.githubusercontent.com` URL is time-limited, so on a long resume **re-request the pinned
  origin URL** (which mints a fresh redirect) rather than reusing the expired signed link.
**Impact**: Card #134 (the `whisper-cli` worker) and any future feature that needs the network must route
through `net` on the guarded session and call `verifyModelOnDisk()` before use; do not reach for Node
`https`/`http`.

### [2026-06-24] Packaging Kawsay with electron-builder: native ABI, the asar-integrity/signing trap, nested-worktree rebuilds
**Context**: Card P1 (AC-5) — turning the electron-builder skeleton into a `pnpm dist` that actually builds
the macOS dmg/zip + Windows nsis and *launches*. Most of the work was diagnosing why the first real
`pnpm dist` produced an app that wouldn't run.
**Learning**:
- **`better-sqlite3` 12.9.0 cannot compile against Electron 42's V8 (13.x).** The break is in the V8 C++
  API, not the headers: `v8::External::New` now requires a third `tag` argument (external-pointer sandbox)
  and `Object::SetNativeDataProperty` became an ambiguous overload. Symptoms in the rebuild log:
  *"too few arguments to function … v8::External::New"* and *"call of overloaded SetNativeDataProperty(...)
  is ambiguous"*. The fix landed **after** 12.9.0: **12.10.1** ("Fix V8 external API usage for Electron 42")
  and **12.11.1** ("Fix Electron v42 build errors on Windows"). For a two-platform target you need
  **≥ 12.11.1**.
- **A Node-ABI prebuilt masks the break.** `pnpm install` downloads a *prebuilt* Node-ABI `.node`, so
  `better-sqlite3` never compiles from source locally and `pnpm test` is green — the incompatibility only
  surfaces when electron-builder rebuilds **from source** for the Electron ABI at package time. Lesson: a
  green test suite does **not** prove the native module will build for Electron; pin a version floor
  (`tests/unit/packaging-config.test.ts`) so a downgrade fails in CI instead of silently at package time.
- **`enableEmbeddedAsarIntegrityValidation` requires macOS code signing.** On an **unsigned** build
  (`mac.identity: null`) this fuse makes Chromium refuse to load the renderer from the asar — the app starts
  (main process is fine, `better-sqlite3` loads) but the window is blank with
  `Failed to load URL … app.asar/out/renderer/index.html (ERR_FILE_NOT_FOUND)`, even though the integrity
  hash *is* in `Info.plist` and the file *is* in the asar. Proof by isolation: a `--dir` rebuild with
  `-c.electronFuses.enableEmbeddedAsarIntegrityValidation=false` launches clean; it is the **sole** fuse
  that breaks unsigned (the other six — incl. `onlyLoadAppFromAsar`, `grantFileProtocolExtraPrivileges:false`,
  `enableCookieEncryption` — are fine). Keep it `true` in `FUSE_CONFIG` (the signed-production target) but
  `false` in `electron-builder.yml` for v1, and re-enable it *with* signing.
- **electron-builder's own `npmRebuild` is the robust native-rebuild path — not the standalone
  `rebuild:native` script.** electron-builder 26 bundles `@electron/rebuild` 4.x, runs it app-scoped
  (`workspaceRoot` = the package dir, `buildFromSource=true`) and rebuilds `better-sqlite3` for the Electron
  ABI during packaging. So `pnpm rebuild:native &&` was **removed** from the `dist*` scripts (redundant — and
  electron-builder even warns the dep is excess). The standalone `@electron/rebuild` 3.7.2 CLI is kept only
  for switching a dev checkout's ABI by hand.
- **Nested git worktrees break `@electron/rebuild` 3.7.2.** Because `.worktrees/p1-package` lives *inside*
  the main repo, `searchForModule` walks **up** the filesystem and rebuilds the **main repo's** stale
  `better-sqlite3@12.9.0` (which fails), ignoring the worktree's 12.11.1 — even with `-m "$PWD"`. This is why
  `pnpm rebuild:native` fails locally but the same rebuild works in a standalone CI clone. Another reason to
  rely on electron-builder's app-scoped rebuild instead.
- **The dual-ABI dance is real and unavoidable with `pnpm dist`.** electron-builder rebuilds the
  pnpm-store `better-sqlite3` **in place** to the Electron ABI (NODE_MODULE_VERSION 146), which then breaks
  `pnpm test` (needs Node ABI 141) until you run **`pnpm rebuild better-sqlite3`**. Always:
  lint/typecheck/test (Node ABI) → `pnpm dist` (Electron ABI) → `pnpm rebuild better-sqlite3` to restore. CI
  is unaffected (fresh `pnpm install` + test, never `pnpm dist` on the same checkout).
- **Verified artifacts (host = macOS):** `Kawsay-0.1.0-arm64.dmg` ≈ 198 MB + `Kawsay-0.1.0-arm64-mac.zip`
  ≈ 199 MB (Apple Silicon), and the x64 cross-build `Kawsay-0.1.0.dmg` ≈ 205 MB (its `better_sqlite3.node`
  is `Mach-O x86_64`). The Windows `.exe` cannot be cross-built on macOS (native module + NSIS) → produced on
  the `windows-latest` runner; the config is verified correct.
- **The 12.11.x bump has a CI cost: it dropped the Node-20 prebuilt.** `better-sqlite3` 12.9.0 shipped a
  `node-v115` (Node 20, the `engines` floor) prebuilt for every platform; **≥ 12.10.1 ships only `node-v127`
  / `v137` / `v141` / `v147` (Node 22/24/25/…)**. The `ci.yml` Verify job pins **Node 20**, so after the bump
  it finds no prebuilt and tries to compile: macOS/Linux compile from source and pass, but **Windows fails** —
  the runner's bundled node-gyp 10.2.0 mis-detects the image's "Visual Studio 18" (VS 2026) and its PowerShell
  finder crashes (`ERR_CHILD_PROCESS_STDIO_MAXBUFFER`). The clean fix is a one-line `.github` change —
  `node-version: 20` → `22` in `ci.yml` (Node 22's `node-v127` prebuilt exists for 12.11.1, and
  `ac4-egress.yml` already uses Node 22) — which is coordinator-owned, so P1 escalates it rather than touching
  the harness. Takeaway: when bumping a native dep, check its **prebuilt ABI matrix against the CI Node
  version**, not just the local one.
**Impact**: Keep `better-sqlite3 ≥ 12.11.1` for Electron 42 (floor-tested), and pair it with **CI Node ≥ 22**
so Windows Verify gets a prebuilt instead of compiling. Leave
`enableEmbeddedAsarIntegrityValidation` **off** in `electron-builder.yml` until Developer ID signing +
notarization land, then flip it on in the same change. Don't re-add a `rebuild:native` pre-step to `dist`;
let electron-builder rebuild natives. After any local `pnpm dist`, run `pnpm rebuild better-sqlite3` before
`pnpm test`. Don't run `@electron/rebuild` from a nested worktree.

### [2026-06-24] axe-core in jsdom cannot judge colour-contrast — assert tokens, not pixels
**Context**: Card X2 — adding `axe-core` to ratchet WCAG 2.1 A/AA across every renderer screen, and trying
to make the suite catch the sub-AA placeholder colour (issue #104).
**Learning**:
- **`color-contrast` is reported as `incomplete`, never `violation`, under jsdom.** axe needs real layout
  and a canvas to sample rendered pixels; jsdom has neither (you'll see `HTMLCanvasElement.getContext()
  not implemented` on every run). So an `axe(container)` sweep — even with the contrast rule enabled — will
  pass on a screen whose text is below AA. It is a genuine regression net for **structural/semantic** rules
  (roles, names, labels, landmarks, `aria-*`), not for contrast.
- **Therefore assert contrast at the token/class level, not via axe.** Issue #104 is locked in by asserting
  the input's `className` carries `placeholder:text-text-secondary` (7.77:1) and **not**
  `placeholder:text-text-tertiary` (3.98:1). The actual ratios live in `USER_FLOWS.md` §6.1 and are the
  ground truth; the test guards the binding, the doc guards the number.
- **Keep the helper scoped to violations only.** `runOnly: { type: 'tag', values: ['wcag2a','wcag2aa',
  'wcag21a','wcag21aa'] }` + `resultTypes: ['violations']` maps precisely to "WCAG 2.1 AA" and keeps the
  noisy `incomplete` bucket (including contrast) out of the assertion.
**Impact**: Future a11y work should pair axe sweeps (structure/semantics) with explicit token assertions or
a real-browser check (Playwright) for any contrast claim. Don't trust a green axe run as proof of contrast.

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
