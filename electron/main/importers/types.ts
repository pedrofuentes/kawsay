import type { Readable } from 'node:stream';
import type { CaptureDateSource, MediaType, SourceType } from '@shared/catalog';

export type { SourceType };

/** Provenance of a record's date — every source except the `import` fallback. */
export type RecordDateSource = Exclude<CaptureDateSource, 'import'>;

/** One normalized memory *occurrence* emitted by an importer (§3.1). */
export interface CatalogRecord {
  sourceType: SourceType;
  mediaType: MediaType;
  /**
   * Absolute path to the byte-identical original as it exists in THIS source (an
   * in-place file for folder imports; an extracted file under the import scratch
   * for archives). null for pure text messages/posts. The worker decides
   * retention (§4.4): folder → referenced in place; archive → copied ONCE into
   * the content-addressed `originals/` store.
   */
  originalPath: string | null;
  mimeType: string | null;
  /** Best date the source provides, with provenance for capture_date_src. */
  date: { value: Date; source: RecordDateSource } | null;
  /** Sender / poster, as this source records it. */
  author: string | null;
  /** Message text / caption / document snippet (feeds FTS). */
  body: string | null;
  gps: { lat: number; lon: number; alt?: number } | null;
  durationSec: number | null;
  /** Stable id WITHIN this source (relative path, message index) — provenance + idempotent re-import. */
  sourceRef: string;
  /** Raw source-specific fields preserved verbatim for the ProvenanceMeta UI. */
  sourceMeta: Record<string, unknown>;
}

/** An item the importer could not ingest — reported, never thrown (AC-15). */
export interface SkippedItem {
  ref: string;
  reason: string;
  code?: string;
}

/** Coarse, throttled progress for the import UI (kept local to avoid coupling
 *  to the deferred IPC layer; the worker maps this onto an IPC event). */
export interface ImportProgress {
  phase: 'discover' | 'parse' | 'normalize' | 'emit';
  processed: number;
  total: number | null;
  message: string | null;
}

// ── Injected, sandboxed dependencies (the DI seam, §3.1) ────────────────────
// Minimal STRUCTURAL surfaces so connectors are unit-testable with fixtures and
// this contract stays decoupled from the concrete fs/exifr/ffprobe/yauzl wrappers.

export interface FileStat {
  size: number;
  mtimeMs: number;
  isFile(): boolean;
  isDirectory(): boolean;
}

export interface FsLike {
  readFile(path: string): Promise<Buffer>;
  readDir(path: string): Promise<readonly string[]>;
  stat(path: string): Promise<FileStat>;
  realpath?(path: string): Promise<string>;
  exists(path: string): Promise<boolean>;
  /**
   * Stream a file's bytes for memory-bounded parsing of huge exports — a Gmail
   * `.mbox` can be multiple GB, so the Takeout importer reads it message-by-
   * message and MUST NOT buffer the whole file (AC-11). Optional so existing
   * importers and their fixture doubles are unaffected; a connector that needs
   * it falls back to {@link FsLike.readFile} or reports a skip when absent.
   */
  openReadStream?(path: string): Readable;
  /**
   * Persist bytes that were extracted from WITHIN a container export (e.g. an
   * email attachment embedded in a `.mbox`) into the per-import scratch dir, so
   * the worker can hash + content-address them exactly like any archive
   * original (§4.4). Parent directories are created as needed. Optional, as
   * above.
   */
  writeFile?(path: string, data: Buffer): Promise<void>;
}

/** One entry produced by the guarded (zip-slip-safe) archive extractor. */
export interface ExtractedEntry {
  /** Path of the entry WITHIN the archive. */
  entryPath: string;
  /** Absolute path on disk after safe extraction, inside the scratch dir. */
  absPath: string;
}

/** The guarded yauzl extractor (§7) — never a raw unzip. */
export type SafeExtractFn = (
  archivePath: string,
  destDir: string,
  options?: { signal?: AbortSignal },
) => Promise<readonly ExtractedEntry[]>;

export interface ExifData {
  takenAt?: Date;
  gps?: { lat: number; lon: number; alt?: number };
  cameraMake?: string;
  cameraModel?: string;
  width?: number;
  height?: number;
  orientation?: number;
}

/** exifr wrapper. */
export type ExifReader = (path: string) => Promise<ExifData | null>;

export interface MediaInfo {
  durationSec: number | null;
  width: number | null;
  height: number | null;
  mimeType: string | null;
}

/** ffprobe wrapper (subprocess). */
export type MediaProber = (path: string) => Promise<MediaInfo>;

/** Streaming SHA-256 → lowercase hex. */
export type FileHasher = (path: string) => Promise<string>;

/** Injected, sandboxed dependencies — the DI seam that makes importers
 *  unit-testable with fixtures. */
export interface ImporterDeps {
  fs: FsLike;
  extractArchive: SafeExtractFn;
  readExif: ExifReader;
  probeMedia: MediaProber;
  hashFile: FileHasher;
}

export interface ImportContext {
  /** The sources row id for this run. */
  sourceId: string;
  /** Per-import scratch under <library>/extract/<sourceId>/. */
  workDir: string;
  /** Honored by long loops (import:cancel). */
  signal: AbortSignal;
  deps: ImporterDeps;
  /** AC-15 — report a skipped item; never throw to abort the run. */
  onSkip(item: SkippedItem): void;
  /** Coarse, throttled progress. */
  onProgress(update: Partial<ImportProgress>): void;
}

export interface ImportResult {
  recordCount: number;
  skipped: SkippedItem[];
}

/** The contract EVERY connector implements (folder, WhatsApp, Takeout, …). */
export interface Importer {
  readonly id: SourceType;
  readonly displayName: string;
  /** Cheap predicate: can this importer handle the dropped path? (markers / magic bytes) */
  canHandle(inputPath: string, deps: ImporterDeps): Promise<boolean>;
  /** discover → parse → normalize → emit. Runs INSIDE the ingestion worker thread. */
  import(inputPath: string, ctx: ImportContext): AsyncGenerator<CatalogRecord, ImportResult>;
}
