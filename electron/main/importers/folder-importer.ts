import { extname, join, relative, sep } from 'node:path';
import type { MediaType } from '@shared/catalog';
import type {
  CatalogRecord,
  ExifData,
  FileStat,
  ImportContext,
  Importer,
  ImporterDeps,
  ImportResult,
  MediaInfo,
  RecordDateSource,
  SkippedItem,
} from './types';

/**
 * Card C1 (AC-2): the generic folder / cloud-download importer — the first
 * concrete {@link Importer}. It catalogues photos, videos, voice notes, and
 * documents from any directory, including the local mirror an iCloud / OneDrive
 * / Dropbox / Google-Drive client downloads.
 *
 * Originals are referenced **in place** (`original_kind: in_place`, §4.4): the
 * record's {@link CatalogRecord.originalPath} is the user's own absolute file
 * path and is never copied. Every side effect goes through the injected,
 * sandboxed {@link ImporterDeps} (`fs`, `readExif`, `probeMedia`) so this module
 * stays unit-testable with fixtures and decoupled from the concrete
 * exifr/ffprobe wrappers (card F3b).
 */

interface MediaKind {
  mediaType: MediaType;
  mime: string;
}

// Extension → (MediaType, mime). Lowercase keys; classification is extension
// based (research §5.1). Anything not listed is treated as non-media and
// skipped quietly (e.g. iOS `.aae` edit sidecars, `.DS_Store`).
const EXT_INFO = new Map<string, MediaKind>([
  // Photos
  ['.jpg', { mediaType: 'photo', mime: 'image/jpeg' }],
  ['.jpeg', { mediaType: 'photo', mime: 'image/jpeg' }],
  ['.png', { mediaType: 'photo', mime: 'image/png' }],
  ['.gif', { mediaType: 'photo', mime: 'image/gif' }],
  ['.webp', { mediaType: 'photo', mime: 'image/webp' }],
  ['.bmp', { mediaType: 'photo', mime: 'image/bmp' }],
  ['.tif', { mediaType: 'photo', mime: 'image/tiff' }],
  ['.tiff', { mediaType: 'photo', mime: 'image/tiff' }],
  ['.heic', { mediaType: 'photo', mime: 'image/heic' }],
  ['.heif', { mediaType: 'photo', mime: 'image/heif' }],
  ['.avif', { mediaType: 'photo', mime: 'image/avif' }],
  // Videos
  ['.mp4', { mediaType: 'video', mime: 'video/mp4' }],
  ['.m4v', { mediaType: 'video', mime: 'video/x-m4v' }],
  ['.mov', { mediaType: 'video', mime: 'video/quicktime' }],
  ['.avi', { mediaType: 'video', mime: 'video/x-msvideo' }],
  ['.mkv', { mediaType: 'video', mime: 'video/x-matroska' }],
  ['.webm', { mediaType: 'video', mime: 'video/webm' }],
  ['.wmv', { mediaType: 'video', mime: 'video/x-ms-wmv' }],
  ['.flv', { mediaType: 'video', mime: 'video/x-flv' }],
  ['.3gp', { mediaType: 'video', mime: 'video/3gpp' }],
  // Audio
  ['.mp3', { mediaType: 'audio', mime: 'audio/mpeg' }],
  ['.wav', { mediaType: 'audio', mime: 'audio/wav' }],
  ['.aac', { mediaType: 'audio', mime: 'audio/aac' }],
  ['.flac', { mediaType: 'audio', mime: 'audio/flac' }],
  ['.m4a', { mediaType: 'audio', mime: 'audio/mp4' }],
  ['.opus', { mediaType: 'audio', mime: 'audio/opus' }],
  ['.ogg', { mediaType: 'audio', mime: 'audio/ogg' }],
  ['.oga', { mediaType: 'audio', mime: 'audio/ogg' }],
  ['.wma', { mediaType: 'audio', mime: 'audio/x-ms-wma' }],
  ['.aiff', { mediaType: 'audio', mime: 'audio/aiff' }],
  ['.aif', { mediaType: 'audio', mime: 'audio/aiff' }],
  // Documents
  ['.pdf', { mediaType: 'document', mime: 'application/pdf' }],
  ['.doc', { mediaType: 'document', mime: 'application/msword' }],
  [
    '.docx',
    {
      mediaType: 'document',
      mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    },
  ],
  ['.xls', { mediaType: 'document', mime: 'application/vnd.ms-excel' }],
  [
    '.xlsx',
    {
      mediaType: 'document',
      mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    },
  ],
  ['.ppt', { mediaType: 'document', mime: 'application/vnd.ms-powerpoint' }],
  [
    '.pptx',
    {
      mediaType: 'document',
      mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    },
  ],
  ['.txt', { mediaType: 'document', mime: 'text/plain' }],
  ['.rtf', { mediaType: 'document', mime: 'application/rtf' }],
  ['.odt', { mediaType: 'document', mime: 'application/vnd.oasis.opendocument.text' }],
  ['.pages', { mediaType: 'document', mime: 'application/x-iwork-pages-sffpages' }],
  ['.numbers', { mediaType: 'document', mime: 'application/x-iwork-numbers-sffnumbers' }],
  ['.key', { mediaType: 'document', mime: 'application/x-iwork-keynote-sffkey' }],
]);

function classify(absPath: string): MediaKind | null {
  return EXT_INFO.get(extname(absPath).toLowerCase()) ?? null;
}

/** Path relative to the imported root, normalized to POSIX separators so the
 *  `sourceRef` is identical across platforms (stable for idempotent re-import). */
function toSourceRef(root: string, absPath: string): string {
  const rel = relative(root, absPath);
  return sep === '/' ? rel : rel.split(sep).join('/');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function recordSkip(
  ctx: ImportContext,
  skipped: SkippedItem[],
  ref: string,
  reason: string,
  code: string,
): void {
  const item: SkippedItem = { ref, reason, code };
  skipped.push(item);
  ctx.onSkip(item);
}

async function readExifSafe(deps: ImporterDeps, absPath: string): Promise<ExifData | null> {
  try {
    return await deps.readExif(absPath);
  } catch {
    // A corrupt/unsupported EXIF segment is not a failure to ingest — the file
    // is still catalogued with its mtime as the date (provenance: mtime).
    return null;
  }
}

async function probeMediaSafe(deps: ImporterDeps, absPath: string): Promise<MediaInfo | null> {
  try {
    return await deps.probeMedia(absPath);
  } catch {
    return null;
  }
}

function pickDate(
  exif: ExifData | null,
  stat: FileStat,
): { value: Date; source: RecordDateSource } {
  if (exif?.takenAt) {
    return { value: exif.takenAt, source: 'exif' };
  }
  return { value: new Date(stat.mtimeMs), source: 'mtime' };
}

function toGps(exif: ExifData | null): CatalogRecord['gps'] {
  if (!exif?.gps) {
    return null;
  }
  const { lat, lon, alt } = exif.gps;
  return alt === undefined ? { lat, lon } : { lat, lon, alt };
}

function buildSourceMeta(exif: ExifData | null, media: MediaInfo | null): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  if (exif?.cameraMake) meta.cameraMake = exif.cameraMake;
  if (exif?.cameraModel) meta.cameraModel = exif.cameraModel;
  if (exif?.orientation !== undefined) meta.orientation = exif.orientation;
  const width = exif?.width ?? media?.width ?? null;
  const height = exif?.height ?? media?.height ?? null;
  if (width !== null) meta.width = width;
  if (height !== null) meta.height = height;
  return meta;
}

async function buildRecord(
  root: string,
  absPath: string,
  stat: FileStat,
  info: MediaKind,
  deps: ImporterDeps,
): Promise<CatalogRecord> {
  // EXIF (date/GPS/camera) is image-only; timed media (video/audio) is probed
  // for duration/dimensions. Documents need neither.
  const exif = info.mediaType === 'photo' ? await readExifSafe(deps, absPath) : null;
  const media =
    info.mediaType === 'video' || info.mediaType === 'audio'
      ? await probeMediaSafe(deps, absPath)
      : null;

  return {
    sourceType: 'folder',
    mediaType: info.mediaType,
    originalPath: absPath,
    mimeType: media?.mimeType ?? info.mime,
    date: pickDate(exif, stat),
    author: null,
    body: null,
    gps: toGps(exif),
    durationSec: media?.durationSec ?? null,
    sourceRef: toSourceRef(root, absPath),
    sourceMeta: buildSourceMeta(exif, media),
  };
}

/** Depth-first discovery over the injected fs. Unreadable directories/entries
 *  are reported via {@link recordSkip} (AC-15) and never thrown; the signal is
 *  honored so a cancel stops the walk promptly. */
async function* walkFiles(
  dir: string,
  root: string,
  ctx: ImportContext,
  skipped: SkippedItem[],
): AsyncGenerator<{ absPath: string; stat: FileStat }> {
  if (ctx.signal.aborted) {
    return;
  }

  let names: readonly string[];
  try {
    names = await ctx.deps.fs.readDir(dir);
  } catch (error) {
    recordSkip(
      ctx,
      skipped,
      toSourceRef(root, dir) || '.',
      `unreadable directory: ${errorMessage(error)}`,
      'E_READDIR',
    );
    return;
  }

  for (const name of names) {
    if (ctx.signal.aborted) {
      return;
    }
    const child = join(dir, name);
    let stat: FileStat;
    try {
      stat = await ctx.deps.fs.stat(child);
    } catch (error) {
      recordSkip(
        ctx,
        skipped,
        toSourceRef(root, child),
        `unreadable entry: ${errorMessage(error)}`,
        'E_STAT',
      );
      continue;
    }
    if (stat.isDirectory()) {
      yield* walkFiles(child, root, ctx, skipped);
    } else if (stat.isFile()) {
      yield { absPath: child, stat };
    }
  }
}

export const folderImporter: Importer = {
  id: 'folder',
  displayName: 'Folder',

  async canHandle(inputPath: string, deps: ImporterDeps): Promise<boolean> {
    try {
      const stat = await deps.fs.stat(inputPath);
      return stat.isDirectory();
    } catch {
      return false;
    }
  },

  async *import(
    inputPath: string,
    ctx: ImportContext,
  ): AsyncGenerator<CatalogRecord, ImportResult> {
    const skipped: SkippedItem[] = [];
    let recordCount = 0;

    ctx.onProgress({ phase: 'discover', processed: 0, total: null, message: null });

    for await (const { absPath, stat } of walkFiles(inputPath, inputPath, ctx, skipped)) {
      if (ctx.signal.aborted) {
        break;
      }
      const info = classify(absPath);
      if (!info) {
        continue; // non-media → skip quietly (not a failure to report)
      }
      const record = await buildRecord(inputPath, absPath, stat, info, ctx.deps);
      recordCount += 1;
      ctx.onProgress({ phase: 'emit', processed: recordCount, total: null });
      yield record;
    }

    return { recordCount, skipped };
  },
};
