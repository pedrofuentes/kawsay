# Architecture Decision Records — Kawsay

> **Record every significant technical decision here.** When choosing between approaches,
> document what was chosen and why. This prevents future agents and developers from
> re-debating settled decisions or accidentally reversing them.
>
> Do NOT write decisions to AGENTS.md — they belong here.

## Format

```markdown
### ADR-NNN: Decision Title
**Date**: YYYY-MM-DD
**Status**: Proposed / Accepted / Superseded by ADR-NNN
**Context**: What problem or question prompted this decision?
**Decision**: What was decided?
**Alternatives considered**: What other options were evaluated?
**Consequences**: What are the trade-offs? What does this enable or prevent?
```

> **Authorization tiers** (MISSION §9) are noted on each ADR: `auto` (reversible) · `auto-with-audit`
> (this ADR is the audit note) · `human-required` (blocks until @pedrofuentes approves). The full
> *how* for each decision lives in [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md).

## Decisions

<!-- Add new decisions below this line, most recent first -->

---

### ADR-0019: Defer enableEmbeddedAsarIntegrityValidation to the signed build
**Date**: 2026-06-24
**Status**: Accepted (refines ADR-0007; v1 exception to ARCHITECTURE §2.5)
**Tier**: auto-with-audit (adjusts the declared security posture for the *unsigned* v1 build). This ADR is
the audit note.

**Context**
`electron/fuses/fuses.ts` `FUSE_CONFIG` declares `enableEmbeddedAsarIntegrityValidation: true` as the
target packaged-app posture. On macOS this fuse **requires code signing**: the asar-integrity hash lives in
`Info.plist` and is only trusted under a valid signature. On the unsigned v1 build (`mac.identity: null`;
signing is a deferred human-required step — ADR-0007), enabling it makes Chromium refuse to load the
renderer from the asar — the packaged app starts but the window is blank with
`Failed to load URL … app.asar/out/renderer/index.html (ERR_FILE_NOT_FOUND)`. This is the documented
Electron behaviour for unsigned builds.

**Decision**
The unsigned v1 build flips every declared fuse **except** `enableEmbeddedAsarIntegrityValidation`, which is
set `false` in `electron-builder.yml`. `FUSE_CONFIG` keeps `true` as the signed-production target, and the
drift guard in `tests/unit/packaging-config.test.ts` encodes the exception (all other fuses lock-step;
integrity asserted `false` for v1 against the `true` FUSE_CONFIG target). The cofounder re-enables it in
`electron-builder.yml` together with Developer ID signing + notarization (see the release checklist).

**Alternatives considered**
- *Keep it `true` and ship v1* — rejected: produces a blank-window app on every unsigned build (including CI
  smoke builds and any pre-signing testing), verified locally.
- *Change FUSE_CONFIG to `false`* — rejected: FUSE_CONFIG is the declared *signed-production* target;
  flipping it there would lose the intent and the cofounder's re-enable signal. The deviation belongs in the
  v1 build config, documented and test-pinned.
- *Ad-hoc sign the whole app to satisfy integrity* — rejected: `resetAdHocDarwinSignature` only re-signs the
  fuse-modified binary; a meaningful integrity guarantee needs the real Developer ID signature, which is the
  deferred human step anyway.

**Consequences**
- ✅ The unsigned v1 dmg/zip launches and loads the renderer (verified) while keeping all other hardening
  fuses active (no Node escape hatches, asar-only loading, hardened `file://`, encrypted cookies).
- ⚠️ asar tamper-evidence is not active until signing is configured; re-enabling it is a checklist item on
  the human-required first-publish gate.

---

### ADR-0018: Bump better-sqlite3 12.9.0 → 12.11.1 for Electron 42 native compatibility
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
- Called out for review per the card's "only electron-builder" constraint: this is a required compatibility
  bump of an existing runtime dependency, not a new package.

---

### ADR-0017: Packaging finalization (card P1) — fuse-flip mechanism, non-publishing auto-builds, ABI ordering
**Date**: 2026-06-24
**Status**: Accepted (refines ADR-0007)
**Tier**: auto-with-audit. No new *package* is added (electron-builder + @electron/rebuild already present);
the one dependency change is a patch-level bump of the existing `better-sqlite3` for Electron-42 native
compatibility (ADR-0018). Every choice here is reversible config + dev assets, and the local-only runtime
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
   `enableEmbeddedAsarIntegrityValidation` is deferred on the unsigned v1 build (ADR-0019).
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
  (ERR_FILE_NOT_FOUND). It is deferred to the signing step (ADR-0019).

**Consequences**
- ✅ `pnpm dist` builds the macOS dmg/zip (arm64 + x64) locally with the native catalog engine loading under
  Electron's ABI and the hardening fuses active — verified by launching the packaged app (the renderer and
  the eagerly-loaded `better-sqlite3` 12.11.1 both come up clean).
- ✅ The only dependency change is the `better-sqlite3` patch bump (ADR-0018); no new package is added.
- ✅ An automated build cannot publish a release; publishing remains a deliberate human act.
- ⚠️ Running `pnpm test` immediately after `pnpm dist` fails until `pnpm rebuild better-sqlite3` restores
  the Node ABI — documented in LEARNINGS and handled by ordering in the release workflow.
- ⚠️ Windows `.exe` cannot be cross-built on macOS (native module + NSIS); it is produced on the Windows CI
  runner. The config is verified correct; the artifact itself is built/smoke-launched on `windows-latest`.

---

### ADR-0016: jsdom + Testing Library (dev-only) to drive the renderer test-first
**Date**: 2026-06-24
**Status**: Accepted
**Tier**: auto-with-audit. Every addition is a **devDependency** — it ships in no production bundle, opens
no network or external origin, and leaves the local-only runtime (ADR-0008, AC-4) untouched; this ADR is
the required audit note.

**Context**
SENTINEL/AGENTS mandate test-first. Before card U3 the suite was Node-only (importers, IPC, security)
under Vitest; there was no way to render a React component or assert on the DOM, so the onboarding flow
and the shared renderer foundation could not be built test-first. A renderer test environment was needed.

**Decision**
Add dev-only `jsdom` and `@testing-library/{react,jest-dom,user-event}`, and split `vitest.config.ts`
into two projects: the existing **node** project and a new **renderer** project (jsdom environment,
`tests/renderer/setup.ts`). Renderer specs use Testing Library role/label queries and `user-event` —
mirroring how a non-technical user actually operates the UI — and the suite stays a single `pnpm test`.

**Alternatives considered**
- **happy-dom** instead of jsdom: lighter, but jsdom is the most widely-exercised, best-compatible DOM for
  Vitest + Testing Library; chosen for reliability over a marginal speed gain.
- **Playwright component / e2e testing only**: heavier, slower, Electron-oriented here, and unsuitable as a
  fast TDD inner loop. Playwright is still used out-of-band for the visual/screenshot pass.
- **No renderer tests** (manual checking only): violates the test-first mandate; rejected.

**Consequences**
- The renderer is now TDD-able (55 renderer specs landed with U3) and CI runs them in the same `pnpm test`.
- Three small, well-known test-only packages enter the lockfile; none reach production or the network.
- U1/U2 inherit the harness and the `tests/renderer/support` helpers (a fake `window.kawsayAPI`, a render
  wrapper) and write their screens test-first with no further setup.

---

### ADR-0015: Dependency-free typed view router for the renderer (no `react-router-dom`)
**Date**: 2026-06-24
**Status**: Accepted
**Tier**: auto-with-audit (card U3 pre-authorized adding `react-router-dom` as auto-with-audit; this ADR is
the required audit note for choosing instead to add **no** dependency). Adds no network egress, backend, or
external origin, so the local-only invariant (ADR-0008, AC-4) is untouched.

**Context**
Card U3 builds the first real renderer: onboarding (welcome → name → library location → source →
walkthrough → locate → import) plus a main app shell with a handful of sections (Timeline, Search, Add
memories, Settings). The renderer needs a way to move between these views, and U1/U2 need a way to add
their own screens. Kawsay is a single-window, fully-offline Electron app with no URLs, no deep-linking, no
server-side routing, and a deliberately small, finite set of screens.

**Decision**
Use a hand-rolled, **fully-typed view-state router** built on React context: a `View` discriminated union
(`{ name: 'onboarding' | 'timeline' | 'search' | 'add-memories' | 'settings' }`), a `NavigationProvider`
holding the current view, and a `useNavigation()` hook exposing `{ view, navigate }`. Onboarding's internal
step machine (`welcome → … → import`) is local state within `OnboardingFlow`. No routing library is added.

**Alternatives considered**
- **`react-router-dom`** (pre-authorized): mature and familiar, but built around URLs / history / deep-
  linking that a single-window offline desktop app does not have. It would add a dependency (and its
  transitive surface) to express what a ~20-line typed union already expresses, invite URL-shaped patterns
  that do not map to this app, and grow the bundle for no user-visible benefit.
- **A state-machine library (XState, etc.)**: far more than a few-screen calm app needs; rejected on the
  same zero-dep, low-complexity grounds.

**Consequences**
- Zero new runtime dependencies; nothing to audit for egress; smaller bundle; the navigation surface is
  exhaustively typed (adding a screen is a compile error until every `switch` handles it).
- U1 (timeline) and U2 (search) extend navigation by adding a member to the `View` union and a `case` in
  the renderer — no router config, loaders, or path strings.
- No URL / deep-link / back-forward history semantics. If a future card needs genuine deep-linking or many
  dozens of screens, this ADR can be superseded; for the current and foreseeable scope the typed union is
  simpler and safer.

---

### ADR-0014: Hand-rolled RFC 4180 CSV reader for the LinkedIn importer (no `csv-parse`/`papaparse` dependency)
**Date**: 2026-06-24
**Status**: Accepted
**Tier**: auto-with-audit (card C5 pre-authorized adding `csv-parse` as auto-with-audit; this ADR is the
required audit note for choosing instead to add **no** dependency). Adds no network egress, backend, or
external origin, so the local-only invariant (ADR-0008, AC-4) is untouched.

**Context**
Card C5 (#12) adds the LinkedIn importer (AC-16), which must parse LinkedIn's `messages.csv`,
`Connections.csv`, and `Rich_Media.csv`. Real exports are messy: quoted fields with embedded commas and
newlines, doubled `""` escapes, a UTF-8 BOM on the first cell, mixed CR/LF/CRLF terminators, and a free-text
`Notes:` preamble before `Connections.csv`'s header. Splitting naively on commas/newlines would truncate a
message or smear it across rows — the exact "never silently drop a memory" failure the WhatsApp importer was
hardened against. The card pre-authorized adding the tiny, well-known `csv-parse` for this (auto-with-audit),
and `docs/ARCHITECTURE.md` had floated `papaparse` as a candidate.

**Decision**
Add **no** new dependency. Implement a small, dependency-free, single-pass RFC 4180 reader at
`electron/main/importers/csv.ts` (`parseCsv(input): string[][]`) that handles quoted fields, embedded
commas/newlines, doubled-quote escapes, a leading BOM, and CR/LF/CRLF rows. Header interpretation (locating
the real header past a preamble, case/space-insensitive column matching, synonyms) stays in the importer,
not the reader. The reader and the importer's CSV behavior are pinned by unit tests (`tests/unit/csv.test.ts`
plus the LinkedIn importer suite).

**Alternatives considered**
- **`csv-parse`** (pre-authorized): battle-tested and correct, but adds a runtime dependency + transitive
  supply-chain surface to a zero-egress, local-only app for what is ~60 lines of well-understood parsing.
- **`papaparse`** (floated in ARCHITECTURE): heavier and browser/stream-oriented; more surface than this
  main-process path needs.
- **Naive split on `,`/`\n`**: rejected outright — it corrupts quoted commas/newlines and loses data.

**Consequences**
- Zero added dependency, install-time, and supply-chain surface; nothing weakens the AC-4 local-only / no-egress
  invariant. We own the parsing semantics and they are fully unit-tested against adversarial fixtures.
- Trade-off: we maintain the reader ourselves and must keep its edge-case coverage honest (quoted
  commas/newlines, doubled quotes, BOM, CR/LF/CRLF, preamble) — which the committed tests enforce. If a future
  importer needs streaming or dialect-detection beyond RFC 4180, revisit adopting `csv-parse` (this ADR would
  be superseded).

---

### ADR-0013: Revert Takeout email tooling to `mailparser` + an in-module streaming `From `-delimited splitter (supersedes ADR-0009)
**Date**: 2026-06-24
**Status**: Accepted
**Tier**: auto-with-audit (dependency choice for the C4 Takeout importer; this ADR is the audit note and
restores the `mailparser` reference named in MISSION §3 / AGENTS.md §Tech stack; MISSION §9).

**Context**
ADR-0009 substituted the MISSION §3 / AGENTS.md-named **`mailparser`** with **`mbox-parser` + `postal-mime`**
to satisfy AC-11's two requirements: (1) **split** a multi-message Gmail `.mbox`, and (2) do so by
**streaming**, never loading a (potentially multi-GB) mailbox into memory. Implementing card C4 (#11), the
delegated scope is explicit: use **`mailparser`** (the pre-approved §3 dependency) and pair it with an
in-repo streaming splitter — exactly the "equivalent streaming `From `-delimited splitter … hand-rolled
splitter as the documented escape hatch" that ADR-0009 itself sanctioned. `mbox-parser` + `postal-mime`
were never added to the lockfile, so this is a forward choice, not a removal.

**Decision**
Add **only** `mailparser` (+ `@types/mailparser`) — both pre-approved in MISSION §3. The importer's parse
phase is *stream-split → per-message parse → normalize → emit*:
- **Splitter (in-module, streaming):** read the `.mbox` through a new `FsLike.openReadStream` seam and a
  `node:readline` interface, accumulating lines and flushing a message on each `^From ` separator
  (mboxrd), unescaping `>From ` body lines so they are never mistaken for a separator. The whole file is
  never buffered — constant-memory at any size (AC-11). A separate streaming-splitter **dependency** is
  therefore unnecessary.
- **Per-message parse:** `mailparser`'s `simpleParser` on each extracted block. A block that throws, or
  that has no recognizable headers (truncation / binary noise), is a **skip** (`E_PARSE_MSG`, AC-15).
- Email attachments are materialized into the import scratch dir through a second new optional seam,
  `FsLike.writeFile`, so the worker hashes + content-addresses them like any archive original (§4.4).

**Alternatives considered**
- *Keep ADR-0009 (`mbox-parser` + `postal-mime`).* Rejected for this card: it contradicts the delegated
  instruction and MISSION §3, and would add two deps where the streaming split is a few dozen lines of
  `readline` over a seam we already needed for the multi-GB memory bound.
- *Load the whole `.mbox` and split in memory.* Rejected — violates AC-11 and OOMs on multi-GB exports.
- *A dedicated streaming-splitter dependency.* Unnecessary once the read-stream seam exists; fewer deps =
  smaller supply-chain surface. The `From `/`>From ` mboxrd rules are small and unit-tested adversarially.

**Consequences**
- ✅ AC-11 streaming satisfied with **one** pre-approved dep: constant-memory `.mbox` import at any size;
  messages parsed and emitted one-by-one.
- ✅ Restores the MISSION §3 / AGENTS.md `mailparser` reference; **supersedes ADR-0009** (no invariant
  weakened — still local-only, still streaming, still off-thread; email parsing stays isolated with
  `try/catch` and a malformed message is a skip, AC-15).
- ⚠️ The mboxrd split logic is maintained in-repo (`takeout-importer.ts`) rather than delegated to a
  library — covered by streaming/`>From`/truncation unit tests so regressions surface immediately.
- ➕ Two **optional** `FsLike` methods (`openReadStream`, `writeFile`) are added to the DI seam; existing
  importers and their fixtures are untouched (backward-compatible).

---

### ADR-0012: Media-ingestion dependencies (`exifr`, `fluent-ffmpeg`, `ffmpeg-static`, `ffprobe-static`) + the off-thread ingestion engine, split out of F3b
**Date**: 2026-06-23
**Status**: Accepted
**Tier**: auto-with-audit (new **non-heavy** runtime deps + a new internal module boundary — MISSION §9; this
ADR is the required audit note). None of these adds network egress, a backend, or an external origin, so the
local-only invariant (ADR-0008) is untouched.

**Context**
Card F3b (#47) wires the F3 contracts (`Importer`/`CatalogRecord`/`ImporterDeps`, `CatalogRepo`,
`originals-store`, `library-service`) into a runnable ingestion engine and exposes it over IPC. Two things
are needed before any importer can produce a catalogued memory: (a) concrete, sandboxed `ImporterDeps`
wrappers (EXIF reader, media prober, file hasher) plus a thumbnail/poster generator, and (b) an
orchestrator that drains an `Importer`'s `CatalogRecord`s and persists them with dedup-with-provenance,
content-addressed originals, and generated renditions — off the UI thread (AC-9; ARCHITECTURE §5).

**Decision**
- Add four **runtime** dependencies, each consumed only in the main-process ingestion path:
  - **`exifr`** — capture-date/GPS/camera EXIF reader (`ExifReader`). Wrapped so a malformed header is a
    **skip**, never a crash (AC-15; ARCHITECTURE §7.2). EXIF carries no timezone → read as **UTC** (§3.2).
  - **`ffprobe-static`** — bundled, pinned `ffprobe` binary; **`fluent-ffmpeg`** — a thin, well-known
    launcher used **only** to spawn that binary for the `MediaProber` (duration/dimensions). It is a
    subprocess handed **only a local path** as an argv element (no shell string), closing the AC-4
    subprocess gap (ARCHITECTURE §6.1/§7.2).
  - **`ffmpeg-static`** — bundled, pinned `ffmpeg` binary; invoked **directly** via `child_process.spawn`
    with an **array argv** (never a shell string, only local paths) to write WebP thumbnails/posters into
    the library `derived/` tree.
- **Split F3b** per its own size guard. This PR delivers the **media-deps + the off-thread ingestion
  orchestrator** (the engine); the **IPC layer** (`library:create/open`, `catalog:timeline/search`,
  `import:start/cancel/progress`) and the worker/`utilityProcess` harness that runs the orchestrator
  off-thread land in a follow-up card **F3c**, where `import:start` spawns the worker and an integration
  test exercises it. The orchestrator is written thread-agnostic (a pure async function over injected
  deps + `AbortSignal` + `onProgress`) precisely so the F3c harness can run it in a worker unchanged.

**Alternatives considered**
- *Call `ffprobe` directly via `spawn` instead of `fluent-ffmpeg`* — viable and aligned with ADR-0004's
  "call the binaries directly", but the card names `fluent-ffmpeg` and it is a thin, battle-tested arg
  builder for the probe path only; the `MediaProber` runner is injectable, so dropping `fluent-ffmpeg`
  later is a one-line change behind the seam. `ffmpeg` (thumbnails) **is** called directly.
- *`sharp` for image thumbnails* (ARCHITECTURE §5.1 preference) — deferred: its native rebuild is heavier
  than the four bundled-binary deps here; v1 uses `ffmpeg` for both stills and video posters (§5.1 permits
  this) and `sharp` can be introduced later behind the same `ThumbnailGenerator` seam.
- *Ship the whole F3b card (engine + IPC + worker) in one PR* — rejected by F3b's explicit
  `~10 files / ~500 LOC` reviewability guard; split into engine (this PR) + IPC (F3c).

**Consequences**
- ✅ Importers get real EXIF/probe/hash deps and the worker gets a thumbnail generator, all behind the
  injectable seams F3 defined — unit-testable with fixtures/mocks, no binaries required for the logic tests.
- ✅ ffmpeg/ffprobe stay isolated subprocesses fed only local paths (AC-4 subprocess gap closed).
- ✅ Each PR stays reviewable; the orchestrator is thread-ready for the F3c worker harness.
- ⚠️ `fluent-ffmpeg` is deprecated (flagged in ADR-0004); kept narrowly for the probe path behind an
  injectable runner, a candidate to drop. ⚠️ `ffmpeg-static`'s binary download (a postinstall) is **not**
  enabled in `onlyBuiltDependencies`, so CI installs stay fast and egress-free and unit tests use mocked
  subprocesses; provisioning/bundling the real binaries for the packaged app is an electron-builder/dist
  concern (ADR-0004/ADR-0007), not this card.

---

### ADR-0011: `nock` as the http(s) layer of the AC-4 zero-egress test harness
**Date**: 2026-06-23
**Status**: Accepted
**Tier**: auto-with-audit (test-only tooling — MISSION §9 lists test dependencies as `auto`; this ADR is
the required audit note for the addition). **`nock` is a `devDependency` only** — it never ships in the
packaged app and adds no runtime/network capability to the product.

**Context**
Card X1 (#16) builds the AC-4 harness (ARCHITECTURE §6.2; ADR-0008 §5). The Node-side defense-in-depth
spies must assert **zero** outbound `http`/`https` requests during a representative flow. Prototype
patching (`net.Socket.prototype.connect`, `dgram.Socket.prototype.send`) reliably intercepts raw
TCP/UDP/TLS/HTTP2 regardless of ESM/CJS import style, but the canonical, well-understood way to deny and
record the **http(s) client layer** is `nock.disableNetConnect()` — exactly the tool PRD AC-4 and
ARCHITECTURE §6.2 name ("`nock.disableNetConnect()` for `http(s)`").

**Decision**
Add **`nock@^14`** as a **devDependency**. It is used only under `tests/ac4/` to (a) deny all net
connect at the http layer during the in-process spy run and (b) prove the harness is not a silent no-op
via a positive control (a deliberate `http`/`https` request that `nock` must block). No other dependency
is added by this card.

**Alternatives considered**
- *Hand-roll an `http`/`https` agent stub.* Rejected — reinvents `nock`, less battle-tested, and the
  acceptance criterion explicitly names `nock`.
- *Rely solely on the socket prototype patch for http(s).* Rejected as the primary http assertion —
  the prototype patch is kept as defense-in-depth, but `nock` is the documented, legible http-layer
  control and makes the positive control unambiguous.

**Consequences**
- ✅ The http(s) layer of AC-4 is asserted with the tool the spec names; positive control is legible.
- ✅ Zero production impact — `devDependency`, used only in `tests/ac4/`.
- ⚠️ One more dev dependency to keep patched (Dependabot covers it).

---

### ADR-0010: Build tooling for the app shell — `electron-vite` pinned to `^4` (not `^5`) + Tailwind CSS v4
**Date**: 2026-06-23
**Status**: Accepted
**Tier**: auto-with-audit (build tooling — ARCHITECTURE §1.2 mandates `electron-vite`; `tailwindcss` is
named in MISSION §3. This ADR is the audit note for the *versions* chosen while scaffolding card F1).

**Context**
ARCHITECTURE §1.2 (line 70) requires the shell be "**Built with `electron-vite`** (one config drives the
main / preload / renderer triple build; HMR…)". MISSION §3 pins **Vite** for the renderer. Our lockfile
resolves Vite to the current 5.x line (**5.4**). Two version questions had to be settled to make
`pnpm typecheck` / `pnpm build` pass:
1. **`electron-vite` major.** The newest is `5.x`, but `electron-vite@5`'s own config typings import
   **`BuildEnvironmentOptions`** from Vite — a type that only exists in **Vite 6+**. Against the
   Vite 5.4 we depend on, `tsc --noEmit` of `electron.vite.config.ts` fails on every `build.lib` /
   `build.rollupOptions` field (the symbol is absent from all Vite 5.4 `.d.ts`), even though the config
   runs fine at runtime. Our gate is **zero-warning typecheck**, so a config that doesn't type-check is
   not acceptable.
2. **Tailwind major.** `tailwindcss` is in MISSION §3 with no pinned major; v4 is current.

**Decision**
- Pin **`electron-vite@^4`** (resolved `4.0.1`) — the newest major whose published types are
  **Vite-5-compatible**: its peer range is `vite@^5 || ^6 || ^7`, it does **not** reference
  `BuildEnvironmentOptions`, and each process block is a plain Vite `UserConfig`. Typecheck is clean.
- Adopt **Tailwind CSS v4** with the CSS-first `@theme {}` API (`src/styles/tokens.css`) to express the
  USER_FLOWS §5 design tokens (calm palette, Lora/Inter type scale, spacing, radii, motion) — no
  `tailwind.config.js` needed; tokens live beside the CSS that consumes them.
- Consequence of `electron-vite` + sandbox: the **preload is emitted as CommonJS** (`index.cjs`) and
  **`zod` is bundled into it** (a sandboxed preload cannot `require` from `node_modules`); main and
  renderer stay ESM. The non-default `electron/` + `src/` layout (ARCHITECTURE §1.2) means electron-vite
  auto-discovery is bypassed in favour of explicit `build.lib.entry` / `rollupOptions.input`.

**Alternatives considered**
- *`electron-vite@5` + Vite 5* — **rejected**: fails the typecheck gate (`BuildEnvironmentOptions`).
- *Bump Vite to 6 to satisfy `electron-vite@5`* — **rejected**: MISSION §3 names Vite as the scaffold's
  pinned bundler and the rest of the stack (`@vitejs/plugin-react@^4`) is validated against Vite 5; a
  Vite-major bump is a larger, separate decision, not a scaffolding side-effect.
- *Raw Vite with three hand-rolled configs (no `electron-vite`)* — **rejected**: ARCHITECTURE §1.2
  explicitly mandates `electron-vite`.
- *Tailwind v3 with a JS config* — **rejected**: v4 is current and its `@theme` keeps tokens declarative
  and co-located; no behavioural feature depends on v3.

**Consequences**
- `pnpm typecheck` / `pnpm lint` / `pnpm build` are green on the pinned Vite 5.4 toolchain; the
  main/preload/renderer triple builds from one `electron.vite.config.ts`.
- When the project later moves to **Vite 6+** (its own ADR), `electron-vite` can be bumped to `^5`
  without code changes — purely a tooling refresh.
- `electron@42` has **no `postinstall`**; it self-provisions its binary lazily on the first
  `require('electron')` (i.e. first `pnpm dev` / launch), so a fresh `pnpm install` + `pnpm build` works
  offline and pnpm's build-script gating does not apply to it. See LEARNINGS.

---

### ADR-0009: Takeout `.mbox` streaming split + email-parser substitution (`mailparser` → `mbox-parser` + `postal-mime`)
**Date**: 2026-06-23
**Status**: Superseded by ADR-0013
**Tier**: auto-with-audit (dependency substitution + new internal parse tooling — this ADR is the audit
note for the `mailparser` reference in MISSION §3 / AGENTS.md §Tech stack; MISSION §9).

**Context**
MISSION §3 / AGENTS.md name **`mailparser`** for "Takeout / email". Two problems surfaced in red-team:
(1) **`mailparser` and `postal-mime` parse a *single* RFC-822 message** — neither can *split or stream*
a multi-message Gmail **`.mbox`**, which in a real Takeout can be **multiple GB**; (2) **AC-11 requires
streaming** parses that **do not load the whole `.mbox` into memory**. A single-message parser alone
therefore cannot satisfy AC-11, regardless of which one we pick.

**Decision**
Split the `.mbox` with a **streaming splitter** — **`mbox-parser`** (async-paginated; reads
message-by-message without buffering the file; an equivalent streaming `From `-delimited splitter is an
acceptable substitute) — and parse **each** extracted message with **`postal-mime`** (modern, zero-dep,
ESM, actively maintained) **instead of `mailparser`**. The importer's parse phase becomes
*stream-split → per-message parse → normalize → emit* (ARCHITECTURE §3.2/§5). Both are **non-heavy**
deps. This ADR is the required **auto-with-audit** note for substituting `mailparser`; the substitution
changes only *which* email tooling is used — it **weakens no invariant** (still local-only, still
streaming, still off-thread).

**Alternatives considered**
- *Keep `mailparser`.* It is older, heavier (callback/stream API), and **still single-message** — a
  splitter would be required anyway. `postal-mime` chosen for ESM + active maintenance + smaller surface.
- *Load the whole `.mbox` and split in memory.* **Rejected** — violates AC-11 streaming and OOMs on
  multi-GB exports.
- *Hand-roll a `From `-line splitter.* Viable as a fallback, but easy to get subtly wrong (quoting,
  `>From` escaping); a maintained streaming splitter is preferred, with a hand-rolled splitter as the
  documented escape hatch if the dep is ever unsuitable.

**Consequences**
- ✅ AC-11 streaming satisfied: constant-memory `.mbox` import at any size; messages fed one-by-one to
  the per-message parser and emitted as found (first-memory payoff, SM-2).
- ✅ The MISSION §3 / AGENTS.md `mailparser` reference is **superseded for v1** by `mbox-parser` +
  `postal-mime`, audited here (auto-with-audit; the §3 stack list is illustrative — "e.g." tooling).
- ⚠️ Two small deps instead of one; both pinned and Dependabot-tracked. Email parsing remains isolated
  in the worker with `try/catch` + per-message caps (a malformed message is a **skip**, AC-15).

---

### ADR-0008: Privacy, data location & the local-only / zero-egress invariant
**Date**: 2026-06-23
**Status**: **Proposed — HUMAN-REQUIRED sign-off (@pedrofuentes) before the data-layer / F3 code is written.**
**Tier**: human-required (privacy/data design — MISSION §9; AGENTS §HUMAN REQUIRED).

> **This ADR is self-contained so the cofounder can approve it directly.** It is the gate for the
> entire data layer (ADR-0003 schema/migrations) and the AC-4 zero-egress invariant. No
> F3 (data-layer) code may be written until this is approved with a `decision:approved` label /
> review from @pedrofuentes.

**Context**
Kawsay catalogues the **extremely sensitive personal data of a deceased person who can no longer
consent** (PRD §2.3). MISSION §5 makes one promise binding above all others: *"All data stays on the
user's device. Nothing is uploaded; no telemetry; no analytics on user content. A loved one's memories
must never leave the machine."* It is a **core, tested promise** (AC-4) and on the NEVER list (MISSION
§7; AGENTS NEVER §Project). Before any code reads or writes user memories, the cofounder must approve
**(a)** exactly where that data lives on disk, **(b)** what is stored, **(c)** the guarantee that
nothing leaves the device, **(d)** the threat model for untrusted export files, and **(e)** how the
invariant is enforced and tested.

**Decision** *(proposed — awaiting @pedrofuentes)*

1. **Where the data lives.** One **user-chosen library folder** (default: a recommended location via
   the `LibraryLocationPicker`; e.g. `~/Documents/Kawsay/<Name>'s Library` or a folder the user picks).
   The library is **self-contained and portable** and contains **only** the user's memories + catalog:
   ```
   <library root>/
   ├── catalog.sqlite3 (+ -wal, -shm)   the SQLite catalog/index (better-sqlite3)
   ├── originals/<hash[0:2]>/<hash>[.ext]   archive-extracted originals, CONTENT-ADDRESSED, stored ONCE
   ├── derived/{thumbnails,posters,waveforms}/…   Kawsay-generated, rebuildable
   ├── extract/<source-id>/…            transient extraction scratch (deleted after each import)
   └── logs/
   ```
   - **Folder imports are referenced in place** — the user's photos/videos are **never copied or
     moved**; the catalog records their absolute path on an `in_place` occurrence. (AC-14.)
   - **Archive imports** (WhatsApp/Takeout/Facebook/LinkedIn `.zip`) copy each original **once,
     content-addressed**, into `originals/<hash[0:2]>/<hash>[.ext]`; identical bytes from a second
     source are **not** re-copied (no duplicate storage). The blob is **reference-counted by
     occurrence** and deleted only when its last occurrence is undone (§4.4) — so undo never dangles a
     deduped memory. The **source `.zip` is never altered or deleted**.
   - **App config** (window size, last-opened library path, accessibility prefs) lives separately in
     Electron `userData` — **never** user memory content.

2. **What is stored.** In `catalog.sqlite3`: per-item media type, MIME, **SHA-256 content hash** (dedup
   key), **capture date (canonical ISO-8601 UTC) vs import date**, EXIF (incl. **GPS coordinates —
   catalogued locally only; never sent to any online map/geocoder**), message/caption text, and
   per-source **provenance** (`item_occurrences`, including how each occurrence's original is retained).
   A memory's **original is resolved through a surviving occurrence** (there is no single `stored_path`),
   so dedup + undo stay consistent. Generated thumbnails/posters live in `derived/`. Nothing else; **no
   account, no identifiers, no telemetry**.

3. **The guarantee — no user memory data ever leaves the device.**
   - **No network client exists in v1** — no `fetch`, no telemetry SDK, no update check, no remote
     fonts/CDN/maps. Fonts (`Lora`, `Inter`) and icons are **bundled** (`.woff2` / local SVG sprite).
   - **Renderer CSP `connect-src 'none'`** forbids all `fetch`/XHR/WebSocket from the UI.
   - **Main-process network guard** (`session.webRequest.onBeforeRequest`) cancels every request whose
     scheme is not `file:` / `kawsay-media:` / `blob:` / `data:`.
   - **ffmpeg/ffprobe** subprocesses receive **only local file paths, never URLs**, so they cannot be
     coerced into network I/O.
   - Adding *any* network egress, backend, account, cloud sync, or telemetry is **human-required**
     (or **never**, if it would break this guarantee) regardless of default tier (MISSION §9 override).

4. **Threat model for untrusted export files.** Export archives are **untrusted, attacker-influenceable
   input**. Mitigations (ADR-0006; ARCHITECTURE §7): zip-slip/path-traversal rejection
   (`ERR_ARCHIVE_UNSAFE_PATH`), decompression-bomb caps (per-entry/total/ratio/count →
   `ERR_ARCHIVE_BOMB`), **symlink rejection** (`ERR_ARCHIVE_SYMLINK`), strict filename validation, and
   `zod`-validated JSON/CSV/sidecars. Media parsing (`exifr`, `ffprobe`) is isolated in
   worker/`utilityProcess` with timeouts + output caps so a malformed file cannot crash or hang the app
   or escape its sandbox. A single bad file is a **skip** (AC-15), never a crash.

5. **How the invariant is enforced + tested (AC-4).** Defense-in-depth at runtime (items 3 above) **and
   proven automatically by an authoritative OS layer plus defense-in-depth spies and positive controls**
   (ARCHITECTURE §6.2):
   - **(Authoritative, MANDATORY) An OS-level outbound-deny firewall** runs in the AC-4 e2e CI job —
     denying all egress except loopback while the **packaged** app runs the full flow. It is the layer
     that actually covers the **Node main + worker threads, the `ffmpeg`/`ffprobe` subprocess, and DNS
     resolution**. The job **asserts the deny rule is active** before trusting a green run — if the
     firewall is not in place the job **fails** (no silent no-op).
   - **(Defense-in-depth) Node-side spies** over **`net`, `tls`, `http2`, `dgram` (UDP), and
     `dns.lookup`/`dns.resolve`**, plus `nock.disableNetConnect()` for `http(s)`, across every importer
     — assert **zero** attempts. (Spies cannot see the subprocess; the OS firewall is authoritative.)
   - **(Defense-in-depth) Playwright `page.route`** over the renderer — asserts **zero** outbound.
   - **Positive controls (anti-false-pass):** deliberate outbound attempts from **the main process, a
     worker thread, and the `ffmpeg`-subprocess path** that the harness **must** catch — so a
     misconfigured firewall fails the job instead of silently passing.
   Any PR touching the network guard, CSP, the firewall step, or AC-4 tests is **harness-integrity →
   human-required** and may **never** weaken the promise.

**Alternatives considered**
- *Store the library in Electron `userData` (hidden app folder).* Rejected as the **default** — users
  must be able to see, choose, back up, and one day hand the archive to family (Mateo); a portable,
  user-chosen folder serves the "gift to the family" goal (PRD §2.2). `userData` is used only for app
  config.
- *Copy folder-import originals into the library too (uniform storage).* Rejected — copying risks the
  "originals altered/duplicated" failure and doubles disk use; AC-14 requires folder originals stay
  byte-identical in place. Archives are copied only because their contents must be extracted out of the
  `.zip` to be catalogued.
- *Copy archive originals per-source into `originals/<source-id>/…` with one `items.stored_path`.*
  **Rejected** — it **double-stores** bytes that arrive from two sources, and on undo of the owning
  source it **dangles** the original for a still-deduped item (the `stored_path` points at a deleted
  copy) — violating AC-14's "undo without data loss". Replaced by **content-addressed storage stored
  once** (`originals/<hash[0:2]>/<hash>[.ext]`), **reference-counted by occurrence**, with the original
  resolved through a *surviving* occurrence (ADR-0003; ARCHITECTURE §4.4).
- *Encrypt the catalog/originals at rest.* Deferred — v1 relies on OS-level disk encryption + the
  local-only guarantee; app-level encryption (key management for a non-technical, grieving user) is a
  future consideration, not a v1 requirement, and would add recovery-loss risk. Flagged for the
  cofounder's input.
- *Allow GPS map rendering / reverse-geocoding.* Rejected for v1 — it requires network egress and would
  break AC-4 (PRD §7). Coordinates are stored locally only.

**Consequences**
- ✅ A clear, approvable privacy contract the whole build implements against; the data layer can begin
  once signed off.
- ✅ The portable, user-chosen library is durable, inspectable, and family-handoff-ready (open formats,
  originals preserved).
- ✅ The zero-egress promise is both designed-in and continuously tested. The AC-4 proof is **airtight**:
  a **mandatory, self-asserting** OS firewall covers the **subprocess + DNS**, broadened Node spies and
  Playwright add defense-in-depth, and **positive controls** make a misconfigured green run impossible
  (MISSION §5, AC-4).
- ✅ Content-addressed, occurrence-refcounted originals make **undo lossless even for deduped memories**
  (no dangling original; no double-stored bytes), satisfying AC-14.
- ⚠️ Forbids, in v1, any feature needing the network (maps, geocoding, model downloads, sharing, update
  checks) — each is a separately-gated future milestone (ROADMAP M2/M4/M5/M6).
- ⚠️ A user who moves/renames the library folder or in-place folder originals will see broken references
  until the library is re-pointed; the library-service must handle relocation gracefully (catalog is
  rebuildable from originals).
- 🟡 **Two accepted deferrals (explicitly in-scope of this sign-off):** (1) **no at-rest encryption** in
  v1 (rely on OS disk encryption + local-only; app-level key management deferred), and (2) **unsigned
  v1** binaries (one-time Gatekeeper/SmartScreen prompt; signing/notarization deferred — ADR-0007).
  Both are recorded here for the cofounder to accept with this ADR.
- 🚧 **Blocks F3 data-layer work until @pedrofuentes approves.**

---

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

---

### ADR-0006: Safe untrusted-archive extraction (yauzl) + stable ERR_ARCHIVE_* codes
**Date**: 2026-06-23
**Status**: Accepted
**Tier**: auto-with-audit (security-relevant module boundary + new error contract).

**Context**
Every v1 source except folders arrives as an **untrusted `.zip`** (WhatsApp, Takeout, Facebook,
LinkedIn). Naive extraction is vulnerable to **zip-slip / path traversal** (Snyk, 2018) and
**decompression bombs / symlink escapes**. AC-3 and AC-10 require safe extraction with **stable,
assertable error codes** surfaced as non-technical messages.

**Decision**
A single guarded extractor (`ingestion/safe-extract.ts`) using **`yauzl`** is the **only** way archives
are opened. On every entry, before writing: `validateFileName` (rejects `/`, `..`, `\`) + belt-and-
suspenders resolved-path `startsWith(destDir + sep)`; per-entry (≤500 MB), total (≤2 GB), ratio (≤100),
and entry-count (≤100 000) caps; `validateEntrySizes` + `strictFileNames`; **symlink rejection** via
Unix mode bits. Failures throw a typed `ArchiveError` with a **stable code** and a non-technical
`messageKey`:
`ERR_ARCHIVE_UNSAFE_PATH` (AC-3) · `ERR_ARCHIVE_BOMB` (AC-10) · `ERR_ARCHIVE_SYMLINK` (AC-10) ·
`ERR_ARCHIVE_CORRUPT`. Adversarial fixtures drive unit tests.

**Alternatives considered**
- *`adm-zip` / `unzipper`* — rejected; historically vulnerable to zip-slip and no built-in filename
  validation. `yauzl` was designed with zip-slip prevention as a first-class property.
- *Fold symlink into `ERR_ARCHIVE_BOMB`* (strict AC-10 literal) — a dedicated `ERR_ARCHIVE_SYMLINK` was
  chosen for clarity; AC-10's observable guarantees are met and not weakened. **Flagged for red-team**;
  trivially reversible to the literal if preferred.

**Consequences**
- ✅ AC-3/AC-10 satisfied with stable, testable codes; one auditable extraction path.
- ✅ Non-technical users see clear refusals (`ErrorBanner`, no raw codes).
- ⚠️ The numeric caps are policy defaults; if a legitimate huge export trips a cap, the cap is tuned in
  one place (documented), never by disabling the guard.

**Audit (2026-06-23, card C2 #9)**: implemented as `electron/main/importers/safe-extract.ts`; added
`yauzl@^3.4.0` (dependency, one transitive dep `pend`) + `@types/yauzl@^3.4.0` (devDependency). `pnpm
audit --prod` → no known vulnerabilities; no network/shell access in the module. Codes refined to a
dedicated `ERR_ARCHIVE_SYMLINK` as flagged above.

---

### ADR-0005: Electron security hardening + minimal contextBridge IPC surface
**Date**: 2026-06-23
**Status**: Accepted
**Tier**: auto (reversible config) — but the **zero-egress** portions may never be weakened (NEVER list).

**Context**
Electron apps that load untrusted-derived content need strict hardening. Kawsay also must expose
*some* capability to its renderer (import, browse, search, play media) without giving the renderer
ambient Node/fs/network authority. (MISSION §5/§7; AC-4.)

**Decision**
`contextIsolation: true`, `sandbox: true`, `nodeIntegration: false` (+ worker/subframe variants),
`webSecurity: true`. Block navigation (`will-navigate`) and `window.open` (`setWindowOpenHandler:
deny`). **Strict CSP** (`default-src 'none'; script-src 'self'; connect-src 'none'; img-src 'self'
kawsay-media: data: blob:; media-src 'self' kawsay-media: blob:; font-src 'self';
style-src 'self'; style-src-attr 'unsafe-inline'; …`). The renderer's **entire** capability is a
**minimal, enumerated `contextBridge` IPC surface** — one method per channel (no catch-all `send`),
each payload **zod-validated in preload AND re-validated in main**, with sender-origin checks. Local
media is served via a path-validated **`kawsay-media://`** custom protocol (no `file://` to the
renderer). Package-time: `@electron/fuses` + ASAR integrity (see ADR-0007).

**Alternatives considered**
- *Expose a generic `ipcRenderer.send`/`invoke` passthrough* — rejected; it is a catch-all that defeats
  the validated-surface model and widens attack surface.
- *Serve media as `file://` or marshal bytes over IPC* — rejected; `file://` over-grants the renderer
  and large media (video) marshaled over IPC is slow. A streaming custom protocol is safer and faster.
- *`style-src 'unsafe-inline'` (blanket)* — rejected in favor of the narrower `style-src-attr
  'unsafe-inline'` (needed only for the virtualizer's inline style attributes); stylesheets stay locked
  to `'self'`.

**Consequences**
- ✅ A sandboxed renderer with a tiny, typed, validated capability surface; supports the AC-4 guarantee.
- ✅ Media plays/streams locally with no `file://` exposure and no network.
- ⚠️ Every new renderer capability requires a new, explicitly-validated IPC channel — intentional
  friction that keeps the surface auditable.

---

### ADR-0004: Off-UI-thread ingestion (worker threads + ffmpeg/ffprobe subprocess)
**Date**: 2026-06-23
**Status**: Accepted
**Tier**: auto (internal performance architecture).

**Context**
Imports are heavy: parsing large chat logs / multi-GB `.mbox`, hashing every file (SHA-256), reading
EXIF, and generating thumbnails. Doing this on the Electron main thread would block the IPC loop and
freeze the UI. MISSION §7 mandates heavy ingestion off the UI thread; AC-8/AC-9 make it testable
(no main-thread task > 50 ms during import; ≥55 fps timeline at 10k items).

**Decision**
The **ingestion coordinator** (main) spawns **`worker_threads`** that run the selected `Importer`,
compute streaming SHA-256, read EXIF (`exifr`), and **write the catalog via `better-sqlite3` in the
worker**. **`ffprobe`/`ffmpeg` run as a subprocess** — ideally an Electron **`utilityProcess`** —
`spawn` with **array argv (never a shell string)**, with timeouts + output caps. Parses **stream**
(never buffer whole exports). Progress is posted to the renderer via throttled `import:progress`
events; records are persisted as found (first-memory payoff, SM-2). The renderer stays light:
**virtualized timeline** + **lazy media** over `kawsay-media://`. Thumbnails: `sharp` (images) +
`ffmpeg` (video posters); content-addressed so deduped items share one rendition.

**Alternatives considered**
- *Do ingestion on the main thread* — rejected; violates MISSION §7 and AC-9.
- *`fluent-ffmpeg`* — rejected (deprecated); call bundled `ffmpeg-static`/`ffprobe-static` directly.
- *Run ffmpeg via `exec` with a shell string* — rejected (shell-injection risk; ffmpeg CVE surface);
  `spawn` array argv only, local paths only (also closes the AC-4 subprocess gap).
- *Marshal media bytes to the renderer over IPC* — rejected for large media; stream via custom protocol.

**Consequences**
- ✅ Responsive UI during heavy imports; satisfies AC-8/AC-9; scales to ≥10k items.
- ✅ The riskiest parser (ffmpeg) is isolated in a sandboxed subprocess with resource limits.
- ⚠️ Worker-thread DB access + cross-thread progress add coordination complexity (cancellation via
  `AbortSignal`, scratch cleanup) — encapsulated in the coordinator/worker.

---

### ADR-0003: Local catalog — better-sqlite3 schema + migration runner + originals-on-disk + dedup-with-provenance
**Date**: 2026-06-23
**Status**: Accepted — **initial schema (001) is gated by ADR-0008 (HUMAN-REQUIRED) before F3 code.**
**Tier**: auto-with-audit (this ADR is the audit note for the data-model). DB-migration authoring is
itself HUMAN-REQUIRED (AGENTS Boundaries) → see ADR-0008.

**Context**
v1 needs a local index over memories from many sources, with browse/timeline + search, **originals
preserved on disk**, **capture-date vs import-date**, and **deduplication that preserves provenance**
(the same photo from two sources stored once but with both origins kept — PRD §5.6; AC-14/AC-15).

**Decision**
**`better-sqlite3`** (synchronous, fast, native; WAL + tuned pragmas). The schema's defining choice:
**`items` is the deduplicated logical memory; `item_occurrences` records every (item, source)
occurrence** — so dedup (by **SHA-256 `content_hash`**, UNIQUE; NULLs distinct for messages) stores
bytes once while preserving provenance from **all** sources. Generated renditions live in
**`item_assets`** (never the original). **FTS5** external-content virtual table (`items_fts`, kept in
sync by triggers, `unicode61` tokenizer) powers search; targeted indexes power timeline browse.
Refinements (post red-team):

- **Originals stored once, content-addressed + reference-counted.** Folder imports are **referenced in
  place**; archive originals are copied **once** to `originals/<hash[0:2]>/<hash>[.ext]` and
  **reference-counted by occurrence** (each occurrence's `original_kind` ∈ {`in_place`,
  `content_addressed`,`none`}). There is **no single `items.stored_path`** — a memory's original is
  resolved through a *surviving* occurrence, so undoing one source never dangles or double-stores a
  deduped memory (AC-14; ARCHITECTURE §4.4).
- **Stable source identity.** `sources.source_key` (archive SHA-256 / canonical folder real path),
  `UNIQUE`, is the source's identity — **not** the per-run UUID. Re-importing the same source **reuses**
  its row, so `UNIQUE(item_id, source_id, source_ref)` makes **re-import idempotent** while genuinely
  new files still add occurrences.
- **Race-free dedup.** The write path uses `INSERT … ON CONFLICT(content_hash) DO UPDATE … RETURNING id`
  (and `ON CONFLICT(item_id,source_id,source_ref) DO NOTHING` for occurrences). Imports are **serialized
  through a single ingestion worker** (single-writer); the upsert keeps it correct within a batch and if
  concurrency is ever added.
- **Canonical `capture_date`.** Every importer writes an **ISO-8601 UTC** instant (EXIF, with no tz, is
  read as UTC), so the timeline's lexicographic DESC sort is chronological.
- **Keyset timeline pagination.** A **composite `(capture_date DESC, id DESC)`** index + keyset cursor
  (`id` the UNIQUE tiebreaker; `NULLS LAST` for undated rows) — never `OFFSET` — so equal-timestamp rows
  are never skipped/duplicated and NULL-date items still appear (AC-6/AC-8).
- **Cross-source search after dedup.** When a new occurrence joins a deduped item, its
  sender/caption/filename tokens are merged (de-duplicated) into `items.search_meta` via `UPDATE`, so
  the `items_fts_au` trigger re-syncs FTS (AC-7).

A **hand-written, forward-only, transactional migration runner** (recorded in a `migrations` table) is
used over an ORM.

**Alternatives considered**
- *`source_id` directly on `items` (the research's first-cut schema)* — **rejected**: it cannot
  represent dedup-with-provenance (one item, many origins). The `item_occurrences` join is the
  deliberate correction.
- *Per-source original copies (`originals/<source-id>/…`) + one `items.stored_path`* — **rejected**:
  double-stores cross-source duplicates and **dangles** the original on undo of the owning source
  (ADR-0008). Replaced by content-addressed, occurrence-refcounted storage.
- *Key occurrence identity on the per-run source UUID* — **rejected**: makes re-import create duplicate
  occurrences. The stable `source_key` makes `UNIQUE(item_id,source_id,source_ref)` actually idempotent.
- *`OFFSET`/`LIMIT` timeline paging* — rejected: skips/duplicates rows under concurrent inserts and at
  equal timestamps; keyset cursor chosen.
- *An ORM with auto-migrations (Drizzle/Prisma/TypeORM)* — rejected for a single-user local app; a tiny
  hand-written runner is simpler, fully inspectable, and avoids a heavy dep.
- *Store EXIF/source metadata as opaque JSON only* — rejected for queryable fields (date, type, GPS);
  raw per-occurrence fields are still kept as JSON in `item_occurrences.source_meta` for provenance.
- *Hash with SHA-1/MD5 (as some catalogs do)* — chose **SHA-256** for collision resistance on sensitive
  irreplaceable data.

**Consequences**
- ✅ "Nothing is silently dropped" holds even under dedup; the `Sources` provenance view is faithful.
- ✅ Fast browse/search at 10k–100k items; catalog is rebuildable from originals on disk.
- ✅ Undo is data-level and **lossless even for deduped memories**: remove a source's occurrences, drop
  items whose last occurrence is gone, and delete a content-addressed blob only when its **last**
  occurrence is removed — never touching in-place originals or source archives (AC-14).
- ✅ Re-import is idempotent (stable `source_key`); the timeline is stable under concurrent inserts
  (keyset); cross-source search survives dedup (search_meta re-denormalization).
- ⚠️ Forward-only migrations: schema rollback isn't supported in v1 (data-level undo is). Schema changes
  are HUMAN-REQUIRED and audited here.
- ⚠️ Per-occurrence text differences are not separately full-text-indexed in v1 (FTS indexes item-level
  `search_meta`, now the de-duplicated union of all occurrences' tokens); acceptable since media dedup is
  byte-identical and messages are 1:1 with items.

---

### ADR-0002: Extensible connector (importer) interface
**Date**: 2026-06-23
**Status**: Accepted
**Tier**: auto-with-audit (new internal module boundary — the extensibility contract).

**Context**
v1 ships five sources and the roadmap (M3) keeps adding more. MISSION §3/§4 and AGENTS §Code Style
require **isolated connector modules behind a common importer interface** so new sources are cheap and
the rest of the system stays source-agnostic.

**Decision**
Define one **`Importer`** interface (`electron/main/importers/types.ts`): `canHandle()` +
`import(): AsyncGenerator<CatalogRecord, ImportResult>` over the lifecycle **discover → parse →
normalize → emit**. Importers **emit normalized `CatalogRecord`s** and **do not write the DB** — the
ingestion worker persists them (clean seam). Sources register in a `registry.ts` keyed by `SourceType`.
Dependencies (`fs`, guarded `extractArchive`, `readExif`, `probeMedia`, `hashFile`) are **injected via
`ImporterDeps`** so importers are **unit-testable with fixture fs + fakes** — no real files or
subprocess. Partial failures call `ctx.onSkip(...)` and continue (AC-15); provenance is carried on
every record (`sourceRef`, `author`, `date`, `sourceMeta`) → persisted as `item_occurrences`. The
**parse** phase streams large exports (the Gmail `.mbox` is split message-by-message — ADR-0013).

**Alternatives considered**
- *A bespoke function per source wired ad-hoc into the UI* — rejected; no shared contract, untestable,
  duplicates extraction/metadata logic, and makes new sources expensive.
- *Plugin processes / dynamic loading* — over-engineered for v1's in-repo connectors; a typed registry
  is enough. (Revisit if third-party connectors are ever desired.)
- *Importers write to the DB directly* — rejected; coupling importers to persistence defeats the DI
  testing seam and the "emit records" purity.

**Consequences**
- ✅ Adding a source = implement `Importer` + register + fixtures + one AC; no other layer changes.
- ✅ Importers are unit-testable in isolation against fixtures (AGENTS §Code Style "DI for importers").
- ✅ Uniform provenance + partial-failure handling across all sources.
- ⚠️ Per-source quirks (WhatsApp locale formats, Facebook mojibake, Takeout sidecars) live inside each
  module; the shared contract must stay minimal to avoid leaking source-specifics upward.

---

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
