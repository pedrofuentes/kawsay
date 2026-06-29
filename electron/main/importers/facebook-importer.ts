import { basename, extname, join, relative, sep } from 'node:path';
import type { MediaType } from '@shared/catalog';
import type {
  CatalogRecord,
  ImportContext,
  Importer,
  ImporterDeps,
  ImportResult,
  MediaInfo,
  SkippedItem,
} from './types';
import { zipHasEntryName } from './zip-markers';

/**
 * Card C5 (AC-16): the Facebook **"Download Your Information"** connector. The
 * export is a `.zip` of JSON — posts, message threads, and photo albums — opened
 * through the injected, zip-slip-guarded {@link ImporterDeps.extractArchive}
 * (never a raw unzip) or read from a folder the user already extracted.
 *
 * Two Facebook-specific quirks drive this module:
 *
 *  1. **Mojibake.** FB DYI serializes every string as UTF-8 **bytes**, each
 *     escaped as its own `\u00XX` code unit. A naive `JSON.parse` therefore
 *     yields a string whose char codes ARE those bytes — so "José" arrives as
 *     "JosÃ©" and an emoji as four garbled chars. {@link decodeFacebookText}
 *     re-reads the latin1 bytes as UTF-8 so names and messages are faithful — a
 *     non-negotiable for a memorial archive.
 *  2. **Timestamps.** Posts `timestamp` and media `creation_timestamp` are Unix **seconds**;
 *     message `timestamp_ms` is Unix **milliseconds**. Both are canonicalized to
 *     a UTC instant with `message` provenance.
 *
 * Media is linked by resolving each relative `uri` **against the files the
 * guarded extractor actually produced** (or that a folder walk discovered) — the
 * importer never builds a filesystem path from the untrusted uri, so a reference
 * can only ever point inside the extract root. Every side effect goes through the
 * injected {@link ImporterDeps}; a malformed entry, an unreadable file, a corrupt
 * archive, or a missing media file is reported via {@link ImportContext.onSkip}
 * (AC-15) and never aborts the run. No post or message is silently dropped: a
 * post keeps its text AND each attachment as records, and a contentless message
 * is still catalogued.
 */

/**
 * Re-decode a Facebook DYI string from its latin1-escaped form to faithful
 * UTF-8. FB escapes each UTF-8 byte as a separate `\u00XX` unit, so the parsed
 * string's char codes are the original bytes; reading them back as UTF-8 (latin1
 * → utf8) recovers the true text. Pure-ASCII input is returned unchanged, and a
 * byte run that is not valid UTF-8 (which FB DYI never produces) is left as-is,
 * so the function is a safe no-op on already-correct text — it never
 * double-decodes genuine Unicode.
 */
export function decodeFacebookText(raw: string): string {
  let hasHighByte = false;
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    if (code > 0xff) return raw; // genuine Unicode code point → not byte-escaped
    if (code >= 0x80) hasHighByte = true;
  }
  if (!hasHighByte) return raw; // pure ASCII → already faithful
  const decoded = Buffer.from(raw, 'latin1').toString('utf8');
  if (decoded.includes('\uFFFD') && !raw.includes('\uFFFD')) return raw;
  return decoded;
}

interface MediaKind {
  mediaType: MediaType;
  mime: string;
}

// Extension → (MediaType, mime). Mirrors the other importers' tables so a photo
// catalogued from two sources reads identically; an unknown extension falls back
// to `document` so a referenced file is still catalogued, never dropped.
const EXT_INFO = new Map<string, MediaKind>([
  ['.jpg', { mediaType: 'photo', mime: 'image/jpeg' }],
  ['.jpeg', { mediaType: 'photo', mime: 'image/jpeg' }],
  ['.png', { mediaType: 'photo', mime: 'image/png' }],
  ['.gif', { mediaType: 'photo', mime: 'image/gif' }],
  ['.webp', { mediaType: 'photo', mime: 'image/webp' }],
  ['.bmp', { mediaType: 'photo', mime: 'image/bmp' }],
  ['.heic', { mediaType: 'photo', mime: 'image/heic' }],
  ['.tiff', { mediaType: 'photo', mime: 'image/tiff' }],
  ['.mp4', { mediaType: 'video', mime: 'video/mp4' }],
  ['.mov', { mediaType: 'video', mime: 'video/quicktime' }],
  ['.m4v', { mediaType: 'video', mime: 'video/x-m4v' }],
  ['.avi', { mediaType: 'video', mime: 'video/x-msvideo' }],
  ['.mkv', { mediaType: 'video', mime: 'video/x-matroska' }],
  ['.webm', { mediaType: 'video', mime: 'video/webm' }],
  ['.3gp', { mediaType: 'video', mime: 'video/3gpp' }],
  ['.mp3', { mediaType: 'audio', mime: 'audio/mpeg' }],
  ['.m4a', { mediaType: 'audio', mime: 'audio/mp4' }],
  ['.aac', { mediaType: 'audio', mime: 'audio/aac' }],
  ['.ogg', { mediaType: 'audio', mime: 'audio/ogg' }],
  ['.opus', { mediaType: 'audio', mime: 'audio/opus' }],
  ['.wav', { mediaType: 'audio', mime: 'audio/wav' }],
  ['.pdf', { mediaType: 'document', mime: 'application/pdf' }],
  ['.txt', { mediaType: 'document', mime: 'text/plain' }],
]);

const FALLBACK_KIND: MediaKind = { mediaType: 'document', mime: 'application/octet-stream' };

// Markers Facebook DYI exports carry in their zip central directory / folder
// layout — distinct from any other source so canHandle never mis-claims a
// LinkedIn or Takeout archive.
const FB_ZIP_MARKERS = [
  'your_posts',
  'messages/inbox',
  'your_activity_across_facebook',
  'your_facebook_activity',
];
const FB_DIR_MARKERS = [
  'your_activity_across_facebook',
  join('messages', 'inbox'),
  join('posts', 'your_posts_1.json'),
];

type RecordDate = CatalogRecord['date'];

interface Entry {
  /** POSIX path of the entry within the archive / relative to the folder root. */
  entryPath: string;
  /** Absolute path on disk (under the scratch dir for archives; in place for folders). */
  absPath: string;
}

function isZip(inputPath: string): boolean {
  return inputPath.toLowerCase().endsWith('.zip');
}

function toPosix(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/');
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Decode + collapse-to-null one FB string field (faithful text, never mojibake). */
function fbText(value: unknown): string | null {
  const raw = asString(value);
  if (raw === null) return null;
  const decoded = decodeFacebookText(raw);
  return decoded.length > 0 ? decoded : null;
}

function classify(uriOrName: string): MediaKind {
  return EXT_INFO.get(extname(uriOrName).toLowerCase()) ?? FALLBACK_KIND;
}

/**
 * Build a `message`-sourced date, **nulling an out-of-range / Invalid Date**.
 * `asFiniteNumber` only rejects NaN/Infinity, so a finite-but-absurd timestamp
 * (a corrupt value in an untrusted export) still yields a JS `Invalid Date`.
 * Emitting that across the importer boundary is data-loss-class: the downstream
 * ingest consumer renders every date via `toIsoUtc` → `Date.toISOString()`,
 * which throws `RangeError: Invalid time value` with no per-record catch and
 * aborts the whole import (the WhatsApp failure AC-15 exists to prevent). A bad
 * timestamp instead leaves the record undated (`null`) — kept, never dropped.
 */
function messageDate(ms: number | null): RecordDate {
  if (ms === null) return null;
  const value = new Date(ms);
  return Number.isFinite(value.getTime()) ? { value, source: 'message' } : null;
}

function secondsDate(value: unknown): RecordDate {
  const sec = asFiniteNumber(value);
  return messageDate(sec === null ? null : sec * 1000);
}

function msDate(value: unknown): RecordDate {
  return messageDate(asFiniteNumber(value));
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

async function probeSafe(deps: ImporterDeps, absPath: string): Promise<MediaInfo | null> {
  try {
    return await deps.probeMedia(absPath);
  } catch {
    return null;
  }
}

/** Resolve relative media `uri`s only against files that were safely extracted /
 *  discovered — the untrusted uri is never turned into a filesystem path. */
function buildResolver(entries: readonly Entry[]): (uri: string) => string | null {
  const byEntry = new Map<string, string>();
  const byBase = new Map<string, string>();
  const bySuffix = new Map<string, string | null>();
  for (const entry of entries) {
    byEntry.set(entry.entryPath, entry.absPath);
    byBase.set(basename(entry.entryPath), entry.absPath);
    const parts = entry.entryPath.split('/').filter((part) => part.length > 0);
    for (let i = 0; i < parts.length; i++) {
      const suffix = parts.slice(i).join('/');
      const existing = bySuffix.get(suffix);
      if (existing === undefined) bySuffix.set(suffix, entry.absPath);
      else if (existing !== entry.absPath) bySuffix.set(suffix, null);
    }
  }
  return (uri: string): string | null => {
    const norm = toPosix(uri).replace(/^\.?\//, '');
    const direct = byEntry.get(norm);
    if (direct !== undefined) return direct;
    const suffix = bySuffix.get(norm);
    if (suffix !== undefined) return suffix;
    return byBase.get(basename(norm)) ?? null;
  };
}

/** Depth-first file discovery over the injected fs for the folder (in-place) path. */
async function* walkFolder(
  dir: string,
  ctx: ImportContext,
  skipped: SkippedItem[],
): AsyncGenerator<string> {
  if (ctx.signal.aborted) return;
  let names: readonly string[];
  try {
    names = await ctx.deps.fs.readDir(dir);
  } catch (error) {
    recordSkip(ctx, skipped, dir, `unreadable directory: ${errorMessage(error)}`, 'E_READDIR');
    return;
  }
  for (const name of names) {
    if (ctx.signal.aborted) return;
    const child = join(dir, name);
    try {
      const stat = await ctx.deps.fs.stat(child);
      if (stat.isDirectory()) {
        yield* walkFolder(child, ctx, skipped);
      } else if (stat.isFile()) {
        yield child;
      }
    } catch (error) {
      recordSkip(ctx, skipped, child, `unreadable entry: ${errorMessage(error)}`, 'E_STAT');
    }
  }
}

async function gatherEntries(
  inputPath: string,
  ctx: ImportContext,
  skipped: SkippedItem[],
): Promise<{ entries: Entry[]; discoveryFailed: boolean }> {
  if (isZip(inputPath)) {
    try {
      const extracted = await ctx.deps.extractArchive(inputPath, ctx.workDir, {
        signal: ctx.signal,
      });
      return {
        entries: extracted.map((e) => ({ entryPath: toPosix(e.entryPath), absPath: e.absPath })),
        discoveryFailed: false,
      };
    } catch (error) {
      recordSkip(
        ctx,
        skipped,
        inputPath,
        `could not extract the Facebook archive: ${errorMessage(error)}`,
        'E_EXTRACT',
      );
      return { entries: [], discoveryFailed: true };
    }
  }
  const entries: Entry[] = [];
  for await (const abs of walkFolder(inputPath, ctx, skipped)) {
    entries.push({ entryPath: toPosix(relative(inputPath, abs)), absPath: abs });
  }
  return { entries, discoveryFailed: false };
}

function isPostsFile(entryPath: string): boolean {
  return /(^|\/)your_posts[^/]*\.json$/i.test(entryPath);
}

function isMessageFile(entryPath: string): boolean {
  return /(^|\/)message_\d+\.json$/i.test(entryPath);
}

function isAlbumFile(entryPath: string): boolean {
  return (
    /(^|\/)album\/\d+\.json$/i.test(entryPath) || /(^|\/)your_photos[^/]*\.json$/i.test(entryPath)
  );
}

/** Read + JSON-parse one export file, reporting E_READ / E_PARSE instead of throwing. */
async function readJson(
  entry: Entry,
  ctx: ImportContext,
  skipped: SkippedItem[],
): Promise<unknown | undefined> {
  let text: string;
  try {
    text = stripBom((await ctx.deps.fs.readFile(entry.absPath)).toString('utf8'));
  } catch (error) {
    recordSkip(ctx, skipped, entry.entryPath, `could not read: ${errorMessage(error)}`, 'E_READ');
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    recordSkip(ctx, skipped, entry.entryPath, `malformed JSON: ${errorMessage(error)}`, 'E_PARSE');
    return undefined;
  }
}

/** The FB posts file is normally an array; some versions wrap it under one key. */
function asPostArray(parsed: unknown): readonly unknown[] {
  if (Array.isArray(parsed)) return parsed;
  if (isObject(parsed)) {
    for (const value of Object.values(parsed)) {
      if (Array.isArray(value)) return value;
    }
  }
  return [];
}

interface BuildMediaArgs {
  media: Record<string, unknown>;
  sourceRef: string;
  date: RecordDate;
  author: string | null;
  sourceMeta: Record<string, unknown>;
}

/** Build one media record, linking it to its extracted file. A media object with
 *  no `uri`, or a `uri` absent from the export, is reported and yields no record. */
async function buildMediaRecord(
  args: BuildMediaArgs,
  resolve: (uri: string) => string | null,
  deps: ImporterDeps,
  ctx: ImportContext,
  skipped: SkippedItem[],
): Promise<CatalogRecord | null> {
  const uri = asString(args.media.uri);
  if (uri === null || uri.trim() === '') {
    recordSkip(ctx, skipped, args.sourceRef, 'media entry has no uri', 'E_PARSE');
    return null;
  }
  const absPath = resolve(uri);
  if (absPath === null) {
    recordSkip(ctx, skipped, uri, 'referenced media is missing from the export', 'E_MISSING_MEDIA');
    return null;
  }
  const kind = classify(uri);
  const caption = fbText(args.media.description) ?? fbText(args.media.title);
  const probed =
    kind.mediaType === 'video' || kind.mediaType === 'audio'
      ? await probeSafe(deps, absPath)
      : null;
  return {
    sourceType: 'facebook',
    mediaType: kind.mediaType,
    originalPath: absPath,
    mimeType: probed?.mimeType ?? kind.mime,
    date: args.date,
    author: args.author,
    body: caption,
    gps: null,
    durationSec: probed?.durationSec ?? null,
    sourceRef: args.sourceRef,
    sourceMeta: { ...args.sourceMeta, uri },
  };
}

function postTextRecord(body: string | null, date: RecordDate, sourceRef: string): CatalogRecord {
  return {
    sourceType: 'facebook',
    mediaType: 'message',
    originalPath: null,
    mimeType: null,
    date,
    author: null,
    body,
    gps: null,
    durationSec: null,
    sourceRef,
    sourceMeta: { kind: 'post' },
  };
}

function messageTextRecord(
  body: string | null,
  date: RecordDate,
  author: string | null,
  sourceRef: string,
  meta: Record<string, unknown>,
): CatalogRecord {
  return {
    sourceType: 'facebook',
    mediaType: 'message',
    originalPath: null,
    mimeType: null,
    date,
    author,
    body,
    gps: null,
    durationSec: null,
    sourceRef,
    sourceMeta: { kind: 'message', ...meta },
  };
}

/** Collect every `media` object attached to a post (attachments[].data[].media
 *  and the occasional data[].media). */
function collectPostMedia(post: Record<string, unknown>): Record<string, unknown>[] {
  const media: Record<string, unknown>[] = [];
  for (const attachment of asArray(post.attachments)) {
    if (!isObject(attachment)) continue;
    for (const datum of asArray(attachment.data)) {
      if (isObject(datum) && isObject(datum.media)) media.push(datum.media);
    }
  }
  for (const datum of asArray(post.data)) {
    if (isObject(datum) && isObject(datum.media)) media.push(datum.media);
  }
  return media;
}

async function* parsePostsFile(
  entry: Entry,
  resolve: (uri: string) => string | null,
  deps: ImporterDeps,
  ctx: ImportContext,
  skipped: SkippedItem[],
): AsyncGenerator<CatalogRecord> {
  const parsed = await readJson(entry, ctx, skipped);
  if (parsed === undefined) return;

  const posts = asPostArray(parsed);
  for (let i = 0; i < posts.length; i++) {
    const post = posts[i];
    if (!isObject(post)) {
      recordSkip(ctx, skipped, `${entry.entryPath}#${i}`, 'post entry is not an object', 'E_PARSE');
      continue;
    }
    const postDate = secondsDate(post.timestamp);
    const textParts: string[] = [];
    for (const datum of asArray(post.data)) {
      if (!isObject(datum)) continue;
      const text = fbText(datum.post);
      if (text !== null) textParts.push(text);
    }
    const body = textParts.length > 0 ? textParts.join('\n') : null;

    let emitted = 0;
    const media = collectPostMedia(post);
    for (let m = 0; m < media.length; m++) {
      const record = await buildMediaRecord(
        {
          media: media[m],
          sourceRef: `${entry.entryPath}#${i}:media:${m}`,
          date: secondsDate(media[m].creation_timestamp) ?? postDate,
          author: null,
          sourceMeta: { kind: 'post' },
        },
        resolve,
        deps,
        ctx,
        skipped,
      );
      if (record !== null) {
        yield record;
        emitted += 1;
      }
    }
    if (body !== null) {
      yield postTextRecord(body, postDate, `${entry.entryPath}#${i}:text`);
      emitted += 1;
    }
    // A post with neither text nor a resolvable attachment is still a dated
    // occurrence — keep it so nothing the person posted is silently dropped.
    if (emitted === 0) {
      yield postTextRecord(null, postDate, `${entry.entryPath}#${i}:text`);
    }
  }
}

const MESSAGE_MEDIA_FIELDS = ['photos', 'videos', 'audio_files', 'gifs', 'files'] as const;

async function* parseMessageFile(
  entry: Entry,
  resolve: (uri: string) => string | null,
  deps: ImporterDeps,
  ctx: ImportContext,
  skipped: SkippedItem[],
): AsyncGenerator<CatalogRecord> {
  const parsed = await readJson(entry, ctx, skipped);
  if (parsed === undefined) return;
  if (!isObject(parsed)) {
    recordSkip(ctx, skipped, entry.entryPath, 'message thread is not an object', 'E_PARSE');
    return;
  }

  const threadTitle = fbText(parsed.title);
  const threadPath = asString(parsed.thread_path);
  const participants = asArray(parsed.participants)
    .map((p) => (isObject(p) ? fbText(p.name) : null))
    .filter((name): name is string => name !== null);
  const baseMeta: Record<string, unknown> = { threadTitle, threadPath, participants };

  const messages = asArray(parsed.messages);
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (!isObject(message)) {
      recordSkip(ctx, skipped, `${entry.entryPath}#${i}`, 'message is not an object', 'E_PARSE');
      continue;
    }
    const author = fbText(message.sender_name);
    const date = msDate(message.timestamp_ms);
    const content = fbText(message.content);

    let emitted = 0;
    for (const field of MESSAGE_MEDIA_FIELDS) {
      const items = asArray(message[field]);
      for (let m = 0; m < items.length; m++) {
        const item = items[m];
        if (!isObject(item)) continue;
        const record = await buildMediaRecord(
          {
            media: item,
            sourceRef: `${entry.entryPath}#${i}:${field}:${m}`,
            date,
            author,
            sourceMeta: { ...baseMeta, attachment: field },
          },
          resolve,
          deps,
          ctx,
          skipped,
        );
        if (record !== null) {
          yield record;
          emitted += 1;
        }
      }
    }
    if (isObject(message.sticker)) {
      const record = await buildMediaRecord(
        {
          media: message.sticker,
          sourceRef: `${entry.entryPath}#${i}:sticker`,
          date,
          author,
          sourceMeta: { ...baseMeta, attachment: 'sticker' },
        },
        resolve,
        deps,
        ctx,
        skipped,
      );
      if (record !== null) {
        yield record;
        emitted += 1;
      }
    }
    if (content !== null) {
      yield messageTextRecord(content, date, author, `${entry.entryPath}#${i}:text`, baseMeta);
      emitted += 1;
    }
    // A contentless message (e.g. a call note, an unsupported attachment) still
    // carries a sender and a time — keep it rather than silently drop it.
    if (emitted === 0) {
      yield messageTextRecord(null, date, author, `${entry.entryPath}#${i}:text`, baseMeta);
    }
  }
}

async function* parseAlbumFile(
  entry: Entry,
  resolve: (uri: string) => string | null,
  deps: ImporterDeps,
  ctx: ImportContext,
  skipped: SkippedItem[],
): AsyncGenerator<CatalogRecord> {
  const parsed = await readJson(entry, ctx, skipped);
  if (parsed === undefined) return;

  const album = isObject(parsed) ? fbText(parsed.name) : null;
  const photos = Array.isArray(parsed) ? parsed : asArray(isObject(parsed) ? parsed.photos : []);

  for (let i = 0; i < photos.length; i++) {
    const photo = photos[i];
    if (!isObject(photo)) {
      recordSkip(
        ctx,
        skipped,
        `${entry.entryPath}#${i}`,
        'album entry is not an object',
        'E_PARSE',
      );
      continue;
    }
    const record = await buildMediaRecord(
      {
        media: photo,
        sourceRef: `${entry.entryPath}#photo:${i}`,
        date: secondsDate(photo.creation_timestamp),
        author: null,
        sourceMeta: { kind: 'album', album },
      },
      resolve,
      deps,
      ctx,
      skipped,
    );
    if (record !== null) yield record;
  }
}

export const facebookImporter: Importer = {
  id: 'facebook',
  displayName: 'Facebook',

  async canHandle(inputPath: string, deps: ImporterDeps): Promise<boolean> {
    try {
      if (isZip(inputPath)) {
        return await zipHasEntryName(inputPath, FB_ZIP_MARKERS);
      }
      const stat = await deps.fs.stat(inputPath);
      if (!stat.isDirectory()) return false;
      for (const marker of FB_DIR_MARKERS) {
        if (await deps.fs.exists(join(inputPath, marker))) return true;
      }
      return false;
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

    const { entries, discoveryFailed } = await gatherEntries(inputPath, ctx, skipped);
    if (discoveryFailed) {
      return { recordCount, skipped };
    }

    const resolve = buildResolver(entries);
    ctx.onProgress({ phase: 'parse', processed: 0, total: null, message: null });

    const stages: [Entry[], (entry: Entry) => AsyncGenerator<CatalogRecord>][] = [
      [
        entries.filter((e) => isPostsFile(e.entryPath)),
        (e) => parsePostsFile(e, resolve, ctx.deps, ctx, skipped),
      ],
      [
        entries.filter((e) => isMessageFile(e.entryPath)),
        (e) => parseMessageFile(e, resolve, ctx.deps, ctx, skipped),
      ],
      [
        entries.filter((e) => isAlbumFile(e.entryPath)),
        (e) => parseAlbumFile(e, resolve, ctx.deps, ctx, skipped),
      ],
    ];

    for (const [files, parse] of stages) {
      for (const file of files) {
        if (ctx.signal.aborted) return { recordCount, skipped };
        for await (const record of parse(file)) {
          if (ctx.signal.aborted) return { recordCount, skipped };
          recordCount += 1;
          ctx.onProgress({ phase: 'emit', processed: recordCount, total: null });
          yield record;
        }
      }
    }

    return { recordCount, skipped };
  },
};
