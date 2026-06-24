import { basename, extname } from 'node:path';
import type { AssetKind, MediaType, OriginalKind } from '@shared/catalog';
import type { CatalogDatabase } from '../db/connection';
import { type CatalogRepo, toIsoUtc } from '../db/catalog-repo';
import { putOriginal } from '../library/originals-store';
import type {
  CatalogRecord,
  Importer,
  ImporterDeps,
  ImportContext,
  ImportProgress,
  SkippedItem,
} from './types';

/** A generated rendition reported back by a {@link ThumbnailGenerator}. */
export interface GeneratedAsset {
  kind: AssetKind;
  /** Library-RELATIVE path under derived/ (e.g. derived/thumbnails/ab/<hash>.webp). */
  path: string;
  width?: number | null;
  height?: number | null;
  byteSize?: number | null;
}

/** What the orchestrator hands a thumbnail/poster generator for one item. */
export interface ThumbnailRequest {
  /** Absolute library root (renditions land under <root>/derived/…). */
  libraryRoot: string;
  itemId: string;
  contentHash: string;
  mediaType: MediaType;
  /** Absolute path to the bytes to render from (the stored/original file). */
  sourcePath: string;
  mimeType: string | null;
}

/** Generate the derived rendition(s) for one item (ffmpeg subprocess, off-UI). */
export type ThumbnailGenerator = (request: ThumbnailRequest) => Promise<GeneratedAsset[]>;

/** Everything {@link runIngestion} needs — all collaborators are injected so the
 *  orchestrator is a pure async function over its inputs (worker-agnostic, AC-9). */
export interface IngestionInput {
  importer: Importer;
  inputPath: string;
  db: CatalogDatabase;
  repo: CatalogRepo;
  /** Absolute library root (for putOriginal + derived assets). */
  libraryRoot: string;
  /** The `sources` row id this run writes occurrences against. */
  sourceId: string;
  /** Per-import scratch dir, forwarded to the importer (<root>/extract/<sourceId>). */
  workDir: string;
  deps: ImporterDeps;
  generateThumbnail: ThumbnailGenerator;
  /** Cancels the run cooperatively (import:cancel → AbortSignal, AC-9). */
  signal: AbortSignal;
  onProgress?: (progress: ImportProgress) => void;
  /** Coalesce onProgress to at most one update per window (default 100 ms). */
  progressThrottleMs?: number;
  /** Injectable clock so the throttle is deterministic under test. */
  now?: () => number;
}

/** The terminal tally a run reports back to the IPC layer / caller. */
export interface IngestionSummary {
  recordCount: number;
  itemsTouched: number;
  occurrencesAdded: number;
  assetsAdded: number;
  thumbnailFailures: number;
  skipped: SkippedItem[];
  cancelled: boolean;
}

/** Media kinds that get a generated still (photo → thumbnail, video → poster). */
const RENDERED_MEDIA: ReadonlySet<MediaType> = new Set<MediaType>(['photo', 'video']);

/**
 * The denormalized FTS feed for an item: the source filename plus the author.
 * Merged across sources on dedup by the repo's `merge_tokens` (AC-7), so two
 * sources contributing the same bytes pool their search tokens.
 */
export function buildSearchTokens(record: CatalogRecord): string | null {
  const tokens: string[] = [];
  if (record.originalPath !== null) tokens.push(basename(record.originalPath));
  if (record.author !== null) tokens.push(record.author);
  const joined = tokens.join(' ').trim();
  return joined === '' ? null : joined;
}

/**
 * Drive one import to completion OFF the UI thread (AC-9): pull the importer's
 * normalized {@link CatalogRecord}s and persist each with dedup-with-provenance.
 *
 * Per record the heavy/async work (hashing, content-addressed copy, ffmpeg) runs
 * OUTSIDE the synchronous better-sqlite3 transaction, which only does the two
 * coupled catalog writes (item + occurrence) atomically:
 *   1. hash + retention (folder → in_place reference; archive → putOriginal copy)
 *   2. db.transaction(insertItem ON CONFLICT(content_hash) + addOccurrence)
 *   3. (photo/video) generateThumbnail → addAsset — a rendition failure is
 *      counted, never fatal (AC-15 in spirit)
 * Cancellation is honored between records; progress is throttled.
 */
export async function runIngestion(input: IngestionInput): Promise<IngestionSummary> {
  const {
    importer,
    inputPath,
    db,
    repo,
    libraryRoot,
    sourceId,
    workDir,
    deps,
    generateThumbnail,
    signal,
    onProgress,
    progressThrottleMs = 100,
    now = () => Date.now(),
  } = input;

  const skipped: SkippedItem[] = [];
  const itemIds = new Set<string>();
  let recordCount = 0;
  let occurrencesAdded = 0;
  let assetsAdded = 0;
  let thumbnailFailures = 0;
  let cancelled = false;

  let lastProgressAt = Number.NEGATIVE_INFINITY;
  let total: number | null = null;

  const emitProgress = (update: Partial<ImportProgress>, force = false): void => {
    if (!onProgress) return;
    if (update.total !== undefined) total = update.total;
    const at = now();
    if (!force && at - lastProgressAt < progressThrottleMs) return;
    lastProgressAt = at;
    onProgress({
      phase: update.phase ?? 'emit',
      processed: update.processed ?? recordCount,
      total,
      message: update.message ?? null,
    });
  };

  const ctx: ImportContext = {
    sourceId,
    workDir,
    signal,
    deps,
    onSkip: (item) => skipped.push(item),
    onProgress: (update) => {
      emitProgress(update);
    },
  };

  const persistRecord = async (record: CatalogRecord): Promise<void> => {
    let contentHash: string | null = null;
    let originalKind: OriginalKind = 'none';
    let occurrenceOriginalPath: string | null = null;
    let originalExt: string | null = null;
    let fileSizeBytes: number | null = null;
    let renderSourcePath: string | null = null;

    // 1. Content addressing + original retention — async, OUTSIDE the txn.
    if (record.originalPath !== null) {
      try {
        contentHash = await deps.hashFile(record.originalPath);
      } catch {
        skipped.push({
          ref: record.sourceRef,
          reason: 'could not read file to hash',
          code: 'E_HASH',
        });
        return;
      }
      originalExt = extname(record.originalPath) || null;
      try {
        fileSizeBytes = (await deps.fs.stat(record.originalPath)).size;
      } catch {
        fileSizeBytes = null;
      }

      if (record.sourceType === 'folder') {
        // §4.4: folder originals are referenced in place, never copied.
        originalKind = 'in_place';
        occurrenceOriginalPath = record.originalPath;
        renderSourcePath = record.originalPath;
      } else {
        // §4.4: archive originals are copied ONCE into the content-addressed store.
        const put = putOriginal({
          root: libraryRoot,
          hash: contentHash,
          ext: originalExt,
          sourcePath: record.originalPath,
        });
        originalKind = 'content_addressed';
        renderSourcePath = put.absPath;
      }
    }

    // 2. Coupled catalog writes — item + occurrence, atomically.
    const occurredAt = record.date ? toIsoUtc(record.date.value) : null;
    const persist = db.transaction(() => {
      const itemId = repo.insertItem({
        mediaType: record.mediaType,
        mimeType: record.mimeType,
        contentHash,
        originalExt,
        fileSizeBytes,
        captureDate: occurredAt,
        captureDateSrc: record.date ? record.date.source : null,
        durationSec: record.durationSec,
        gpsLat: record.gps ? record.gps.lat : null,
        gpsLon: record.gps ? record.gps.lon : null,
        gpsAlt: record.gps?.alt ?? null,
        description: record.body,
        searchMeta: buildSearchTokens(record),
      });
      const occurrence = repo.addOccurrence({
        itemId,
        sourceId,
        sourceRef: record.sourceRef,
        originalKind,
        originalPath: occurrenceOriginalPath,
        author: record.author,
        occurredAt,
        sourceMeta: JSON.stringify(record.sourceMeta),
      });
      return { itemId, occurrenceInserted: occurrence.inserted };
    });
    const { itemId, occurrenceInserted } = persist();
    itemIds.add(itemId);
    if (occurrenceInserted) occurrencesAdded += 1;

    // 3. Generated rendition — async ffmpeg AFTER the txn. A failure here never
    //    fails the item; it is counted (AC-15) so the run keeps going. The inline
    //    null checks also narrow contentHash/renderSourcePath to non-null here.
    if (
      renderSourcePath !== null &&
      contentHash !== null &&
      RENDERED_MEDIA.has(record.mediaType) &&
      !signal.aborted
    ) {
      try {
        const assets = await generateThumbnail({
          libraryRoot,
          itemId,
          contentHash,
          mediaType: record.mediaType,
          sourcePath: renderSourcePath,
          mimeType: record.mimeType,
        });
        for (const asset of assets) {
          repo.addAsset({
            itemId,
            kind: asset.kind,
            path: asset.path,
            width: asset.width ?? null,
            height: asset.height ?? null,
            byteSize: asset.byteSize ?? null,
          });
          assetsAdded += 1;
        }
      } catch {
        thumbnailFailures += 1;
      }
    }
  };

  const generator = importer.import(inputPath, ctx);
  for (;;) {
    if (signal.aborted) {
      cancelled = true;
      break;
    }
    const next = await generator.next();
    if (next.done) break;
    await persistRecord(next.value);
    recordCount += 1;
    emitProgress({ phase: 'emit', processed: recordCount });
  }
  if (cancelled) {
    // Let the importer run its finally blocks (close handles, clean scratch).
    await generator.return({ recordCount, skipped }).catch(() => undefined);
  }
  emitProgress({ phase: 'emit', processed: recordCount }, true);

  return {
    recordCount,
    itemsTouched: itemIds.size,
    occurrencesAdded,
    assetsAdded,
    thumbnailFailures,
    skipped,
    cancelled,
  };
}
