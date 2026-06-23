# Architecture — Kawsay

> **Phase-3 gate artifact.** The system blueprint engineers implement against. Subordinate to
> [`MISSION.md`](../MISSION.md) (binding spec); elaborates [`PRD.md`](../PRD.md) (AC-1…AC-16, NFRs) and
> [`USER_FLOWS.md`](../USER_FLOWS.md) (journeys, components, tokens). Decisions are recorded as ADRs in
> [`DECISIONS.md`](../DECISIONS.md); this document is the *how*, the ADRs are the *why*.
>
> **Authored by:** Architecture sub-agent. **Status:** proposed — awaiting independent red-team. The
> data layer (schema/migrations) and the privacy/zero-egress invariant are gated by
> **ADR-0008 (HUMAN-REQUIRED sign-off, @pedrofuentes)** before F3 code is written.

---

## 0. Guiding invariants (non-negotiable)

Every structural choice below serves these. They may never be weakened (MISSION §5/§7, AGENTS NEVER):

1. **Local-only / zero network egress** — no user memory data ever leaves the device; no telemetry; no
   remote assets. Enforced at runtime *and* proven by an automated test (**AC-4**). See §6.
2. **Originals are sacred** — never moved, altered, or deleted; the catalog is rebuildable from
   originals on disk; every import is undoable (**AC-14**).
3. **Nothing is silently dropped** — partial failures are surfaced with counts; dedup preserves
   provenance from *every* source (**AC-15**, PRD §5.6). See §4.
4. **Untrusted input is hostile** — all archives are zip-slip / bomb / symlink guarded; media parsing
   is isolated and resource-capped (**AC-3, AC-10**). See §7.
5. **Heavy work is off the UI thread** — ingestion runs in workers + subprocesses; the renderer stays
   responsive (no main-thread task > 50 ms during import) (**AC-8, AC-9**). See §5.
6. **The renderer is sandboxed** — `contextIsolation`, `sandbox`, `nodeIntegration: false`; the only
   bridge is a minimal, zod-validated `contextBridge` IPC surface (**AC-4** hardening). See §2.

---

## 1. Process & module structure

### 1.1 The three Electron processes

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ RENDERER  (Chromium, sandboxed: contextIsolation+sandbox, nodeIntegration=off) │
│   React 18 + Vite + Tailwind v4.  Pure UI — no Node, no fs, no DB, no network.  │
│   Talks to the system ONLY through window.kawsayAPI (preload).                  │
└───────────────▲──────────────────────────────────────────────────────────────┘
                │  window.kawsayAPI.*  (typed, zod-validated)
┌───────────────┴──────────────────────────────────────────────────────────────┐
│ PRELOAD  (isolated world; the ONLY bridge)                                     │
│   contextBridge.exposeInMainWorld('kawsayAPI', …) — one method per IPC channel, │
│   each validating its payload with zod before ipcRenderer.invoke / subscribe.   │
└───────────────▲──────────────────────────────────────────────────────────────┘
                │  ipcRenderer.invoke('channel', payload)  ⇄  ipcMain.handle
┌───────────────┴──────────────────────────────────────────────────────────────┐
│ MAIN  (Node 20+, full privilege — owns ALL fs / DB / subprocess / security)    │
│   • Security: network-guard, CSP, window-hardening, kawsay-media:// protocol    │
│   • IPC handlers (re-validate every payload with zod; check sender origin)      │
│   • Library service (open/create/switch/undo; on-disk layout)                   │
│   • Catalog repo + FTS5 search  (better-sqlite3, main thread reads)             │
│   • Ingestion coordinator → spawns workers                                      │
│        └─ Worker thread(s): importers, exifr, sha-256, DB writes                │
│              └─ Subprocess: ffprobe/ffmpeg (utilityProcess, no shell)           │
└────────────────────────────────────────────────────────────────────────────────┘
```

- **Renderer** never touches `fs`, `net`, `better-sqlite3`, or `child_process`. All capability is
  brokered by IPC. This is what makes the sandbox + zero-egress claims credible.
- **Main** is the trust boundary and the only place with ambient authority.
- **Workers / subprocess** carry the CPU- and parser-heavy work so the main thread (and therefore the
  IPC loop and the UI) never stalls.

### 1.2 Repository layout

Built with **`electron-vite`** (one config drives the main / preload / renderer triple build; HMR for
the renderer; ESM throughout). Module system is **ESM**; package manager **pnpm**; TypeScript **strict**.

```
kawsay/
├── electron/
│   ├── main/
│   │   ├── index.ts                 # app lifecycle, BrowserWindow, installs all guards FIRST
│   │   ├── security/
│   │   │   ├── network-guard.ts     # session.webRequest.onBeforeRequest egress kill-switch (AC-4)
│   │   │   ├── csp.ts               # onHeadersReceived → strict CSP (AC-4)
│   │   │   ├── window-hardening.ts  # webPreferences, will-navigate, setWindowOpenHandler
│   │   │   └── media-protocol.ts    # kawsay-media:// handler — path-validated local file serving
│   │   ├── ipc/
│   │   │   ├── register.ts          # registerAllHandlers(window, services)
│   │   │   ├── schemas.ts           # zod payload schemas (shared by preload + main)
│   │   │   └── handlers/            # library.ts · import.ts · catalog.ts · settings.ts · dialog.ts
│   │   ├── db/
│   │   │   ├── connection.ts        # open DB + pragmas (WAL, foreign_keys, …)
│   │   │   ├── migrate.ts           # hand-written forward-only migration runner
│   │   │   ├── migrations/001_initial.sql
│   │   │   ├── catalog-repo.ts      # items / item_occurrences / sources (dedup-with-provenance)
│   │   │   └── search.ts            # FTS5 query builder (AC-7)
│   │   ├── ingestion/
│   │   │   ├── coordinator.ts       # orchestrates workers, relays progress, tallies skips (AC-9/15)
│   │   │   ├── safe-extract.ts      # yauzl guarded extractor (AC-3/AC-10)
│   │   │   ├── errors.ts            # ERR_ARCHIVE_* error codes + user message keys
│   │   │   ├── metadata.ts          # exifr capture-date + EXIF/GPS
│   │   │   ├── thumbnail.ts         # rendition generation (sharp images / ffmpeg video)
│   │   │   ├── ffmpeg.ts            # bundled binary path resolution + spawn (no shell)
│   │   │   └── hash.ts              # streaming SHA-256
│   │   ├── importers/
│   │   │   ├── types.ts             # Importer · CatalogRecord · ImporterDeps  ← THE boundary (§3)
│   │   │   ├── registry.ts          # SourceType → () => Importer
│   │   │   ├── folder/  whatsapp/  takeout/  facebook/  linkedin/
│   │   ├── workers/
│   │   │   └── ingestion-worker.ts  # worker_threads entry: runs an Importer, writes the catalog
│   │   └── library/
│   │       └── library-service.ts   # open/create/switch + undo + on-disk layout (§4.4)
│   └── preload/
│       └── index.ts                 # contextBridge: window.kawsayAPI (zod-validated) + event subscribe
├── src/                             # React renderer (Vite)
│   ├── main.tsx · App.tsx
│   ├── ui/                          # token-driven primitives (Button, SourceCard, MemoryCard, …)
│   ├── features/                    # onboarding/ import/ timeline/ search/ memory/ settings/
│   ├── hooks/ · lib/
│   └── styles/                      # tokens.css (USER_FLOWS §5) · fonts/*.woff2 (bundled, AC-4)
├── shared/                          # types shared main↔renderer: channel names, DTOs, SourceType
├── tests/                           # unit/ integration/ e2e/ perf/ ac4/ fixtures/
├── resources/                       # icons (.icns/.ico), entitlements, native-rebuild hooks
├── electron-builder.yml · electron.vite.config.ts · vitest.config.ts · playwright.config.ts
├── tsconfig.json · package.json · pnpm-lock.yaml
```

### 1.3 Module map (what each layer owns)

| Layer | Owns | Must NOT |
|-------|------|----------|
| `src/` renderer | presentation, navigation, virtualized timeline, a11y, calling `kawsayAPI` | import Node/Electron, hold fs paths it can write, open network, touch the DB |
| `electron/preload` | the typed bridge, payload validation, event fan-out | contain business logic; expose a catch-all `send()` |
| `electron/main/security` | egress guard, CSP, window/nav hardening, media protocol | be optional — installed before the window loads |
| `electron/main/ipc` | re-validate payloads, sender-origin checks, delegate to services | run heavy work inline on the main thread |
| `electron/main/db` | schema, migrations, catalog repo, FTS search, pragmas | be reachable from the renderer directly |
| `electron/main/ingestion` | extraction, metadata, thumbnails, hashing, coordination | block the main thread; shell-interpolate paths |
| `electron/main/importers` | per-source discover→parse→normalize→emit, behind one interface | write the DB directly (they *emit*; the worker persists) |
| `electron/main/workers` | run importers off-thread, persist via catalog repo, post progress | touch the UI |
| `shared/` | DTOs + channel constants + `SourceType` union | depend on Node or DOM globals |

### 1.4 Where each AC's code lives

| AC | Primary code location | Tests |
|----|-----------------------|-------|
| **AC-1** WhatsApp E2E | `importers/whatsapp/` + `features/import/whatsapp/` | integration + e2e |
| **AC-2** Folder photos/videos + dates + thumbs | `importers/folder/` + `ingestion/metadata.ts` + `ingestion/thumbnail.ts` | integration |
| **AC-3** Safe extraction (zip-slip) | `ingestion/safe-extract.ts` + `ingestion/errors.ts` | unit + integration |
| **AC-4** Zero egress | `security/network-guard.ts` + `security/csp.ts` | `tests/ac4/*` (Vitest+nock, Playwright) |
| **AC-5** Build/publish | `electron-builder.yml` + `.github/workflows/release.yml` + `main/index.ts` smoke | CI + e2e smoke |
| **AC-6/7** Browse + search | `db/search.ts` + `features/timeline/` + `features/search/` | e2e + integration |
| **AC-8** Virtualized timeline | `features/timeline/TimelineGrid.tsx` | e2e / perf |
| **AC-9** Off-thread ingestion | `workers/ingestion-worker.ts` + `ingestion/coordinator.ts` | integration / perf |
| **AC-10** Bomb/symlink rejection | `ingestion/safe-extract.ts` + `ingestion/errors.ts` | unit + integration |
| **AC-11** Takeout content | `importers/takeout/` | integration |
| **AC-12** Walkthrough + Browse-first | `features/import/walkthrough/` | e2e |
| **AC-13** Accessibility | `src/ui/*` + `styles/tokens.css` | e2e (axe) |
| **AC-14** Originals + undo | `library/library-service.ts` + occurrence model (§4) | integration |
| **AC-15** Resilient partial import | `ingestion/coordinator.ts` (`onSkip`) | integration |
| **AC-16** Facebook + LinkedIn | `importers/facebook/` + `importers/linkedin/` | integration |

---

## 2. Security model (Electron)

> Defense-in-depth. The egress invariant (§6) and safe extraction (§7) are separate sections; this
> section covers the renderer sandbox, the window, and the IPC trust boundary. (Research: `security.md`
> Topic 3.) Decision: **ADR-0005**.

### 2.1 `BrowserWindow` hardening

```ts
// electron/main/security/window-hardening.ts
const win = new BrowserWindow({
  webPreferences: {
    contextIsolation: true,        // default ≥E12 — never override
    sandbox: true,                 // default ≥E20 — never override
    nodeIntegration: false,        // default ≥E5  — never override
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    webSecurity: true,             // never set false
    preload: path.join(__dirname, '../preload/index.js'),
    devTools: !app.isPackaged,     // dev only
  },
});

// Block navigation away from the app origin, and deny all window.open()
win.webContents.on('will-navigate', (e, url) => {
  if (new URL(url).origin !== new URL(win.webContents.getURL()).origin) e.preventDefault();
});
win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
```

`shell.openExternal` is **not** used in v1 (no external links). If ever added it must allowlist-validate
the URL — but note an external link is still a *user-initiated OS action*, not app egress (§6).

### 2.2 Content-Security-Policy (canonical)

Set in main via `session.defaultSession.webRequest.onHeadersReceived`, and mirrored in `index.html`'s
`<meta http-equiv>` as belt-and-suspenders (research `security.md` Topic 3; PRD §5.1; AC-4):

```
default-src 'none';
script-src 'self';
style-src 'self';
style-src-attr 'unsafe-inline';                 ← see note
img-src 'self' kawsay-media: data: blob:;
media-src 'self' kawsay-media: blob:;
font-src 'self';
connect-src 'none';                             ← the renderer-side egress kill-switch
worker-src 'self' blob:;
object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none';
```

- **`connect-src 'none'`** forbids `fetch`/XHR/WebSocket/`EventSource` from the renderer entirely — the
  CSP half of the zero-egress guarantee (§6).
- **`style-src-attr 'unsafe-inline'`** is required because `@tanstack/react-virtual` sets inline
  `style` *attributes* (transform/height) on virtual rows. We keep **stylesheets** locked to `'self'`
  (`style-src 'self'`, no inline `<style>` injection — Tailwind compiles to a static sheet) and only
  relax the narrower `style-src-attr`. This is stricter than blanket `'unsafe-inline'` and is the
  deliberate reconciliation of PRD §5.1's strict stance with the virtualizer's needs. *(Flag for
  red-team: confirm no library injects inline `<style>` blocks; if so, switch those to hashed styles.)*
- **`kawsay-media:`** is our custom local-media scheme (§2.4), not a network origin.
- **No remote anything** — fonts (`Lora`, `Inter`) ship as bundled `.woff2`; the icon set is a single
  bundled monochrome SVG sprite; no Google Fonts, no CDN (USER_FLOWS §5.4, §4 `Icon`).

### 2.3 The contextBridge IPC surface (enumerated)

The renderer's *entire* capability. One method per channel; **no catch-all `send`**. Each method
validates its payload with **zod in preload**, and every handler **re-validates in main** and checks
the sender origin (research `security.md` Topic 3; AC-4). Channels are `invoke`/`handle` (request →
response) unless marked *event* (main → renderer stream).

| Channel | Direction | Payload (zod) | Returns |
|---------|-----------|---------------|---------|
| `library:list` | invoke | `{}` | `LibrarySummary[]` |
| `library:current` | invoke | `{}` | `LibrarySummary \| null` |
| `library:create` | invoke | `{ path: string(1..4096), personName: string(1..200) }` | `LibrarySummary` |
| `library:open` | invoke | `{ path: string(1..4096) }` | `LibrarySummary` |
| `dialog:pickPath` | invoke | `{ kind: 'file'\|'folder', filters?: string[] }` | `{ path } \| { cancelled: true }` |
| `import:start` | invoke | `ImportStartSchema` (below) | `{ jobId: string }` |
| `import:cancel` | invoke | `{ jobId: string(uuid) }` | `{}` |
| `import:undo` | invoke | `{ sourceId: string(uuid) }` | `{ removed: number }` |
| `import:progress` | **event** | `ImportProgress` (below) | — |
| `import:done` | **event** | `{ jobId, sourceId, summary: ImportSummary }` | — |
| `import:error` | **event** | `{ jobId, code: ArchiveErrorCode\|'ERR_IMPORT', messageKey }` | — |
| `catalog:timeline` | invoke | `{ cursor?: string, limit: int(1..200), filter?: CatalogFilter }` | `{ items: ItemCard[], nextCursor?: string }` |
| `catalog:search` | invoke | `SearchOptsSchema` (below) | `{ items: ItemCard[], total: number }` |
| `catalog:item` | invoke | `{ itemId: string(uuid) }` | `ItemDetail` (incl. `occurrences[]` provenance) |
| `catalog:months` | invoke | `{ filter?: CatalogFilter }` | `{ monthKey: string, count: number }[]` |
| `item:setFavourite` | invoke | `{ itemId: string(uuid), value: boolean }` | `{}` |
| `sources:list` | invoke | `{}` | `SourceSummary[]` |
| `settings:get` | invoke | `{}` | `Settings` |
| `settings:set` | invoke | `SettingsPatchSchema` | `Settings` |

Representative schemas (`electron/main/ipc/schemas.ts`, imported by preload too):

```ts
export const SourceType = z.enum(['folder','whatsapp','google_takeout','facebook','linkedin']);

export const ImportStartSchema = z.object({
  sourceType: SourceType,
  inputPath: z.string().min(1).max(4096),     // an absolute path the user picked via dialog
});

export const CatalogFilter = z.object({
  types:     z.array(z.enum(['photo','video','audio','document','message'])).optional(),
  sourceIds: z.array(z.string().uuid()).optional(),
  dateFrom:  z.string().datetime().optional(),
  dateTo:    z.string().datetime().optional(),
  favourite: z.boolean().optional(),
}).strict();

export const SearchOptsSchema = z.object({
  query:  z.string().max(512),
  filter: CatalogFilter.optional(),
  limit:  z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
}).strict();

export const ImportProgress = z.object({
  jobId: z.string().uuid(),
  phase: z.enum(['extracting','scanning','ingesting','thumbnailing','done']),
  processed: z.number().int(), total: z.number().int().nullable(),
  found: z.object({ photos: z.number(), videos: z.number(), audios: z.number(),
                    documents: z.number(), messages: z.number() }),
  skipped: z.number().int(),
});
```

Handlers re-validate and check origin:

```ts
// electron/main/ipc/handlers/import.ts
ipcMain.handle('import:start', async (event, raw) => {
  if (new URL(event.senderFrame.url).protocol !== 'file:') throw new Error('bad sender origin');
  const { sourceType, inputPath } = ImportStartSchema.parse(raw);   // never trust the preload alone
  return ingestion.start(sourceType, inputPath);                    // returns { jobId }
});
```

### 2.4 The `kawsay-media://` custom protocol (no `file://` to the renderer)

The renderer must display thumbnails and play media without `file://` access or network. We register a
**privileged custom scheme** and serve only validated paths inside the open library:

```ts
// main, before window load:
protocol.registerSchemesAsPrivileged([{
  scheme: 'kawsay-media',
  privileges: { standard: true, secure: true, supportFetchAPI: false, stream: true, bypassCSP: false },
}]);

// electron/main/security/media-protocol.ts
protocol.handle('kawsay-media', async (req) => {
  // kawsay-media://item/<uuid>?asset=thumbnail|original|poster|waveform
  const path = await mediaResolver.resolve(req.url);   // DB lookup → absolute path
  if (!path || !isInsideLibrary(path)) return new Response(null, { status: 403 });
  return netResponseStream(path);                      // streamed; supports range for video
});
```

`mediaResolver` maps an item/asset id → its stored path via the catalog, and `isInsideLibrary()`
re-checks the resolved real path is under the library root (defense against traversal). The renderer
never learns real filesystem paths; it only holds opaque `kawsay-media://item/<uuid>` URLs.

### 2.5 Packaged-app hardening (at build time)

`@electron/fuses` flipped during packaging + ASAR integrity (research `security.md` Topic 3/5;
**ADR-0007**): `RunAsNode=false`, `EnableNodeOptionsEnvironmentVariable=false`,
`EnableNodeCliInspectArguments=false`, `OnlyLoadAppFromAsar=true`,
`EnableEmbeddedAsarIntegrityValidation=true`, `GrantFileProtocolExtraPrivileges=false`,
`EnableCookieEncryption=true`.

### 2.6 Untrusted-payload validation everywhere

`zod` validates: (a) every IPC payload (preload + main), and (b) every parsed sidecar/JSON/CSV row
inside importers before field access (research `security.md` Topic 3, `formats.md` security notes). A
parse failure on one record is a **skip** (AC-15), never a crash.

---

## 3. Connector (importer) architecture

> The extensibility boundary that lets the source list keep growing cheaply (MISSION §3/§4). Every
> source is an isolated module behind **one interface**. Decision: **ADR-0002**. (Research:
> `formats.md` "Connector Architecture Mapping".)

### 3.1 The `Importer` interface

```ts
// electron/main/importers/types.ts
export type SourceType = 'folder' | 'whatsapp' | 'google_takeout' | 'facebook' | 'linkedin';

/** One normalized memory *occurrence* emitted by an importer. */
export interface CatalogRecord {
  sourceType: SourceType;
  mediaType: 'photo' | 'video' | 'audio' | 'document' | 'message';
  /** Absolute path to the byte-identical original on disk; null for pure text messages/posts. */
  originalPath: string | null;
  mimeType: string | null;
  /** Best date the source provides, with provenance for capture_date_src. */
  date: { value: Date; source: 'exif'|'sidecar'|'filename'|'mtime'|'message' } | null;
  author: string | null;                 // sender / poster, as this source records it
  body: string | null;                    // message text / caption / document snippet (feeds FTS)
  gps: { lat: number; lon: number; alt?: number } | null;
  durationSec: number | null;
  /** Stable id WITHIN this source (relative path, message index) — provenance + idempotent re-import. */
  sourceRef: string;
  /** Raw source-specific fields preserved verbatim for the ProvenanceMeta UI. */
  sourceMeta: Record<string, unknown>;
}

/** Injected, sandboxed dependencies — the DI seam that makes importers unit-testable with fixtures. */
export interface ImporterDeps {
  fs: FsLike;                  // real fs in prod; in-memory/fixture fs in unit tests
  extractArchive: SafeExtractFn;   // the guarded yauzl extractor (§7) — never raw unzip
  readExif: ExifReader;        // exifr wrapper
  probeMedia: MediaProber;     // ffprobe wrapper (subprocess)
  hashFile: FileHasher;        // streaming SHA-256
}

export interface ImportContext {
  sourceId: string;            // the sources row id for this run
  workDir: string;            // per-import scratch under <library>/extract/<sourceId>/
  signal: AbortSignal;        // honored by long loops (import:cancel)
  deps: ImporterDeps;
  onSkip(s: { ref: string; reason: string; code?: string }): void;   // AC-15 — never throw to abort
  onProgress(p: Partial<ImportProgress>): void;                       // coarse, throttled
}

export interface Importer {
  readonly id: SourceType;
  readonly displayName: string;
  /** Cheap predicate: can this importer handle the dropped path? (markers / magic bytes) */
  canHandle(inputPath: string, deps: ImporterDeps): Promise<boolean>;
  /** discover → parse → normalize → emit. Runs INSIDE the ingestion worker thread. */
  import(inputPath: string, ctx: ImportContext): AsyncGenerator<CatalogRecord, ImportResult>;
}

export interface ImportResult { recordCount: number; skipped: SkippedItem[]; }
```

### 3.2 The four lifecycle phases (every importer)

1. **Discover** — for archives: `deps.extractArchive(zip, ctx.workDir)` (guarded, §7) then walk; for
   folders: recursive `walkDir` in place (no extraction, no copy). Enumerate candidate entries.
2. **Parse** — source-specific: `whatsapp-chat-parser` for `_chat.txt`; `postal-mime` (streaming) for
   `.mbox`; JSON traversal + `latin1→utf8` mojibake fix for Facebook; `papaparse` for LinkedIn CSV;
   `exifr` + `ffprobe` for media (research `formats.md` §1–§5).
3. **Normalize** — map raw fields → `CatalogRecord` (resolve dates with the documented fallback chain
   EXIF→sidecar→filename→mtime; correlate WhatsApp media by filename; resolve Facebook relative media
   URIs *inside the extract root only*).
4. **Emit** — `yield` each record. The worker (not the importer) persists it via the catalog repo,
   applying dedup-with-provenance (§4.2). The importer is pure “produce records”; persistence is the
   worker's job — a clean testing seam.

### 3.3 Per-source mapping

| Importer | Input | Key parser(s) | Original storage | ACs |
|----------|-------|---------------|------------------|-----|
| `folder` | folder path | `exifr` + `ffprobe` + `file-type` (magic bytes) | **in place** (referenced, not copied) | AC-2, AC-9, AC-14, AC-15 |
| `whatsapp` | `.zip` | `whatsapp-chat-parser`; media co-located | copied into `<library>/originals/<sourceId>/` | AC-1, AC-12, AC-15 |
| `google_takeout` | `.zip`(s) | `postal-mime` (mbox, streamed) + sidecar `.json` + `exifr` | copied (mbox attachments + photos) | AC-11, AC-15 |
| `facebook` | `.zip` | JSON traversal + mojibake fix (`Buffer.from(s,'latin1').toString('utf8')`) | copied | AC-16, AC-3, AC-10, AC-15 |
| `linkedin` | `.zip` | `papaparse` (trim headers; multiline cells) | copied (rarely any media) | AC-16, AC-15 |

### 3.4 Plugging in a new connector

1. Add the literal to the `SourceType` union (`shared/`).
2. Implement `Importer` in `importers/<name>/`.
3. Register it: `registry.ts` — `{ <name>: () => new XImporter() }`.
4. Add a `SourceCard` + (if needed) a `WalkthroughStep` set in the renderer.
5. Add fixtures under `tests/fixtures/<name>/` and one new `AC-n` (ROADMAP M3 convention).

No other layer changes: the coordinator, worker, catalog repo, timeline, search, and undo are all
source-agnostic — they speak only `CatalogRecord` and the catalog schema.

### 3.5 Partial failure + provenance (AC-15, AC-14, PRD §5.6)

- **Partial failure:** a bad/corrupt/unreadable entry calls `ctx.onSkip({ref, reason})` and the
  generator continues. The coordinator increments `sources.skipped_count` and the renderer shows
  `SkippedItemsPanel` (filename + plain reason). The import **never aborts** on one bad file. Only a
  fatal, whole-archive condition (e.g. `ERR_ARCHIVE_*`, §7) aborts the run with a clear message.
- **Provenance:** every emitted record carries `sourceRef`, `author`, `date`, and `sourceMeta`. The
  worker persists these as an **`item_occurrences`** row (§4.2). When the same photo arrives from two
  sources, its bytes are stored **once** (dedup by content hash) but **both** occurrences are kept — so
  nothing is silently dropped and the `Sources` provenance view stays faithful for Mateo.

---

## 4. Local library & data model

> Decision: **ADR-0003** (auto-with-audit; data-model). The exact on-disk *location* and the privacy
> guarantee are the **HUMAN-REQUIRED ADR-0008**. (Research: `catalog-pkg.md` §2.)

### 4.1 Engine & pragmas

**`better-sqlite3`** (synchronous, fast, native). Reads for browse/search run on the main thread;
**writes happen inside the ingestion worker thread** (`better-sqlite3` supports worker-thread access).
Opened with (research `catalog-pkg.md` §2.2):

```ts
db.pragma('journal_mode = WAL');     // concurrent reads during ingestion
db.pragma('synchronous = NORMAL');   // safe + fast with WAL
db.pragma('foreign_keys = ON');      // enforce occurrence/asset cascades
db.pragma('cache_size = -32000');    // 32 MB page cache
db.pragma('temp_store = MEMORY');
db.pragma('mmap_size = 134217728');  // 128 MB mmap I/O
```

### 4.2 Schema (`migrations/001_initial.sql`) — full DDL

The critical refinement over a naïve catalog: **`items` is the deduplicated logical memory; the
`item_occurrences` table records every source occurrence**. This is what makes *dedup-with-provenance*
(AC-14/AC-15, PRD §5.6) true — the same bytes stored once, every origin preserved.

```sql
-- ── migrations bookkeeping ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS migrations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL UNIQUE,
  applied_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ── SOURCES: one row per import run ──────────────────────────────────────
CREATE TABLE sources (
  id            TEXT PRIMARY KEY,                          -- UUIDv4
  type          TEXT NOT NULL CHECK (type IN
                  ('folder','whatsapp','google_takeout','facebook','linkedin')),
  label         TEXT NOT NULL,                             -- "Mum's WhatsApp backup"
  origin_path   TEXT,                                      -- the original .zip / chosen folder (untouched)
  root_path     TEXT,                                      -- folder root, or extracted-archive copy root
  imported_at   TEXT NOT NULL DEFAULT (datetime('now')),
  item_count    INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN
                  ('pending','extracting','ingesting','done','error','undone'))
);

-- ── ITEMS: the deduplicated logical memory ───────────────────────────────
CREATE TABLE items (
  id               TEXT PRIMARY KEY,                       -- UUIDv4
  media_type       TEXT NOT NULL CHECK (media_type IN
                     ('photo','video','audio','document','message')),
  mime_type        TEXT,

  -- Deduplication key. SHA-256 hex of file bytes. NULL for pure messages and
  -- until hashing completes. SQLite treats NULLs as DISTINCT, so many message
  -- rows with NULL hash coexist; only non-null hashes dedupe.
  content_hash     TEXT UNIQUE,

  -- The single preserved original this item points at:
  --  • folder import → the user's file IN PLACE (never copied/moved)
  --  • archive import → the copy under <library>/originals/<sourceId>/...
  --  • pure message   → NULL
  stored_path      TEXT,
  file_size_bytes  INTEGER,

  -- Temporal: capture/taken date vs import date are distinct (PRD AC-2/AC-11).
  capture_date     TEXT,                                   -- ISO-8601, best available
  capture_date_src TEXT CHECK (capture_date_src IN
                     ('exif','sidecar','filename','mtime','message','import')),
  import_date      TEXT NOT NULL DEFAULT (datetime('now')),

  -- Geometry / media
  width INTEGER, height INTEGER, duration_sec REAL, orientation INTEGER,

  -- EXIF (nullable; photos/videos)
  camera_make TEXT, camera_model TEXT,
  gps_lat REAL, gps_lon REAL, gps_alt REAL,               -- catalogued locally only (no online maps, §7/PRD §7)

  -- User-facing + search feed
  title        TEXT,
  description  TEXT,                                       -- message body / caption / doc snippet
  search_meta  TEXT,                                       -- denormalized FTS feed: filenames, sender(s), subject
  is_favourite INTEGER NOT NULL DEFAULT 0 CHECK (is_favourite IN (0,1)),

  -- Thumbnail queue-drain flag (rendition paths live in item_assets)
  thumb_status TEXT NOT NULL DEFAULT 'pending' CHECK (thumb_status IN
                 ('pending','done','error','skipped')),

  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── ITEM_OCCURRENCES: provenance — one row per (item, source) occurrence ──
-- THIS is dedup-with-provenance: dedup keeps one `items` row; we keep an
-- occurrence row for EVERY source the bytes/message arrived from.
CREATE TABLE item_occurrences (
  id            TEXT PRIMARY KEY,                          -- UUIDv4
  item_id       TEXT NOT NULL REFERENCES items(id)   ON DELETE CASCADE,
  source_id     TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  source_ref    TEXT NOT NULL,                             -- path/index within that source
  original_path TEXT,                                      -- byte-identical original as it existed in THIS source
  author        TEXT,                                      -- sender/poster per this source
  occurred_at   TEXT,                                      -- timestamp per this source (chat/post time)
  source_meta   TEXT,                                      -- JSON: raw per-occurrence fields
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (item_id, source_id, source_ref)                 -- idempotent re-import
);

-- ── ITEM_ASSETS: generated renditions (NEVER the original) ───────────────
CREATE TABLE item_assets (
  id         TEXT PRIMARY KEY,
  item_id    TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('thumbnail','poster','waveform')),
  path       TEXT NOT NULL,                                -- under <library>/derived/...
  width INTEGER, height INTEGER, byte_size INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (item_id, kind)
);

-- ── TAGS / COLLECTIONS (browse organization; v1 minimal) ─────────────────
CREATE TABLE tags (
  id   TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE
);
CREATE TABLE item_tags (
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  tag_id  TEXT NOT NULL REFERENCES tags(id)  ON DELETE CASCADE,
  PRIMARY KEY (item_id, tag_id)
);
CREATE TABLE collections (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  description   TEXT,
  cover_item_id TEXT REFERENCES items(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE collection_items (
  collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  item_id       TEXT NOT NULL REFERENCES items(id)       ON DELETE CASCADE,
  position      INTEGER,
  added_at      TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (collection_id, item_id)
);

-- ── FTS5 full-text search (external-content over items) ──────────────────
CREATE VIRTUAL TABLE items_fts USING fts5(
  title, description, search_meta,
  content='items', content_rowid='rowid', tokenize='unicode61'   -- handles ES/PT diacritics
);
CREATE TRIGGER items_fts_ai AFTER INSERT ON items BEGIN
  INSERT INTO items_fts(rowid, title, description, search_meta)
  VALUES (new.rowid, new.title, new.description, new.search_meta);
END;
CREATE TRIGGER items_fts_ad AFTER DELETE ON items BEGIN
  INSERT INTO items_fts(items_fts, rowid, title, description, search_meta)
  VALUES ('delete', old.rowid, old.title, old.description, old.search_meta);
END;
CREATE TRIGGER items_fts_au AFTER UPDATE ON items BEGIN
  INSERT INTO items_fts(items_fts, rowid, title, description, search_meta)
  VALUES ('delete', old.rowid, old.title, old.description, old.search_meta);
  INSERT INTO items_fts(rowid, title, description, search_meta)
  VALUES (new.rowid, new.title, new.description, new.search_meta);
END;

-- ── Indexes (timeline browse, dedup, queue drain, joins) ─────────────────
CREATE INDEX idx_items_capture_date ON items(capture_date DESC);
CREATE INDEX idx_items_media_type   ON items(media_type);
CREATE INDEX idx_items_thumb_queue  ON items(thumb_status) WHERE thumb_status = 'pending';
CREATE INDEX idx_items_favourite    ON items(is_favourite) WHERE is_favourite = 1;
CREATE INDEX idx_items_gps          ON items(gps_lat, gps_lon)
  WHERE gps_lat IS NOT NULL AND gps_lon IS NOT NULL;
CREATE INDEX idx_occ_item   ON item_occurrences(item_id);
CREATE INDEX idx_occ_source ON item_occurrences(source_id);
CREATE INDEX idx_assets_item ON item_assets(item_id);
CREATE INDEX idx_item_tags_item ON item_tags(item_id);
CREATE INDEX idx_item_tags_tag  ON item_tags(tag_id);
-- (content_hash already has a UNIQUE index; NULLs are excluded from uniqueness in SQLite.)
```

**Dedup-with-provenance write path (in the worker, per emitted record):**

```ts
const tx = db.transaction((rec: CatalogRecord, hash: string | null) => {
  let itemId: string;
  const existing = hash ? repo.findItemByHash(hash) : null;   // dedup only for file-backed items
  if (existing) {
    itemId = existing.id;                                       // SAME bytes already stored → reuse
    repo.mergeMetadata(itemId, rec);                            // fill any newly-available fields
  } else {
    itemId = repo.insertItem(rec, hash);                        // new logical memory
  }
  repo.insertOccurrence(itemId, ctx.sourceId, rec);            // ALWAYS record this origin (provenance)
});
```

The content-addressed **thumbnail is keyed by hash**, so a deduped item also reuses its single
rendition — no duplicate work, no duplicate files.

### 4.3 Migration runner

Hand-written, forward-only, transactional, recorded in `migrations` (research `catalog-pkg.md` §2.3 —
the `octomux` pattern, chosen over an ORM for a single-user local app):

```ts
// electron/main/db/migrate.ts
const MIGRATIONS = [{ name: '001_initial', sql: read('001_initial.sql') } /* , 002_…, */];
export function runMigrations(db: Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS migrations(
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE,
    applied_at TEXT DEFAULT (datetime('now')))`);
  const done = new Set(db.prepare('SELECT name FROM migrations').all().map((r:any)=>r.name));
  for (const m of MIGRATIONS) if (!done.has(m.name)) db.transaction(() => {
    db.exec(m.sql);
    db.prepare('INSERT INTO migrations(name) VALUES (?)').run(m.name);
  })();
}
```

> **Governance:** authoring/altering a migration is a **DB-migration** action — HUMAN-REQUIRED per
> AGENTS Boundaries. The initial schema (001) ships **behind ADR-0008's sign-off** and is covered by an
> audit note in `DECISIONS.md`. Migrations are forward-only in v1; a down/rollback story is deferred
> (undo operates at the catalog/data level, §4.4, not via schema rollback).

### 4.4 Originals-on-disk layout (AC-14)

The **library is user-chosen** (USER_FLOWS `LibraryLocationPicker`; default a recommended folder). It
is self-contained and portable — catalog + originals + derived live together:

```
<library root>/                         ← chosen by the user; ONE open at a time (switchable)
├── catalog.sqlite3   (+ -wal, -shm)     ← the SQLite catalog
├── originals/                           ← archive-import copies ONLY (never folder imports)
│   └── <source-id>/<preserved relative path>/…
├── derived/                             ← Kawsay-generated, rebuildable
│   ├── thumbnails/<hash[0:2]>/<hash[2:4]>/<hash>.webp
│   ├── posters/…  waveforms/…
├── extract/                             ← transient per-import scratch; cleaned after ingest
│   └── <source-id>/…
└── logs/
```

- **Folder imports** are **referenced in place** — `items.stored_path` and
  `item_occurrences.original_path` point at the user's file; **nothing is copied or moved**. (AC-14:
  folder originals stay byte-identical in place.)
- **Archive imports** are extracted to transient `extract/`, validated (§7), then the validated files
  are **copied** into `originals/<source-id>/…`. The source `.zip` is never altered or deleted. After
  ingest, `extract/` is removed.
- **Undo** (AC-14): mark the `sources` row `undone`, `DELETE` its rows (cascades remove occurrences;
  items with no remaining occurrence are removed), delete Kawsay-made copies under
  `originals/<source-id>/` and now-orphaned `derived/` renditions — **never** touching in-place folder
  originals or any source archive. Because dedup keeps items shared across sources, an item is only
  removed when its **last** occurrence is undone.
- **App config** (window bounds, last-opened library path, accessibility prefs) lives in Electron
  `app.getPath('userData')`, **separate** from any library — so libraries stay portable and contain
  only the user's memories + catalog.

---

## 5. Ingestion pipeline (performance)

> Heavy work off the UI thread; `ffmpeg`/`ffprobe` as a subprocess; streaming parses; lazy media.
> Decision: **ADR-0004**. (Research `catalog-pkg.md` §3.4, `security.md` Topic 2; AC-8/AC-9.)

### 5.1 Data flow

```
Renderer  ──IPC import:start──▶  Main: IngestionCoordinator
                                   │  (creates sources row, jobId, workDir)
                                   ▼
                         worker_threads: ingestion-worker
                                   │  selects Importer from registry
                                   │  ── discover ──▶ safeExtract() [archives] / walkDir() [folders]
                                   │  ── parse ────▶ whatsapp-chat-parser / postal-mime(stream) / JSON / papaparse
                                   │  ── normalize ▶ exifr (capture date/EXIF)        ┐ per file
                                   │                 hashFile() (streaming SHA-256)    │ off main thread
                                   │                 ffprobe (utilityProcess subproc)  ┘
                                   │  ── emit ─────▶ catalog-repo: dedup-with-provenance INSERT (worker-side DB)
                                   │  ── thumbs ───▶ sharp (images) / ffmpeg (video poster)  → item_assets
                                   │
                                   └─ parentPort.postMessage(progress)  ──▶ Coordinator ──IPC import:progress──▶ Renderer
```

- **Worker threads** carry parse/hash/EXIF and the SQLite writes, so the **main thread never blocks**
  the IPC loop or the UI (AC-9: no main-thread task > 50 ms during import).
- **`ffprobe`/`ffmpeg` run as a subprocess** — ideally an Electron **`utilityProcess`** (Chromium-
  sandboxed), `spawn` with an **array argv (never a shell string)**, `timeout` + output caps. This
  isolates the highest-risk parser surface (research `security.md` Topic 2). Binaries are bundled via
  `ffmpeg-static`/`ffprobe-static` (`fluent-ffmpeg` is deprecated — we call the binaries directly).
- **Streaming parses** for large exports — `postal-mime`/`mbox` paginated; the chat log read line-wise;
  Facebook JSON traversed without buffering the whole file (research `formats.md` §1.8/§2.6). Never
  load a multi-GB `.mbox` into memory.
- **SHA-256** is computed via a streamed `createReadStream` → `crypto.createHash`, so even large files
  don't spike memory.
- **Thumbnails:** **`sharp`** for still images (fast, fewer CVEs than ffmpeg), **`ffmpeg`** for video
  poster frames; output WebP at ~480px; renditions are content-addressed (§4.4). v1 may use ffmpeg for
  both if `sharp`'s native rebuild is deferred (research `catalog-pkg.md` §3.3/§7).

### 5.2 Renderer-side laziness (AC-8)

- **Virtualized timeline** — `@tanstack/react-virtual`; rows of N thumbnails; a **bounded mounted-node
  window** that does not grow with item count (assert equal rendered rows at 1k vs 10k); sustains ≥55
  fps / no long-task > 50 ms at ≥10k items.
- **`LazyThumbnail`** loads a thumbnail over `kawsay-media://` only when the row is visible; shows a
  blur/skeleton placeholder until then. Media (`<img>`, `<video>`, `<audio>`) stream from the custom
  protocol — never the network, never marshaled wholesale over IPC.
- **No auto-play** — `VoiceNotePlayer`/`VideoPlayer` require explicit intent (USER_FLOWS §4; AC-13).

### 5.3 Cancellation & progress

`import:start` returns a `jobId`; the worker honors `ctx.signal` (`import:cancel`) at loop boundaries
and cleans up `extract/`. Progress is throttled (coarse-grained) and streamed via `import:progress`
with a running tally ("37 messages… 3 photos found…", PRD §3(f)). First-memory payoff (SM-2: ≤10 s) is
achieved by emitting/persisting records as they're found rather than batching at the end.

---

## 6. Zero-egress design (AC-4) — the core invariant

> *"A loved one's memories must never leave the machine."* (MISSION §5.) Prevented at runtime in
> multiple layers **and** proven by an automated test. Decisions: runtime guard in **ADR-0005**, the
> guarantee + threat model in **ADR-0008** (HUMAN-REQUIRED). (Research `security.md` Topic 4.)

### 6.1 Prevented at runtime (defense-in-depth)

1. **No code that egresses.** v1 has no network client — no `fetch`, no telemetry SDK, no update check,
   no remote fonts/CDN/maps. The absence is the first line of defense (PRD §5.1, §7).
2. **Renderer CSP `connect-src 'none'`** (§2.2) — forbids `fetch`/XHR/WebSocket/`EventSource` from the
   UI outright.
3. **Main-process network guard** — `session.defaultSession.webRequest.onBeforeRequest({urls:['<all_urls>']})`
   cancels every request whose scheme is not `file:` / `kawsay-media:` / `blob:` / `data:`. Fires before
   any byte leaves Chromium's stack (covers renderer + Chromium-internal requests).

```ts
// electron/main/security/network-guard.ts  (installed at startup, before window load)
export function installNetworkGuard(session: Session) {
  const ALLOWED = new Set(['file:', 'kawsay-media:', 'blob:', 'data:', 'devtools:']);
  session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, cb) => {
    const ok = ALLOWED.has(new URL(details.url).protocol);
    if (!ok && !app.isPackaged) console.error('[NETWORK-GUARD] blocked', details.url);
    cb({ cancel: !ok });
  });
}
```

4. **No DNS/raw TCP path** — main/worker code uses only `fs`/`crypto`/`better-sqlite3`/`yauzl`/`exifr`
   and the ffmpeg subprocess (which is only ever handed **local file paths**, never URLs — see §7), so
   there is no `node:net`/`node:http` client in the product.

### 6.2 Proven by an automated test (the AC-4 harness)

Three complementary harnesses; **all must record zero outbound connections** (research `security.md`
Topic 4):

- **Vitest (Node side)** — `nock.disableNetConnect()` makes any `http(s).ClientRequest` throw, **plus**
  a `vi.spyOn(net, 'createConnection')` that throws (nock doesn't cover raw TCP). Run every importer
  against fixtures; assert **0** attempts. (`tests/ac4/no-egress.node.test.ts`.)
- **Playwright (Chromium side)** — launch the packaged app; `page.route(/^(https?|wss?):\/\//, r => {
  record(r.url()); r.abort(); })`; run the full WhatsApp import + browse + search; assert the recorded
  list is **empty**. (`tests/ac4/zero-egress.e2e.ts`.)
- **CI OS-level (subprocess catch-all)** — the AC-4 job optionally drops outbound at the OS firewall
  (except loopback) while running the e2e flow, catching any subprocess egress (e.g. ffmpeg). Belt-and-
  suspenders for the gap `nock`/`page.route` can't see.

This is a **core, tested promise that may never be weakened** (MISSION §5, NEVER list; PRD AC-4). Any
PR touching the network guard, the CSP, or the AC-4 tests is harness-integrity → HUMAN-REQUIRED.

---

## 7. Safe untrusted-input handling

> Every archive is hostile until proven safe; media parsing is isolated. Decision: **ADR-0006**;
> threat model in **ADR-0008**. (Research `security.md` Topic 1–2; AC-3/AC-10.)

### 7.1 Guarded extraction (`yauzl`)

One extractor — `ingestion/safe-extract.ts` — is the **only** way archives are opened (no `adm-zip`/
`unzipper`). It applies the full checklist (research `security.md` Topic 1) on **every** entry, before
any byte is written:

| Guard | Check | Error code | AC |
|-------|-------|-----------|----|
| Filename validation | `yauzl.validateFileName` (auto via `decodeStrings:true`) — rejects `/`, `..`, `\` | `ERR_ARCHIVE_UNSAFE_PATH` | AC-3 |
| Resolved-path containment | `path.join(dest, name)` then `startsWith(dest + sep)` (belt-and-suspenders) | `ERR_ARCHIVE_UNSAFE_PATH` | AC-3 |
| Per-entry size cap | `uncompressedSize ≤ 500 MB` | `ERR_ARCHIVE_BOMB` | AC-10 |
| Total size cap | running total ≤ 2 GB | `ERR_ARCHIVE_BOMB` | AC-10 |
| Compression-ratio cap | `uncompressed/compressed ≤ 100` | `ERR_ARCHIVE_BOMB` | AC-10 |
| Entry-count cap | `count ≤ 100 000` | `ERR_ARCHIVE_BOMB` | AC-10 |
| Size-mismatch | `validateEntrySizes:true` (yauzl) | `ERR_ARCHIVE_BOMB` | AC-10 |
| Symlink rejection | Unix mode `(externalFileAttributes>>>16)&0xF000 === 0xA000` | `ERR_ARCHIVE_SYMLINK` | AC-10 |
| Strict filenames | `strictFileNames:true` (reject `\` on non-Windows) | `ERR_ARCHIVE_UNSAFE_PATH` | AC-3 |
| Corrupt/invalid zip | open/read failure | `ERR_ARCHIVE_CORRUPT` | AC-3 |

```ts
// electron/main/ingestion/errors.ts
export type ArchiveErrorCode =
  | 'ERR_ARCHIVE_UNSAFE_PATH'   // AC-3: zip-slip / absolute / backslash traversal
  | 'ERR_ARCHIVE_BOMB'          // AC-10: ratio / total / per-entry / entry-count
  | 'ERR_ARCHIVE_SYMLINK'       // AC-10: symlink entry (refinement; see note)
  | 'ERR_ARCHIVE_CORRUPT';      // unreadable / invalid archive
export class ArchiveError extends Error {
  constructor(readonly code: ArchiveErrorCode, readonly messageKey: string, msg?: string) { super(msg); }
}
```

- **Stable, assertable codes** are what AC-3 (`ERR_ARCHIVE_UNSAFE_PATH`) and AC-10 (`ERR_ARCHIVE_BOMB`)
  bind their tests to. They surface to the user as **clear, non-technical** copy via `messageKey`
  (e.g. `import.error.unsafeArchive`) — never a raw code in the UI (USER_FLOWS `ErrorBanner`, "no
  codes").
- **Refinement flagged for red-team:** PRD AC-10 names `ERR_ARCHIVE_BOMB` for the bomb-and-symlink
  scenario; this architecture adds a dedicated **`ERR_ARCHIVE_SYMLINK`** for clarity. AC-10's
  observable guarantees ("no symlink is materialized" + a stable assertable `ERR_ARCHIVE_*` code) are
  fully met and **not weakened** — the refinement is *more* specific, not less. If red-team prefers
  strict literal fidelity, fold symlink into `ERR_ARCHIVE_BOMB`.

### 7.2 Isolated, resource-capped media parsing

- **`exifr`** runs in the worker; cap input (parse only the first chunk), wrap in `try/catch`; a
  malformed EXIF is a **skip** (AC-15), not a crash (research `security.md` Topic 2).
- **`ffprobe`/`ffmpeg`** run as a **subprocess** (`utilityProcess`), **`spawn` array argv, never a
  shell string**, with `timeout` + `maxBuffer`; only **local file paths** are passed (never a URL — so
  ffmpeg can't be coerced into network I/O, closing the AC-4 subprocess gap). Bundled, pinned binaries;
  Dependabot keeps them patched.
- **Untrusted JSON/CSV** (Facebook, Takeout sidecars, LinkedIn) is `JSON.parse`-in-`try/catch` then
  **zod-validated** before field access; Facebook relative media URIs are resolved **inside the extract
  root only** and re-checked for containment (research `formats.md` security notes §3).

---

## 8. Packaging & distribution

> Decision: **ADR-0007**. (Research `catalog-pkg.md` §5, `security.md` Topic 5.)

- **Tooling:** `electron-builder`. Targets: **macOS `.dmg` + `.zip`** (`arm64` + `x64`), **Windows NSIS
  `.exe`** (`x64`; `arm64` cross-compiled). Publishes to **GitHub Releases** (`publish.provider:
  github`, `--publish always`, `GH_TOKEN: secrets.GITHUB_TOKEN`).
- **Native module (`better-sqlite3`)** is rebuilt for Electron's ABI (`npmRebuild: true`,
  `buildDependenciesFromSource: true`) and **`asarUnpack`**'d (a `.node` can't be `dlopen`'d from inside
  asar). Same `asarUnpack` for `ffmpeg-static`/`ffprobe-static` so the binaries are `spawn`-able.
- **CI matrix — per-arch native runners** (native modules can't be cross-compiled): `macos-14`
  (arm64), `macos-13` (x64), `windows-latest` (x64). Pin **Node 22** + **Python 3.11** (node-gyp needs
  `distutils`, removed in 3.12). `electron-rebuild` runs **after** `pnpm install`.
- **Fuses + ASAR integrity** flipped at package time (§2.5).
- **Unsigned in v1** (`mac.identity: null`; NSIS unsigned). Users get a one-time Gatekeeper/SmartScreen
  prompt (right-click→Open / More info→Run anyway). Code-signing + notarization is a deferred gated step
  (MISSION §2).
- **First-publish is HUMAN-REQUIRED.** CI **build/packaging is `auto`**, but the **first production
  publish of each release** runs in a **protected GitHub Environment with required reviewers**, blocking
  until @pedrofuentes approves (MISSION §9; PRD AC-5). The release smoke test launches the packaged app
  to a ready window.

```yaml
# electron-builder.yml (essence)
appId: es.pedrofuent.kawsay
productName: Kawsay
asarUnpack:
  - "**/node_modules/better-sqlite3/**"
  - "**/node_modules/ffmpeg-static/**"
  - "**/node_modules/ffprobe-static/**"
npmRebuild: true
buildDependenciesFromSource: true
mac: { target: [{target: dmg, arch: [arm64, x64]}, {target: zip, arch: [arm64, x64]}], identity: null }
win: { target: [{target: nsis, arch: [x64, arm64]}] }
nsis: { oneClick: false, allowToChangeInstallationDirectory: true }
publish: { provider: github, owner: pedrofuentes, repo: kawsay, releaseType: release }
```

---

## 9. Code patterns (referenced by AGENTS.md §Code Style)

- **Language/modules:** TypeScript **strict**; **ESM** everywhere; **named exports** only; functional
  React components.
- **Directory shape:** by responsibility in `electron/main/*` (security, ipc, db, ingestion, importers,
  workers, library); by **feature** in `src/features/*`; shared DTOs/constants in `shared/`.
- **Naming:** files `kebab-case.ts`; types/components `PascalCase`; functions/vars `camelCase`; SQL
  columns `snake_case`; IPC channels `domain:action`; error codes `ERR_SCREAMING_SNAKE`.
- **Error handling:** importers **never throw to abort** on one bad item — they `onSkip` (AC-15);
  fatal/whole-archive failures throw a typed `ArchiveError` with a stable `code` + non-technical
  `messageKey`. The renderer shows plain language, never a code (USER_FLOWS `ErrorBanner`).
- **Validation:** `zod` at every trust boundary — IPC payloads (preload + main) and every parsed
  sidecar/JSON/CSV row before use.
- **Concurrency:** no heavy work on the main thread; DB **writes in the worker**, **reads** for
  browse/search on main; `ffmpeg`/`ffprobe` as subprocess; honor `AbortSignal` for cancellation.
- **Testing seams (DI):** importers receive **`ImporterDeps`** (fs, extractArchive, readExif,
  probeMedia, hashFile) so unit tests inject **fixture fs + fakes** with no real files/subprocess
  (AGENTS §Code Style "DI for importers"). The `Importer` emits records; persistence is the worker's job
  — so importer logic is testable without a database. Adversarial-archive fixtures drive `safe-extract`
  unit tests; real-shaped export fixtures drive importer integration tests (PRD test kinds).
- **Tokens only in the UI:** components consume design tokens (USER_FLOWS §5) — zero hardcoded hex,
  sizes, or durations; visible focus + ≥44–48px hit targets; reduced-motion is the default posture
  (AC-13).
- **TDD (AGENTS):** failing `test(scope)` commit precedes `feat|fix(scope)`; worktree branches; Sentinel
  before merge.

---

## 10. Key files for orientation

| File | Purpose |
|------|---------|
| `electron/main/index.ts` | App entry; installs security guards **before** the window loads |
| `electron/main/security/network-guard.ts` | The runtime egress kill-switch (AC-4) |
| `electron/main/security/csp.ts` | The canonical CSP (AC-4) |
| `electron/main/security/media-protocol.ts` | `kawsay-media://` local serving (no `file://`/network) |
| `electron/preload/index.ts` | The entire renderer capability surface (zod-validated) |
| `electron/main/ipc/schemas.ts` | zod schemas shared by preload + main |
| `electron/main/importers/types.ts` | `Importer` / `CatalogRecord` / `ImporterDeps` — the extensibility boundary |
| `electron/main/ingestion/safe-extract.ts` | Guarded archive extraction + `ERR_ARCHIVE_*` |
| `electron/main/ingestion/coordinator.ts` | Off-thread ingestion + progress + skips (AC-9/AC-15) |
| `electron/main/db/migrations/001_initial.sql` | The catalog schema (dedup-with-provenance) |
| `electron/main/db/catalog-repo.ts` | Items / occurrences / sources; dedup write path |
| `electron/main/library/library-service.ts` | Library open/create/switch + undo + on-disk layout (AC-14) |
| `src/features/timeline/TimelineGrid.tsx` | Virtualized timeline (AC-8) |
| `tests/ac4/` | The zero-egress harness (Vitest+nock, Playwright, CI firewall) |
| `electron-builder.yml` | Packaging targets + native-module unpack + GitHub publish (AC-5) |

---

### Cross-references

MISSION §3 (stack), §5 (privacy), §7 (patterns), §9 (tiers) · PRD §3–§5 (features, AC-1…AC-16, NFRs) ·
USER_FLOWS §3–§6 (IA, components, tokens, a11y) · DECISIONS.md ADR-0001…ADR-0008 · Research
`security.md`, `catalog-pkg.md`, `formats.md`.
