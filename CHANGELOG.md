# Changelog — Kawsay

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Facebook & LinkedIn importers (card C5, AC-16): two more connectors that bring a person's social
  history into the catalogue, each opened from its export **`.zip`** through the zip-slip–guarded
  extractor (never a raw unzip) or from a folder you already extracted. **Facebook "Download Your
  Information"** reads the JSON export — your **posts, message threads, and photo albums** — and fixes
  the notorious Facebook **mojibake**: the export escapes every character as raw UTF-8 bytes, so a naive
  read turns "José" into "JosÃ©" and an emoji into garble; the importer re-decodes the text so names and
  messages are **faithful**, which matters when the archive is a memorial. Post and photo timestamps
  (Unix seconds) and message timestamps (milliseconds) are read correctly as UTC, each photo/video is
  linked to its exported file (a reference can only ever point inside the extract, never out via a
  crafted path), and **nothing is silently dropped** — a text post and its photo are kept as separate
  memories and a contentless message is still catalogued. **LinkedIn** reads the CSV export —
  **messages, connections, and shared media links** — through a dependency-free RFC 4180 reader, so a
  quoted comma, an embedded newline, a UTF-8 BOM, or the free-text `Notes:` preamble can never truncate
  a message or smear it across rows; column headers are matched across export versions and the varied
  LinkedIn date formats are read as UTC, with an unrecognized date keeping the row rather than dropping
  it. For both, a corrupt archive, an unreadable or malformed file, or a missing media file is **skipped
  and reported** rather than aborting (AC-15), an out-of-range or garbage timestamp keeps the record with
  no date instead of crashing the import, and a running import can be cancelled. _(Exported as
  `facebookImporter` / `linkedinImporter`; wiring them into the importer registry is a follow-up.)_
- WhatsApp "Export Chat" importer (card C3, AC-1): the flagship messaging connector — brings a
  conversation's **text messages, photos, voice notes, audio, video, and documents** into the
  catalogue end-to-end. Point it at the exported **`.zip`** (unpacked through the zip-slip–guarded
  extractor, never a raw unzip) or a folder you already extracted. It reads the `_chat.txt` log
  across both the **iOS** (`[30/12/2023, 14:30:00] Sender:`) and **Android**
  (`30/12/2023, 14:30 - Sender:`) layouts, 12- and 24-hour clocks, and the day/month/year order of
  different regions, stitching multi-line messages back together. Each attachment is matched to its
  media file and classified — a `.opus`/`.m4a` **voice note becomes audio** with its duration read
  from the file — while every message keeps its sender, timestamp, and text (so the words are
  searchable). System notices (the end-to-end-encryption banner, group events) are preserved and
  flagged, "media omitted" placeholders are kept as notes, and a missing attachment or an
  unparseable line is skipped and reported rather than aborting the import, which can also be
  cancelled while it runs.
- Ingestion engine (card F3b): the concrete, sandboxed `ImporterDeps` wrappers and the off-UI-thread
  **ingestion orchestrator** that turn an `Importer`'s `CatalogRecord` stream into catalogued memories.
  Wrappers: a streaming **SHA-256** `FileHasher` (lowercase hex), an **`exifr`** `ExifReader` (capture
  date/GPS/camera; a malformed header is a skip, never a crash; EXIF read as UTC), a bounded
  **`ffprobe-static`** `MediaProber` (duration/dimensions; a ffprobe stuck on a crafted/truncated file is
  killed on a timeout and degrades to all-null), and an **`ffmpeg-static`** thumbnail/poster
  generator writing WebP renditions into the library `derived/` tree — ffmpeg/ffprobe run as subprocesses
  fed only local paths (array argv, no shell). The filesystem wrapper resolves entries with `lstat`, so a
  symlink reports as neither file nor directory and the folder walk never follows it out of the chosen
  root or around a cycle. The orchestrator drains the importer record-by-record
  (streaming, back-pressured, cancellable via `AbortSignal`) and, per record, writes the catalog
  transactionally: **dedup-with-provenance** (`insertItem` by `content_hash` + `addOccurrence`), retaining
  originals **in place** for folder sources and **content-addressed** (`putOriginal`) for archives,
  generating a thumbnail/poster (`addAsset`), merging cross-source search tokens, throttling progress, and
  collecting skipped items (AC-15) — a hash, retention, or rendition failure skips just that record and
  never aborts the run. _(The IPC channels — `library:create/open`,
  `catalog:timeline/search`, `import:start/cancel/progress` — and the worker/`utilityProcess` harness that
  runs the orchestrator off-thread are deferred to follow-up card F3c to keep this PR reviewable; the
  orchestrator is written thread-agnostic so that harness runs it unchanged.)_
- Guarded archive extraction (card C2): a single zip-slip-safe `yauzl` extractor
  (`electron/main/importers/safe-extract.ts`) that is the **only** sanctioned way to open an untrusted
  export `.zip` (WhatsApp, Google Takeout, Facebook, LinkedIn) — never a raw unzip. It is
  deny-by-default on every entry before any byte is written: path-traversal / absolute / drive-letter /
  backslash / NUL names and resolved-path escapes are rejected (`ERR_ARCHIVE_UNSAFE_PATH`), symlink
  entries are refused and never materialized (`ERR_ARCHIVE_SYMLINK`), and decompression bombs are
  capped by per-entry size, total size, compression ratio, and entry count (`ERR_ARCHIVE_BOMB`);
  unreadable archives surface as `ERR_ARCHIVE_CORRUPT`. Each failure is a typed `ArchiveError` carrying
  a stable code and a non-technical message key. Entries are streamed one at a time (the whole archive
  is never buffered). Implements the `SafeExtractFn` importer seam (ARCHITECTURE §7.1, ADR-0006).
- Folder importer (card C1, AC-2): the first concrete connector — imports photos, videos, voice
  notes, and documents from **any folder**, including the local mirrors that iCloud / OneDrive /
  Dropbox / Google-Drive clients download. It walks the directory recursively, classifies each file
  by type, and catalogues it **in place** (the user's own files are referenced, never copied). Each
  memory's date prefers the photo's embedded EXIF capture date and falls back to the file's modified
  time (recording which was used), with GPS location and camera make/model carried through when
  present and audio/video durations read from the media itself. Unreadable files or folders are
  skipped and reported rather than aborting the whole import, and a running import can be cancelled.
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

- WhatsApp importer no longer mistakes an ordinary message that happens to end in a parenthetical
  (for example "the price is 3.50 (each)" or "send report.pdf (draft)") for a missing attachment and
  silently drops it — a loved one's words are always kept. Attachments are now recognised only by
  WhatsApp's real markers: the Android `FILENAME (file attached)` sentinel (and its common localised
  equivalents) and the iOS `<attached: FILENAME>` form.
- WhatsApp importer now treats a corrupt, locked, or unreadable export — a `.zip` that cannot be
  extracted, or a discovered `_chat.txt` that cannot be read — as a reported skip and finishes with
  whatever it has already gathered, instead of throwing and aborting the whole import (AC-15).

### Removed
