import { basename, dirname, extname, join, relative, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { simpleParser } from 'mailparser';
import type { AddressObject, Attachment, ParsedMail } from 'mailparser';
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
 * Card C4 (AC-11): the Google Takeout importer — it brings a Takeout export's
 * Gmail mailbox and Google Photos library into the catalogue.
 *
 * Input is the export **folder** the user unpacked OR the original **`.zip`**
 * (extracted via the injected, zip-slip-guarded {@link ImporterDeps.extractArchive}
 * — never a raw unzip), OR a standalone Gmail **`.mbox`**. Two payloads are
 * understood:
 *
 *  - **Gmail `.mbox`** (mboxrd): split message-by-message over the streaming
 *    {@link FsLike.openReadStream} seam — a real Takeout mailbox is multi-GB, so
 *    the whole file is NEVER buffered (AC-11). Each RFC-822 message is parsed
 *    with `mailparser`; its header date carries `message` provenance and every
 *    attachment is materialized into the import scratch dir as its own media
 *    record so the worker can hash + content-address it (§4.4).
 *  - **Google Photos**: each media file plus its per-file `*.json` sidecar. The
 *    sidecar's `photoTakenTime` / `creationTime` (`sidecar` provenance), `geoData`
 *    and `description` win when present; otherwise the importer falls back to
 *    EXIF then file mtime. Sidecars are matched robustly across Takeout's
 *    filename quirks (`name(1).jpg` ↔ `name.jpg(1).json`, truncated long names);
 *    on no match the media is still imported via the fallback — never dropped.
 *
 * Every side effect flows through the injected, sandboxed {@link ImporterDeps}
 * so the module is unit-testable with fixtures. A malformed message, a corrupt
 * sidecar, an unreadable file or a corrupt archive is reported via
 * {@link ImportContext.onSkip} (AC-15) and never aborts the run; the export is
 * untrusted DATA, so nothing it contains is ever treated as an instruction.
 */

interface MediaKind {
  mediaType: MediaType;
  mime: string;
}

// Extension → (MediaType, mime). Lowercase keys; a self-contained copy of the
// shared classification table (the folder/WhatsApp importers keep their own too)
// so a photo/clip catalogued from Takeout reads identically to one from any
// other source. Anything unlisted is treated as non-media and skipped quietly.
const EXT_INFO = new Map<string, MediaKind>([
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
  ['.mp4', { mediaType: 'video', mime: 'video/mp4' }],
  ['.m4v', { mediaType: 'video', mime: 'video/x-m4v' }],
  ['.mov', { mediaType: 'video', mime: 'video/quicktime' }],
  ['.avi', { mediaType: 'video', mime: 'video/x-msvideo' }],
  ['.mkv', { mediaType: 'video', mime: 'video/x-matroska' }],
  ['.webm', { mediaType: 'video', mime: 'video/webm' }],
  ['.wmv', { mediaType: 'video', mime: 'video/x-ms-wmv' }],
  ['.flv', { mediaType: 'video', mime: 'video/x-flv' }],
  ['.3gp', { mediaType: 'video', mime: 'video/3gpp' }],
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
  ['.pdf', { mediaType: 'document', mime: 'application/pdf' }],
  ['.doc', { mediaType: 'document', mime: 'application/msword' }],
  [
    '.docx',
    {
      mediaType: 'document',
      mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    },
  ],
  ['.txt', { mediaType: 'document', mime: 'text/plain' }],
  ['.rtf', { mediaType: 'document', mime: 'application/rtf' }],
  ['.odt', { mediaType: 'document', mime: 'application/vnd.oasis.opendocument.text' }],
]);

// Fallback for an attachment whose extension is unknown but whose MIME type is
// not one we map — keep it as a document so a forwarded file is never dropped.
const FALLBACK_KIND: MediaKind = { mediaType: 'document', mime: 'application/octet-stream' };

/** mbox message boundary: an `mboxrd` `From ` separator at the start of a line.
 *  A header line (`From:`) has no space after `From`, so it never matches. */
const MBOX_FROM_RE = /^From /;

/** mboxrd body-escape: a leading run of `>` before `From ` (`>From `, `>>From `)
 *  loses exactly ONE `>` on read, restoring the literal body line. */
const MBOXRD_ESCAPE_RE = /^>(>*From )/;

// Takeout's per-image metadata sidecar, as Google writes it. Every field is
// optional and treated as untrusted: types are checked before use.
interface TakeoutTimestamp {
  timestamp?: string | number;
  formatted?: string;
}

interface TakeoutGeoData {
  latitude?: number;
  longitude?: number;
  altitude?: number;
}

interface TakeoutSidecar {
  title?: string;
  description?: string;
  photoTakenTime?: TakeoutTimestamp;
  creationTime?: TakeoutTimestamp;
  geoData?: TakeoutGeoData;
}

interface DiscoveredFile {
  absPath: string;
  /** Stable id WITHIN this source: POSIX relative path (folder) or archive entry path (zip). */
  sourceRef: string;
  /** From the folder walk; null for zip entries (statted lazily, only if needed). */
  stat: FileStat | null;
  /**
   * True for a file the guarded extractor already wrote to scratch from a `.zip`.
   * Such a file is read back through the fs seam; a user's own (possibly multi-GB)
   * folder mbox is instead streamed via {@link FsLike.openReadStream} (AC-11).
   */
  fromArchive: boolean;
}

interface Discovery {
  files: DiscoveredFile[];
  /** A hard discovery failure (corrupt archive / unreadable input) already reported via onSkip. */
  failed: boolean;
}

function isZip(inputPath: string): boolean {
  return inputPath.toLowerCase().endsWith('.zip');
}

function isMbox(inputPath: string): boolean {
  return inputPath.toLowerCase().endsWith('.mbox');
}

function classify(filename: string): MediaKind | null {
  return EXT_INFO.get(extname(filename).toLowerCase()) ?? null;
}

/** Classify an mbox attachment by its declared MIME type when the filename
 *  extension is unknown — so a `Content-Type: image/...` part is still a photo. */
function classifyMime(contentType: string | undefined): MediaKind | null {
  if (!contentType) return null;
  const ct = contentType.toLowerCase().split(';')[0].trim();
  if (ct.startsWith('image/')) return { mediaType: 'photo', mime: ct };
  if (ct.startsWith('video/')) return { mediaType: 'video', mime: ct };
  if (ct.startsWith('audio/')) return { mediaType: 'audio', mime: ct };
  if (ct) return { mediaType: 'document', mime: ct };
  return null;
}

function toPosix(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/');
}

/** Path relative to the imported root, normalized to POSIX so `sourceRef` is
 *  identical across platforms (stable for idempotent re-import). */
function toSourceRef(root: string, absPath: string): string {
  return toPosix(relative(root, absPath));
}

/** Parent path segment of a POSIX sourceRef — the Takeout album / folder name. */
function parentSegment(sourceRef: string): string | null {
  const parts = sourceRef.split('/').filter((s) => s.length > 0);
  return parts.length >= 2 ? parts[parts.length - 2] : null;
}

/** Make a single, filesystem-safe path segment from an arbitrary name. */
function sanitizeSegment(name: string): string {
  const cleaned = name.replace(/[^\w.()-]+/g, '_');
  return cleaned.length > 0 ? cleaned : 'unnamed';
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
    // is still catalogued with its sidecar/mtime date.
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

async function statSafe(deps: ImporterDeps, absPath: string): Promise<FileStat | null> {
  try {
    return await deps.fs.stat(absPath);
  } catch {
    return null;
  }
}

function toGps(exif: ExifData | null): CatalogRecord['gps'] {
  if (!exif?.gps) {
    return null;
  }
  const { lat, lon, alt } = exif.gps;
  return alt === undefined ? { lat, lon } : { lat, lon, alt };
}

function unescapeMboxrd(line: string): string {
  return line.replace(MBOXRD_ESCAPE_RE, '$1');
}

/** A block has real content if any accumulated line is non-blank (a trailing
 *  blank line from the mboxrd framing alone is not a message). */
function hasContent(lines: string[]): boolean {
  return lines.some((line) => line.trim().length > 0);
}

function addressText(addr: AddressObject | AddressObject[] | undefined): string | undefined {
  if (!addr) return undefined;
  if (Array.isArray(addr)) return addr.map((a) => a.text).join(', ');
  return addr.text;
}

function timestampToDate(ts: TakeoutTimestamp | undefined): Date | null {
  const raw = ts?.timestamp;
  if (raw === undefined || raw === null) return null;
  const secs = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(secs)) return null;
  return new Date(secs * 1000);
}

/** Sidecar capture date: `photoTakenTime` wins over `creationTime`. */
function sidecarDate(sidecar: TakeoutSidecar | null): Date | null {
  if (!sidecar) return null;
  return timestampToDate(sidecar.photoTakenTime) ?? timestampToDate(sidecar.creationTime);
}

function sidecarGps(sidecar: TakeoutSidecar | null): CatalogRecord['gps'] {
  const geo = sidecar?.geoData;
  if (!geo) return null;
  const lat = typeof geo.latitude === 'number' ? geo.latitude : Number.NaN;
  const lon = typeof geo.longitude === 'number' ? geo.longitude : Number.NaN;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  // Google writes 0/0 for "no location" — treat it as absent, not the Gulf of Guinea.
  if (lat === 0 && lon === 0) return null;
  const alt = typeof geo.altitude === 'number' ? geo.altitude : 0;
  return Number.isFinite(alt) && alt !== 0 ? { lat, lon, alt } : { lat, lon };
}

function sidecarDescription(sidecar: TakeoutSidecar | null): string | null {
  const desc = sidecar?.description;
  return typeof desc === 'string' && desc.length > 0 ? desc : null;
}

/**
 * Match a media file to its Takeout JSON sidecar within the same directory,
 * tolerating Google's filename mangling. In order of confidence:
 *  1. the canonical `media.ext.json`;
 *  2. the duplicate-counter swap `name(1).jpg` ↔ `name.jpg(1).json`;
 *  3. a truncation fallback — the longest sidecar stem that prefixes the media
 *     name (Takeout clips very long names). Returns null on no match so the
 *     caller falls back to EXIF/mtime instead of dropping or mis-pairing.
 */
function findSidecarName(mediaName: string, jsonNames: readonly string[]): string | null {
  const set = new Set(jsonNames);

  const direct = `${mediaName}.json`;
  if (set.has(direct)) return direct;

  const dup = /^(.*)\((\d+)\)(\.[^.]+)$/.exec(mediaName);
  if (dup) {
    const candidate = `${dup[1]}${dup[3]}(${dup[2]}).json`;
    if (set.has(candidate)) return candidate;
  }

  let best: string | null = null;
  let bestLen = -1;
  for (const json of jsonNames) {
    if (!json.toLowerCase().endsWith('.json')) continue;
    const stem = json.slice(0, json.length - '.json'.length);
    if (stem.length >= 4 && mediaName.startsWith(stem) && stem.length > bestLen) {
      best = json;
      bestLen = stem.length;
    }
  }
  return best;
}

/** Depth-first folder discovery over the injected fs. Unreadable directories /
 *  entries are reported (AC-15) and never thrown; the signal stops the walk. */
async function* walkFolder(
  dir: string,
  root: string,
  ctx: ImportContext,
  skipped: SkippedItem[],
): AsyncGenerator<DiscoveredFile> {
  if (ctx.signal.aborted) return;

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
    if (ctx.signal.aborted) return;
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
      yield* walkFolder(child, root, ctx, skipped);
    } else if (stat.isFile()) {
      yield { absPath: child, sourceRef: toSourceRef(root, child), stat, fromArchive: false };
    }
  }
}

/** Resolve the dropped path to a flat list of files: extract a zip via the
 *  guarded extractor, walk a folder, or take a standalone `.mbox`. */
async function discover(
  inputPath: string,
  ctx: ImportContext,
  skipped: SkippedItem[],
): Promise<Discovery> {
  if (isZip(inputPath)) {
    let entries: readonly { entryPath: string; absPath: string }[];
    try {
      entries = await ctx.deps.extractArchive(inputPath, ctx.workDir);
    } catch (error) {
      // AC-15: a corrupt / locked / unreadable archive is reported and the run
      // returns its partial result — it never throws out to abort the import.
      recordSkip(
        ctx,
        skipped,
        inputPath,
        `could not extract the Takeout archive: ${errorMessage(error)}`,
        'E_EXTRACT',
      );
      return { files: [], failed: true };
    }
    const files = entries.map((entry) => ({
      absPath: entry.absPath,
      sourceRef: toPosix(entry.entryPath),
      stat: null,
      fromArchive: true,
    }));
    return { files, failed: false };
  }

  let stat: FileStat;
  try {
    stat = await ctx.deps.fs.stat(inputPath);
  } catch (error) {
    recordSkip(ctx, skipped, inputPath, `unreadable input: ${errorMessage(error)}`, 'E_STAT');
    return { files: [], failed: true };
  }

  if (stat.isFile()) {
    return {
      files: [{ absPath: inputPath, sourceRef: basename(inputPath), stat, fromArchive: false }],
      failed: false,
    };
  }
  if (stat.isDirectory()) {
    const files: DiscoveredFile[] = [];
    for await (const file of walkFolder(inputPath, inputPath, ctx, skipped)) {
      files.push(file);
    }
    return { files, failed: false };
  }
  return { files: [], failed: false };
}

/** dir → (sidecar basename → absolute path), for per-directory sidecar lookup. */
function buildJsonIndex(files: readonly DiscoveredFile[]): Map<string, Map<string, string>> {
  const index = new Map<string, Map<string, string>>();
  for (const file of files) {
    if (extname(file.absPath).toLowerCase() !== '.json') continue;
    const dir = dirname(file.absPath);
    let inDir = index.get(dir);
    if (!inDir) {
      inDir = new Map<string, string>();
      index.set(dir, inDir);
    }
    inDir.set(basename(file.absPath), file.absPath);
  }
  return index;
}

async function loadSidecar(
  jsonAbsPath: string,
  ref: string,
  ctx: ImportContext,
  skipped: SkippedItem[],
): Promise<TakeoutSidecar | null> {
  let raw: string;
  try {
    raw = (await ctx.deps.fs.readFile(jsonAbsPath)).toString('utf8');
  } catch (error) {
    recordSkip(ctx, skipped, ref, `unreadable sidecar: ${errorMessage(error)}`, 'E_SIDECAR');
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as TakeoutSidecar) : null;
  } catch (error) {
    // A corrupt sidecar is reported (AC-15) and the media is still imported via
    // the EXIF / mtime fallback — never dropped for a bad bit of JSON.
    recordSkip(ctx, skipped, ref, `corrupt sidecar JSON: ${errorMessage(error)}`, 'E_SIDECAR');
    return null;
  }
}

function pickPhotoDate(
  sidecar: TakeoutSidecar | null,
  exif: ExifData | null,
  stat: FileStat | null,
): { value: Date; source: RecordDateSource } | null {
  const sidecarValue = sidecarDate(sidecar);
  if (sidecarValue) return { value: sidecarValue, source: 'sidecar' };
  if (exif?.takenAt) return { value: exif.takenAt, source: 'exif' };
  if (stat) return { value: new Date(stat.mtimeMs), source: 'mtime' };
  return null;
}

function buildMediaMeta(
  sidecar: TakeoutSidecar | null,
  exif: ExifData | null,
  media: MediaInfo | null,
  sourceRef: string,
): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  const album = parentSegment(sourceRef);
  if (album) meta.album = album;
  if (typeof sidecar?.title === 'string' && sidecar.title.length > 0) meta.title = sidecar.title;
  if (exif?.cameraMake) meta.cameraMake = exif.cameraMake;
  if (exif?.cameraModel) meta.cameraModel = exif.cameraModel;
  const width = exif?.width ?? media?.width ?? null;
  const height = exif?.height ?? media?.height ?? null;
  if (width !== null) meta.width = width;
  if (height !== null) meta.height = height;
  return meta;
}

async function buildMediaRecord(
  file: DiscoveredFile,
  kind: MediaKind,
  sidecar: TakeoutSidecar | null,
  ctx: ImportContext,
): Promise<CatalogRecord> {
  const exif = kind.mediaType === 'photo' ? await readExifSafe(ctx.deps, file.absPath) : null;
  const media =
    kind.mediaType === 'video' || kind.mediaType === 'audio'
      ? await probeMediaSafe(ctx.deps, file.absPath)
      : null;
  const stat = file.stat ?? (await statSafe(ctx.deps, file.absPath));

  return {
    sourceType: 'google_takeout',
    mediaType: kind.mediaType,
    originalPath: file.absPath,
    mimeType: media?.mimeType ?? kind.mime,
    date: pickPhotoDate(sidecar, exif, stat),
    author: null,
    body: sidecarDescription(sidecar),
    gps: sidecarGps(sidecar) ?? toGps(exif),
    durationSec: media?.durationSec ?? null,
    sourceRef: file.sourceRef,
    sourceMeta: buildMediaMeta(sidecar, exif, media, file.sourceRef),
  };
}

/** Materialize one mbox attachment into scratch and build its media record, so
 *  the worker can hash + content-address the bytes exactly like an archive
 *  original (§4.4). Returns null (with a skip) only if the bytes can't be written. */
async function buildAttachmentRecord(
  att: Attachment,
  file: DiscoveredFile,
  messageIndex: number,
  attIndex: number,
  emailDate: Date | null,
  emailAuthor: string | null,
  ctx: ImportContext,
  skipped: SkippedItem[],
): Promise<CatalogRecord | null> {
  const ref = `${file.sourceRef}#${messageIndex}/att/${attIndex}`;
  const fileName =
    att.filename && att.filename.trim().length > 0
      ? att.filename
      : `attachment-${messageIndex}-${attIndex}`;
  const kind = classify(fileName) ?? classifyMime(att.contentType) ?? FALLBACK_KIND;
  const content = Buffer.isBuffer(att.content) ? att.content : Buffer.from(att.content ?? []);

  const scratchPath = join(
    ctx.workDir,
    'takeout-mbox-attachments',
    sanitizeSegment(basename(file.sourceRef)),
    `${messageIndex}-${attIndex}-${sanitizeSegment(basename(fileName))}`,
  );

  const writeFile = ctx.deps.fs.writeFile;
  if (!writeFile) {
    recordSkip(ctx, skipped, ref, 'cannot materialize attachment: writeFile seam unavailable', 'E_WRITE_ATTACH');
    return null;
  }
  try {
    await writeFile(scratchPath, content);
  } catch (error) {
    recordSkip(ctx, skipped, ref, `could not write attachment: ${errorMessage(error)}`, 'E_WRITE_ATTACH');
    return null;
  }

  const exif = kind.mediaType === 'photo' ? await readExifSafe(ctx.deps, scratchPath) : null;
  const media =
    kind.mediaType === 'video' || kind.mediaType === 'audio'
      ? await probeMediaSafe(ctx.deps, scratchPath)
      : null;

  let date: { value: Date; source: RecordDateSource } | null = null;
  if (exif?.takenAt) {
    date = { value: exif.takenAt, source: 'exif' };
  } else if (emailDate) {
    // No capture metadata of its own — inherit the email's date (provenance message).
    date = { value: emailDate, source: 'message' };
  }

  return {
    sourceType: 'google_takeout',
    mediaType: kind.mediaType,
    originalPath: scratchPath,
    mimeType: media?.mimeType ?? kind.mime,
    date,
    author: emailAuthor,
    body: null,
    gps: toGps(exif),
    durationSec: media?.durationSec ?? null,
    sourceRef: ref,
    sourceMeta: {
      attachmentFileName: fileName,
      mbox: file.sourceRef,
      messageIndex,
    },
  };
}

/** Parse one assembled RFC-822 block and emit its email record plus any
 *  attachment records. A block that won't parse, or that has no recognizable
 *  headers (the adversarial garbage case), is reported E_PARSE_MSG and skipped. */
async function* emitMessage(
  lines: string[],
  messageIndex: number,
  file: DiscoveredFile,
  ctx: ImportContext,
  skipped: SkippedItem[],
): AsyncGenerator<CatalogRecord> {
  if (ctx.signal.aborted) return;
  const ref = `${file.sourceRef}#${messageIndex}`;

  let parsed: ParsedMail;
  try {
    parsed = await simpleParser(Buffer.from(lines.join('\n'), 'utf8'));
  } catch (error) {
    recordSkip(ctx, skipped, ref, `malformed message: ${errorMessage(error)}`, 'E_PARSE_MSG');
    return;
  }

  // A real Gmail message always has headers; a block with none is noise between
  // separators (truncation, binary junk) — skip it, never abort the run.
  const hasHeaders = Boolean(
    parsed.from || parsed.to || parsed.subject || parsed.date || parsed.messageId,
  );
  if (!hasHeaders) {
    recordSkip(ctx, skipped, ref, 'message has no recognizable headers', 'E_PARSE_MSG');
    return;
  }

  const author = parsed.from?.text ?? null;
  const subject = typeof parsed.subject === 'string' ? parsed.subject : null;
  const text = typeof parsed.text === 'string' ? parsed.text : '';
  const emailDate = parsed.date ?? null;

  // Subject leads the body so it is searchable FTS text, then the plaintext.
  const bodyParts: string[] = [];
  if (subject) bodyParts.push(subject);
  if (text.trim().length > 0) bodyParts.push(text);
  const body = bodyParts.length > 0 ? bodyParts.join('\n') : null;

  const sourceMeta: Record<string, unknown> = { mbox: file.sourceRef, messageIndex };
  if (subject) sourceMeta.subject = subject;
  if (author) sourceMeta.from = author;
  if (parsed.messageId) sourceMeta.messageId = parsed.messageId;
  const to = addressText(parsed.to);
  if (to) sourceMeta.to = to;

  yield {
    sourceType: 'google_takeout',
    mediaType: 'message',
    originalPath: null,
    mimeType: null,
    date: emailDate ? { value: emailDate, source: 'message' } : null,
    author,
    body,
    gps: null,
    durationSec: null,
    sourceRef: ref,
    sourceMeta,
  };

  for (let attIndex = 0; attIndex < parsed.attachments.length; attIndex++) {
    if (ctx.signal.aborted) return;
    const record = await buildAttachmentRecord(
      parsed.attachments[attIndex],
      file,
      messageIndex,
      attIndex,
      emailDate,
      author,
      ctx,
      skipped,
    );
    if (record) yield record;
  }
}

/** Stream a `.mbox` file message-by-message over the read-stream seam, splitting
 *  on `From ` separators (mboxrd). The whole file is never buffered (AC-11). */
async function* streamMboxRecords(
  file: DiscoveredFile,
  ctx: ImportContext,
  skipped: SkippedItem[],
): AsyncGenerator<CatalogRecord> {
  let stream: Readable | undefined;
  const opener = ctx.deps.fs.openReadStream;
  if (!file.fromArchive && opener) {
    // The user's own mbox: stream it so a multi-GB mailbox is never buffered (AC-11).
    try {
      stream = opener(file.absPath);
    } catch (error) {
      recordSkip(ctx, skipped, file.sourceRef, `could not open mbox: ${errorMessage(error)}`, 'E_READ_MBOX');
      return;
    }
  } else {
    // A zip-extracted mbox (already materialized to scratch by the guarded
    // extractor) or a seam without streaming support: read the bytes back.
    try {
      stream = Readable.from(await ctx.deps.fs.readFile(file.absPath));
    } catch (error) {
      recordSkip(ctx, skipped, file.sourceRef, `could not read mbox: ${errorMessage(error)}`, 'E_READ_MBOX');
      return;
    }
  }

  const rl = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
  let current: string[] = [];
  let messageIndex = 0;
  try {
    for await (const line of rl) {
      if (ctx.signal.aborted) break;
      if (MBOX_FROM_RE.test(line)) {
        if (hasContent(current)) {
          yield* emitMessage(current, messageIndex, file, ctx, skipped);
          messageIndex += 1;
        }
        current = [];
      } else {
        current.push(unescapeMboxrd(line));
      }
    }
    if (!ctx.signal.aborted && hasContent(current)) {
      yield* emitMessage(current, messageIndex, file, ctx, skipped);
    }
  } catch (error) {
    // A mid-stream read error (e.g. the file vanished) is reported, not thrown;
    // any messages already emitted are preserved (AC-15).
    recordSkip(ctx, skipped, file.sourceRef, `could not read mbox: ${errorMessage(error)}`, 'E_READ_MBOX');
  } finally {
    rl.close();
    stream.destroy();
  }
}

export const takeoutImporter: Importer = {
  id: 'google_takeout',
  displayName: 'Google Takeout',

  async canHandle(inputPath: string, deps: ImporterDeps): Promise<boolean> {
    try {
      if (isMbox(inputPath)) {
        return await deps.fs.exists(inputPath);
      }
      if (isZip(inputPath)) {
        // The zip's central directory stores entry names verbatim, so a byte
        // scan recognizes a Takeout export without extracting it.
        const buffer = await deps.fs.readFile(inputPath);
        return (
          buffer.includes('Takeout/') ||
          buffer.includes('archive_browser.html') ||
          buffer.includes('.mbox')
        );
      }
      const stat = await deps.fs.stat(inputPath);
      if (!stat.isDirectory()) return false;

      let names: readonly string[];
      try {
        names = await deps.fs.readDir(inputPath);
      } catch {
        return false;
      }
      const lower = names.map((n) => n.toLowerCase());
      if (lower.includes('archive_browser.html')) return true;
      if (names.includes('Mail') || names.includes('Google Photos')) return true;
      if (basename(inputPath) === 'Takeout') return true;
      if (lower.some((n) => n.endsWith('.mbox'))) return true;
      // A bare Google Photos album: media files alongside their JSON sidecars.
      const hasJson = lower.some((n) => n.endsWith('.json'));
      const hasMedia = names.some((n) => classify(n) !== null);
      return hasJson && hasMedia;
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
    if (ctx.signal.aborted) {
      return { recordCount, skipped };
    }

    const discovery = await discover(inputPath, ctx, skipped);
    if (discovery.failed || ctx.signal.aborted) {
      return { recordCount, skipped };
    }

    // Pass 1 — Gmail mailboxes (streamed message-by-message).
    for (const file of discovery.files) {
      if (ctx.signal.aborted) break;
      if (!isMbox(file.absPath)) continue;
      for await (const record of streamMboxRecords(file, ctx, skipped)) {
        if (ctx.signal.aborted) break;
        recordCount += 1;
        ctx.onProgress({ phase: 'emit', processed: recordCount, total: null });
        yield record;
      }
    }

    // Pass 2 — Google Photos media + sidecars.
    if (!ctx.signal.aborted) {
      const jsonIndex = buildJsonIndex(discovery.files);
      for (const file of discovery.files) {
        if (ctx.signal.aborted) break;
        const kind = classify(file.absPath);
        if (!kind) continue; // sidecars, mbox, html and unknowns are not media

        let sidecar: TakeoutSidecar | null = null;
        const dirJsons = jsonIndex.get(dirname(file.absPath));
        if (dirJsons && dirJsons.size > 0) {
          const match = findSidecarName(basename(file.absPath), [...dirJsons.keys()]);
          const jsonAbsPath = match ? dirJsons.get(match) : undefined;
          if (jsonAbsPath) {
            sidecar = await loadSidecar(jsonAbsPath, file.sourceRef, ctx, skipped);
          }
        }

        const record = await buildMediaRecord(file, kind, sidecar, ctx);
        recordCount += 1;
        ctx.onProgress({ phase: 'emit', processed: recordCount, total: null });
        yield record;
      }
    }

    return { recordCount, skipped };
  },
};
