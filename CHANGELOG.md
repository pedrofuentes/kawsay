# Changelog — Kawsay

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

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
