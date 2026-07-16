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
