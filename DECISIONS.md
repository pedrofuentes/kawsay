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
   ├── originals/<source-id>/…          COPIES of archive-extracted originals only
   ├── derived/{thumbnails,posters,waveforms}/…   Kawsay-generated, rebuildable
   ├── extract/<source-id>/…            transient extraction scratch (deleted after each import)
   └── logs/
   ```
   - **Folder imports are referenced in place** — the user's photos/videos are **never copied or
     moved**; the catalog stores their absolute path. (AC-14.)
   - **Archive imports** (WhatsApp/Takeout/Facebook/LinkedIn `.zip`) are copied into
     `originals/<source-id>/`; the **source `.zip` is never altered or deleted**.
   - **App config** (window size, last-opened library path, accessibility prefs) lives separately in
     Electron `userData` — **never** user memory content.

2. **What is stored.** In `catalog.sqlite3`: per-item media type, MIME, **SHA-256 content hash** (dedup
   key), the on-disk path of the original, **capture date vs import date**, EXIF (incl. **GPS
   coordinates — catalogued locally only; never sent to any online map/geocoder**), message/caption
   text, and per-source **provenance** (`item_occurrences`). Generated thumbnails/posters live in
   `derived/`. Nothing else; **no account, no identifiers, no telemetry**.

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
   proven automatically**: (a) **Vitest + `nock.disableNetConnect()` + a `net.createConnection` spy**
   over every importer; (b) **Playwright `page.route`** over the full app (import + browse + search)
   asserting **zero** outbound requests; (c) **CI OS-level firewall** during the e2e run to catch any
   subprocess egress. Any PR touching the network guard, CSP, or AC-4 tests is **harness-integrity →
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
- ✅ The zero-egress promise is both designed-in and continuously tested, satisfying MISSION §5 and AC-4.
- ⚠️ Forbids, in v1, any feature needing the network (maps, geocoding, model downloads, sharing, update
  checks) — each is a separately-gated future milestone (ROADMAP M2/M4/M5/M6).
- ⚠️ A user who moves/renames the library folder or in-place folder originals will see broken references
  until the library is re-pointed; the library-service must handle relocation gracefully (catalog is
  rebuildable from originals).
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
(`x64`; `arm64` cross-compiled). Publish to **GitHub Releases** (`provider: github`, `--publish
always`, `GH_TOKEN`). Rebuild native modules for Electron's ABI (`npmRebuild: true`,
`buildDependenciesFromSource: true`) and **`asarUnpack`** `better-sqlite3` + `ffmpeg-static` +
`ffprobe-static` (a `.node`/binary can't load from inside asar). **CI matrix on per-arch native
runners** (`macos-14` arm64, `macos-13` x64, `windows-latest` x64) — native modules can't be
cross-compiled; pin **Node 22** + **Python 3.11** (node-gyp needs `distutils`). Flip `@electron/fuses` +
ASAR integrity at package time. **Ship unsigned in v1** (`mac.identity: null`; NSIS unsigned) — one-time
Gatekeeper/SmartScreen prompt; signing/notarization deferred (MISSION §2). The **first production
publish of each release runs in a protected GitHub Environment with required reviewers** (@pedrofuentes).

**Alternatives considered**
- *Electron Forge* — equally viable; `electron-builder` chosen for its first-class multi-target
  GitHub-Releases publish and the directly-applicable `octomux` reference (`better-sqlite3` + multi-arch).
- *Universal macOS binary* — deferred; per-arch `.dmg`s are simpler to build on native runners.
- *`fluent-ffmpeg`* — rejected (deprecated/read-only 2024); call bundled binaries via `spawn` directly.

**Consequences**
- ✅ Reproducible installers for both OSes, published automatically on tag; satisfies AC-5.
- ✅ Native module + ffmpeg binaries load correctly in the packaged app.
- ⚠️ Unsigned v1 means a one-time "unidentified developer" prompt — acceptable for a known-family v1.
- ⚠️ Windows arm64 is cross-compiled (no hosted arm64 runner) and must be smoke-tested explicitly.
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
Originals: **folder imports referenced in place** (never copied/moved); **archive contents copied** into
the library's `originals/`; the catalog + originals + derived live in a **user-chosen, portable library
folder** (location specifics in ADR-0008). A **hand-written, forward-only, transactional migration
runner** (recorded in a `migrations` table) is used over an ORM.

**Alternatives considered**
- *`source_id` directly on `items` (the research's first-cut schema)* — **rejected**: it cannot
  represent dedup-with-provenance (one item, many origins). The `item_occurrences` join is the
  deliberate correction.
- *An ORM with auto-migrations (Drizzle/Prisma/TypeORM)* — rejected for a single-user local app; a tiny
  hand-written runner is simpler, fully inspectable, and avoids a heavy dep.
- *Store EXIF/source metadata as opaque JSON only* — rejected for queryable fields (date, type, GPS);
  raw per-occurrence fields are still kept as JSON in `item_occurrences.source_meta` for provenance.
- *Hash with SHA-1/MD5 (as some catalogs do)* — chose **SHA-256** for collision resistance on sensitive
  irreplaceable data.

**Consequences**
- ✅ "Nothing is silently dropped" holds even under dedup; the `Sources` provenance view is faithful.
- ✅ Fast browse/search at 10k–100k items; catalog is rebuildable from originals on disk.
- ✅ Undo is data-level (remove a source's occurrences; drop items whose last occurrence is gone)
  without touching in-place originals or source archives (AC-14).
- ⚠️ Forward-only migrations: schema rollback isn't supported in v1 (data-level undo is). Schema changes
  are HUMAN-REQUIRED and audited here.
- ⚠️ Per-occurrence text differences are not separately full-text-indexed in v1 (FTS indexes item-level
  `search_meta`); acceptable since media dedup is byte-identical and messages are 1:1 with items.

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
every record (`sourceRef`, `author`, `date`, `sourceMeta`) → persisted as `item_occurrences`.

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
