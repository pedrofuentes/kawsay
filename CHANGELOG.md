# Changelog — Kawsay

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Browse for the folder or file** instead of typing a path (card W2 / #93, **AC-12 usability**):
  onboarding's path fields — the library location and each import source — now offer an accessible
  **Browse…** button that opens the computer's own **folder or file picker** and fills the field with
  whatever you choose. Typing or pasting a path still works as a fallback, so nothing is taken away; the
  picker simply removes the biggest hurdle for non-technical users, who no longer have to know or spell out
  a filesystem path. The picker is wired through a new, **zod-validated** IPC capability
  (`dialog:openDirectory` / `dialog:openFile`) that runs the native dialog **entirely in the main process**
  and returns **only** the single absolute path the user picked (or nothing, on cancel) — the renderer
  gains this one typed `window.kawsayAPI.openDirectory()` / `openFile()` method and **no** new filesystem
  or Node access. For safety the renderer may influence only a dialog **title** and starting folder; every
  privileged option (file-vs-folder mode, filters, …) is fixed in the main process and **rejected** if a
  request tries to smuggle it across (strict option whitelist). No new dependencies (Electron's `dialog` is
  built in); the app stays **local-only** with zero network egress.
- Test-coverage measurement is now wired up and enforced (card #109). Running `pnpm coverage` measures the
  whole Vitest suite with the **v8** provider and prints a text table plus a browsable HTML report and a
  machine-readable `coverage-summary.json`, and the run now **fails** if statements, branches, functions or
  lines fall below the **80%** Definition-of-Done bar that AGENTS.md and the Sentinel checklist always
  specified but which was never enforceable without a provider installed. The current suite already clears
  it comfortably — **statements 94.64%, branches 84.35%, functions 95.57%, lines 94.64%** across 525 tests —
  so no behaviour changed; the gate simply pins that posture against regressions. Only the four process
  entry/bootstrap files that cannot run under the test runner (the Electron main entry, the preload bridge
  bootstrap, the ingestion worker entry, and the React root) are excluded; every piece of testable logic is
  measured. A new dev-only dependency, `@vitest/coverage-v8` — see ADR-0021. No runtime dependencies were
  added and the local-only / zero-egress posture is untouched.
- Search by **source** (card U2b, **completing AC-7**): the search filters gain the one way of
  narrowing that U2 could not yet offer. U2 shipped **type** and **date** as in-memory filters and noted
  that the catalogue's result tiles carried no source — so **source** could not be one of them. This closes
  that gap as a small **vertical slice**, repo → contract → UI. The catalogue's full-text search now takes
  an optional **source** filter (the connector a memory came from — WhatsApp · a folder · Google Takeout ·
  Facebook · LinkedIn), composed with the existing query and paging and a no-op when absent, so every prior
  caller is unaffected; each result tile now also carries its **source** (the connector of its first, earliest
  occurrence, chosen deterministically; null only for a deduped item whose every provenance has been undone).
  The IPC `CATALOG_SEARCH` request gains an optional, **zod-validated** `source`, and the item DTO a required,
  nullable `source` enum — both back-compatible. The **Search** view gains a calm **Source** select (_All
  sources_, then the shared source set) that narrows the matches **server-side** through `searchCatalog`,
  while type and date stay the in-memory filters they were; each result quietly shows where it came from. The
  source list reuses the app's shared `SOURCES` set rather than a divergent hardcoded copy. No new
  dependencies; the renderer still talks **only** through `window.kawsayAPI`, and untrusted catalogue data
  stays **escaped** React text.
- Accessibility pass across the whole app (card X2, AC-13 · WCAG 2.1 AA): a holistic, cross-screen audit
  and the fixes that only surface when the onboarding, timeline, search and app-shell screens are taken
  together. A **skip-to-content** link is now the first thing keyboard and switch users reach on every
  screen — hidden until focused, it jumps straight past the sidebar to the main content (WCAG 2.4.1).
  Landmarks are unique and complete app-wide: the sidebar is named distinctly from the in-app navigation so
  assistive tech never sees two "Sections" regions (WCAG 1.3.1). Moving between the lighter main views
  (add memories, settings) now moves focus to the new screen's heading, matching the timeline, search and
  onboarding steps, so the keyboard and screen-reader cursor is never stranded on a stale control
  (WCAG 2.4.3). When a library folder can't be created or opened, the gentle error is now tied to the path
  field itself (`aria-invalid` + `aria-describedby`), so it is announced the moment focus lands there
  (WCAG 3.3.1). And the last sub-AA item is closed: placeholder text in the path and search fields moves
  from `text-tertiary` (3.98:1) to `text-secondary` (7.77:1), bringing it to AA contrast (issue #104,
  WCAG 1.4.3). Every primary screen and state is now also swept through **axe-core** (WCAG 2.1 A/AA) in the
  test suite as a standing regression ratchet — a new dev-only dependency, see ADR-0020. No runtime
  dependencies were added and the renderer still talks **only** through `window.kawsayAPI`.
- Search across the library (card U2, AC-6 · AC-7): a calm way to find one memory by a few plain words.
  The renderer's `search` section is now a working **Search** view — a labelled search box whose query is
  **debounced** before it reaches `searchCatalog` (so the catalogue is queried once for the final words, not
  on every keystroke), with **filters** to narrow the matches by **media type** (photos · videos · voice
  notes · documents · messages) and a **date range** (the IPC search contract exposes no server-side filters
  and its result tiles carry `mediaType` + `captureDate` but no source, so type and date are what we narrow
  on, in memory). Results show a caption (title, falling back to the description), a readable date, and a
  type label, with the matched words gently **highlighted**. Every state is handled without a cold or
  alarming screen: a warm **starting prompt** before any query, a reassuring **nothing-found** state that
  names the term, a **no-match-for-these-filters** state that points back to the filters, an unobtrusive
  **searching** status that keeps the previous results on screen, and a gentle **error** with a single
  **Try again** (never a raw `SQLITE`/`fts5` code). Everything the catalogue returns is untrusted data (a
  loved one's words, captions, filenames) and is rendered as **escaped React text** — the highlight is built
  from plain string slices wrapped in `<mark>`, never `dangerouslySetInnerHTML` — so a caption like
  `<script>…` can never become a live element, preserving the F1 / zero-egress (AC-4) posture. The view is
  **WCAG 2.1 AA**: a `search` landmark, a labelled search box, the filters grouped under accessible labels
  with `aria-pressed` chips, a polite **status live region** announcing the result count, focus moved to the
  heading on entry, visible focus, and AA contrast. No new dependencies (the debounce is a few lines); the
  renderer talks **only** through `window.kawsayAPI` and tolerates its absence in a browser preview.
- Browse / timeline view (card U1, AC-6 + AC-8): the main app's home is now a real, living **timeline** of
  everything gathered — a grieving person opens the app and sees their loved one's memories laid out
  **newest first**, gently grouped under **month-and-year** headers, with a quiet sticky label so they
  always know where they are as they scroll (AC-6). The list is **virtualized**: only the handful of cards
  in view are ever in the page, so a library of **tens of thousands** of memories scrolls smoothly and stays
  light (AC-8); further pages stream in **as you reach them** through the timeline cursor, never all at once.
  Each memory is a labelled card showing its caption, its date, its kind (photo · video · voice note ·
  document · message) and, for clips, a length — read entirely through `window.kawsayAPI.getTimeline`, with
  **no network** (AC-4). Because the renderer-facing item shape carries **no file path or asset URL** (a
  deliberate sandbox boundary), each card shows a calm per-type **icon** rather than loading original bytes;
  the bounded, on-demand mounting is what makes the view lazy. The empty library is met with a warm
  invitation to **add memories** (not a blank wall), and the loading, error, and not-connected states are
  all plain-language and reassuring — never a raw error code, never a bare spinner. Untrusted captions and
  filenames are rendered as **escaped text**, never markup. The screen is keyboard-operable with a focusable
  page heading, a named memories region, real list/heading semantics, visible focus, and no autoplaying
  media (WCAG 2.1 AA, AC-13). No new runtime dependency — the windowing is hand-rolled.
- Router exhaustiveness guard (issue #95, fixing an ADR-0015 gap from U3): `MainApp`'s view switch no longer
  collapses `timeline` into a `default:` fall-through. It now has an explicit `case 'timeline'` and a
  `default: return assertNever(view)`, so adding a future screen to the `View` union without handling it is
  a **compile error** instead of silently rendering the timeline.
- First-run onboarding & the shared renderer foundation (card U3, AC-12): the renderer is no longer a
  placeholder. A grieving, non-technical person is now walked — one calm screen at a time — from a warm
  **welcome**, through naming the person they are honoring, choosing where the **library** lives on this
  computer (**create** a new one or **open** an existing one via `createLibrary` / `openLibrary`), picking
  a **source** (WhatsApp · a folder of photos · Google Takeout · Facebook · LinkedIn), a gentle
  **"how to export"** walkthrough for that source, locating the saved file, and a live **import** with a
  percent-done bar, a running tally ("84 of 200 so far"), plain-language activity text, and a
  **Stop for now** affordance (`startImport` / `onImportProgress` / `cancelImport`) — ending on a reverent
  completion screen ("They're here — 347 memories are now in [Name]'s library") that routes into the main
  app. Every step reassures that **memories never leave this computer**; partial failures are surfaced
  gently ("We couldn't read 1 item — every other memory came through, and nothing was lost", AC-15) and the
  cancelled and error paths are handled without ever showing a raw error code. Focus moves to each step's
  heading, the flow is fully keyboard-operable with a visible **3px** focus ring, and all motion collapses
  under `prefers-reduced-motion`. Untrusted export text (a loved one's names and messages) is rendered as
  escaped data, never markup. This card also establishes the **shared renderer foundation** that the
  timeline (U1) and search (U2) cards build on: a dependency-free typed **view-state router**
  (`NavigationProvider` / `useNavigation`), typed **IPC hooks** over `window.kawsayAPI` that tolerate its
  absence in a browser preview (`KawsayApiProvider` / `useKawsayApi`, `useLibrary`, `useImport`), a
  **`LibraryProvider`** holding the open library plus create/open actions, an **`AppShell`** + sidebar /
  status-bar shell, and a small **token-only component set** (Button, SourceCard, StepIndicator,
  ProgressBar, EmptyState, ErrorBanner, PrivacyBadge, PathField, …). The renderer talks **only** through
  `window.kawsayAPI` — no network — preserving zero-egress (AC-4) and the F1 security posture.
- Importer registry wiring (card W1): the **Google Takeout**, **Facebook**, and **LinkedIn** connectors
  are now registered, so an import started from the app (`import:start`) actually **reaches** them — both
  by auto-detection (the registry returns the first connector whose cheap `canHandle` accepts the dropped
  path) and by explicit source type. The list is ordered **most-specific first** so the right connector
  always wins: WhatsApp, then Facebook and LinkedIn (which claim only on their named export markers), then
  Google Takeout, with the generic **folder** importer **last** as the catch-all — it claims *any*
  directory, so placed earlier it would shadow a Takeout/Facebook/LinkedIn/WhatsApp folder and silently
  ingest it as a plain photo folder. No new dependencies; no connector behaviour changed.
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
  `facebookImporter` / `linkedinImporter`; wired into the importer registry in card W1.)_
- Google Takeout importer (card C4, AC-11): the connector for a **Google Takeout** export — it brings your
  **Gmail mailbox** and **Google Photos** library into the catalogue. Point it at the export folder, the
  original **`.zip`** (unpacked through the zip-slip–guarded extractor, never a raw unzip), or a standalone
  **`.mbox`**. The Gmail mailbox is streamed **a message at a time** — whether it comes from the **`.zip`**
  (the format Google Takeout downloads in), an unpacked folder, or a standalone file — so even a
  multi-gigabyte mailbox is never loaded into memory at once: each email keeps its **date, sender, subject,
  and text** (so the words are searchable), quoted lines that begin with "From" are restored correctly
  rather than splitting a message in
  two, and every **attachment becomes its own photo/video/file** saved alongside the rest. For Google Photos,
  each picture or clip is paired with the little **`.json` metadata file** Takeout writes next to it to
  recover the real **date taken, location, and description**, falling back to the file's own EXIF and then its
  timestamp when that metadata is missing — and the pairing tolerates the ways Takeout mangles long or
  duplicated filenames (`name(1).jpg` ↔ `name.jpg(1).json`, truncated names), so a photo is never dropped or
  matched to the wrong sidecar. A garbled email, a corrupt metadata file, an unreadable file, or a damaged
  archive is skipped and reported rather than aborting the import, which can also be cancelled while it runs.
- IPC surface and off-thread ingestion harness (card F3c, AC-9): the renderer-facing bridge over the
  F3b engine and the worker that runs it off the UI thread. Seven channels are exposed through the F1
  `contextBridge` as a **typed `window.kawsayAPI`** — `library:create`, `library:open`,
  `catalog:timeline`, `catalog:search`, `import:start`, `import:cancel`, and a one-way
  `import:progress` event stream — never raw `ipcRenderer`. Every payload is **zod-validated on both
  sides** of the boundary (`z.strictObject`, so unknown keys are rejected): the preload re-validates
  each request before it leaves the renderer and each event on receipt, and the main process
  re-validates every request and **drops** any malformed event before it can reach React, so a bug or a
  hostile payload can never push an unexpected shape across the bridge. The renderer only ever receives
  **DTOs** — a `LibrarySummary` without the on-disk catalog path, item cards without content hashes or
  filesystem paths — and the timeline cursor is an opaque token decoded and validated in main. Heavy
  imports run in a **`worker_threads` worker** (the thread-agnostic F3b orchestrator, unchanged): a
  coordinator forks one worker per job, **streams progress** (phase, counts, current item) back over
  `import:progress`, and supports **cooperative cancel** — `import:cancel` aborts the worker's
  `AbortSignal`, the orchestrator stops at the next record boundary and returns a **partial summary**
  with `cancelled: true` (no throw, honouring AC-15). Workers are torn down on completion, on cancel,
  and on window-close/quit, so none is ever orphaned. Adds an ordered **importer registry**
  (`selectImporter` picks the first connector whose `canHandle` matches) and the
  TS types the renderer cards (U1–U3) import. No new dependencies; the F1 security model
  (contextIsolation, nodeIntegration off, CSP, navigation guards, AC-4 zero-egress) is unchanged.
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

- Importing is now crash-proof. If the background worker that reads your files hits a fault that even
  its own error handling cannot catch — a corrupt file that crashes a native decoder, an
  out-of-memory condition, or an unexpected shutdown — the app no longer crashes and the import no
  longer spins forever. That one import stops with a clear error, every other import keeps going, and
  the worker is always cleaned up so nothing is left running in the background (AC-9).
- WhatsApp importer no longer mistakes an ordinary message that happens to end in a parenthetical
  (for example "the price is 3.50 (each)" or "send report.pdf (draft)") for a missing attachment and
  silently drops it — a loved one's words are always kept. Attachments are now recognised only by
  WhatsApp's real markers: the Android `FILENAME (file attached)` sentinel (and its common localised
  equivalents) and the iOS `<attached: FILENAME>` form.
- WhatsApp importer now treats a corrupt, locked, or unreadable export — a `.zip` that cannot be
  extracted, or a discovered `_chat.txt` that cannot be read — as a reported skip and finishes with
  whatever it has already gathered, instead of throwing and aborting the whole import (AC-15).
- Google Takeout importer no longer lets a single unreadable Gmail mailbox abort the whole import. If
  setting up the streaming reader for an `.mbox` faults, that one mailbox is now reported as a skipped
  item and the run keeps going — every other email, attachment and photo in the export is still brought
  in — and the reader is always closed afterwards so nothing is left open in the background. Previously
  such a fault could escape and stop the entire import, losing everything else it would have gathered
  (AC-15).

### Security

- Cleared every open dev-dependency security alert ahead of the M1 sign-off (DoD §4, card #31): 14
  Dependabot alerts — 8 high + 6 medium — across **vite**, **esbuild** and **tar**. All were
  **development / build-scope only**: none reaches the shipped Electron bundle, which loads built static
  files and the native better-sqlite3 binary with no dev server, so `pnpm audit --prod` was — and stays —
  clean. The vite dev-server advisories have no Vite-5 backport, so **Vite** moves `5.4 → 6.4.3` (its first
  patched release, within every tool's supported range — the pinned `electron-vite@4` toolchain is
  unchanged), and `pnpm.overrides` now pin the two transitive offenders to patched releases: **esbuild**
  `≥ 0.25.0` (dev server cross-site request acceptance) and **tar** `≥ 7.5.16` (the `@electron/rebuild`
  native-rebuild header-extraction chain). No runtime dependency changed and the full toolchain
  (`install`, `typecheck`, `lint`, 506 tests, `build`) stays green. See ADR-0017.
- The bundled video tools (ffmpeg/ffprobe) are now locked to reading local files only. Even if a
  crafted photo or video on disk embedded a hidden reference to a remote address, these tools can no
  longer be tricked into reaching out over the network, preserving Kawsay's promise that your
  memories never leave your device (AC-4). Any input that is not a local file is refused before the
  tool is ever run.

### Removed
