# Changelog — Kawsay

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Ingestion engine (card F3b): the concrete, sandboxed `ImporterDeps` wrappers and the off-UI-thread
  **ingestion orchestrator** that turn an `Importer`'s `CatalogRecord` stream into catalogued memories.
  Wrappers: a streaming **SHA-256** `FileHasher` (lowercase hex), an **`exifr`** `ExifReader` (capture
  date/GPS/camera; a malformed header is a skip, never a crash; EXIF read as UTC), a **`fluent-ffmpeg` +
  `ffprobe-static`** `MediaProber` (duration/dimensions), and an **`ffmpeg-static`** thumbnail/poster
  generator writing WebP renditions into the library `derived/` tree — ffmpeg/ffprobe run as subprocesses
  fed only local paths (array argv, no shell). The orchestrator drains the importer record-by-record
  (streaming, back-pressured, cancellable via `AbortSignal`) and, per record, writes the catalog
  transactionally: **dedup-with-provenance** (`insertItem` by `content_hash` + `addOccurrence`), retaining
  originals **in place** for folder sources and **content-addressed** (`putOriginal`) for archives,
  generating a thumbnail/poster (`addAsset`), merging cross-source search tokens, throttling progress, and
  collecting skipped items (AC-15) without aborting the run. _(The IPC channels — `library:create/open`,
  `catalog:timeline/search`, `import:start/cancel/progress` — and the worker/`utilityProcess` harness that
  runs the orchestrator off-thread are deferred to follow-up card F3c to keep this PR reviewable; the
  orchestrator is written thread-agnostic so that harness runs it unchanged.)_
- Local library core (card F3): the main-process catalog over **`better-sqlite3`**. A versioned,
  transactional, idempotent migration runner (`user_version`-gated) applies the ARCHITECTURE §4 schema —
  `items` (SHA-256 `content_hash` dedup key), `item_occurrences` (provenance), `item_assets`, `sources`,
  `collections`, and an FTS5 external-content index with sync triggers. A single-writer catalog
  data-access layer implements **dedup-with-provenance** (`INSERT … ON CONFLICT … RETURNING`),
  cross-source `search_meta` token merging, a composite **keyset timeline** (`capture_date DESC, id DESC`,
  NULLS LAST), and FTS5 search with hardened input. A **content-addressed originals store**
  (`originals/<hash[0:2]>/<hash>`) stores each original once and **reference-counts it by occurrence** —
  deleting a blob only when its last `content_addressed` occurrence is removed and never touching
  in-place folder originals (AC-14). The connector **`Importer` interface** (DI-friendly, unit-testable)
  and the library lifecycle (create/open the self-contained ADR-0008 folder layout with a `library.json`
  manifest). Dev tooling: **`@electron/rebuild`** + a `rebuild:native` script for the Electron-ABI
  native rebuild. _(The IPC channels for these — `library:create/open`, `catalog:timeline/search` — are
  deferred to a follow-up card F3b to keep this PR reviewable.)_
- Application shell (card F1): Electron + React 18 + Vite 5 + Tailwind CSS v4 + TypeScript (strict)
  scaffold built with `electron-vite`. Hardened `BrowserWindow` (`contextIsolation`, `sandbox`,
  `nodeIntegration: false`), a zod-validated `contextBridge` `invoke` bridge with the `app:getVersion`
  channel wired end-to-end, a strict header-based Content-Security-Policy, navigation hardening, and an
  Electron fuse configuration. Design tokens from USER_FLOWS §5 (calm palette, type scale, spacing,
  radii, motion) with **Lora + Inter bundled locally** (no remote fonts/CDN), and a welcome renderer
  screen that displays the app version through the secure bridge. Tooling: ESLint (typescript-eslint
  strict + react + jsx-a11y, zero warnings), Prettier, Vitest, Playwright config skeleton, and an
  electron-builder config skeleton (mac `dmg` / win `nsis`).

### Changed

### Fixed

### Removed
