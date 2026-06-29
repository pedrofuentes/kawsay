import { basename, extname, isAbsolute, join, relative, sep } from 'node:path';
import { Readable } from 'node:stream';
import type { MediaType, SourceType } from '@shared/catalog';
import { decodeFacebookText } from './facebook-importer';
import type {
  CatalogRecord,
  ImportContext,
  Importer,
  ImporterDeps,
  ImportResult,
  SkippedItem,
} from './types';
import { zipHasEntryName } from './zip-markers';

const CAN_HANDLE_MAX_BYTES = 64 * 1024;
const MAX_DTO_STRING_CHARS = 20_000;
const MAX_META_STRING_CHARS = 1_000;
const MAX_MESSAGE_JSON_CHARS = 1_000_000;
const MAX_THREAD_META_CHARS = 64 * 1024;
const MAX_TEXT_DEPTH = 20;

interface Entry {
  entryPath: string;
  absPath: string;
}

interface MetaThreadMeta {
  thread: string;
  threadBucket: string;
  threadTitle: string | null;
  participants: string[];
}

interface StreamedMessage {
  index: number;
  message: Record<string, unknown>;
  meta: MetaThreadMeta;
}

interface MetaMessagesConfig {
  id: Extract<SourceType, 'messenger' | 'instagram'>;
  displayName: string;
  rootDir: string;
  buckets: readonly string[];
  allowRootlessMessages: boolean;
  archiveLabel: string;
}

interface MetaMessagesRuntime extends MetaMessagesConfig {
  messagesDir: 'messages';
}

const MESSAGES_DIR = 'messages';

interface MediaKind {
  mediaType: Extract<MediaType, 'photo' | 'video' | 'audio'>;
  mime: string;
}

const EXT_INFO = new Map<string, MediaKind>([
  ['.jpg', { mediaType: 'photo', mime: 'image/jpeg' }],
  ['.jpeg', { mediaType: 'photo', mime: 'image/jpeg' }],
  ['.png', { mediaType: 'photo', mime: 'image/png' }],
  ['.gif', { mediaType: 'photo', mime: 'image/gif' }],
  ['.webp', { mediaType: 'photo', mime: 'image/webp' }],
  ['.heic', { mediaType: 'photo', mime: 'image/heic' }],
  ['.heif', { mediaType: 'photo', mime: 'image/heif' }],
  ['.mp4', { mediaType: 'video', mime: 'video/mp4' }],
  ['.mov', { mediaType: 'video', mime: 'video/quicktime' }],
  ['.m4v', { mediaType: 'video', mime: 'video/x-m4v' }],
  ['.webm', { mediaType: 'video', mime: 'video/webm' }],
  ['.mp3', { mediaType: 'audio', mime: 'audio/mpeg' }],
  ['.m4a', { mediaType: 'audio', mime: 'audio/mp4' }],
  ['.aac', { mediaType: 'audio', mime: 'audio/aac' }],
  ['.ogg', { mediaType: 'audio', mime: 'audio/ogg' }],
  ['.opus', { mediaType: 'audio', mime: 'audio/opus' }],
  ['.wav', { mediaType: 'audio', mime: 'audio/wav' }],
]);

const MEDIA_FIELDS = ['photos', 'videos', 'audio', 'audio_files', 'gifs'] as const;

function toPosix(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/');
}

function stripRoot(path: string, config: MetaMessagesRuntime): string {
  const posix = toPosix(path).replace(/^\.?\//, '');
  const rootPrefix = `${config.rootDir}/`;
  return posix.startsWith(rootPrefix) ? posix.slice(rootPrefix.length) : posix;
}

function metaMessagesRel(path: string, config: MetaMessagesRuntime): string | null {
  const stripped = stripRoot(path, config);
  const prefix = `${MESSAGES_DIR}/`;
  return stripped.startsWith(prefix) ? stripped.slice(prefix.length) : null;
}

function isMessageFile(path: string, config: MetaMessagesRuntime): boolean {
  const rel = metaMessagesRel(path, config);
  if (rel === null) return false;
  const parts = rel.split('/');
  return (
    parts.length === 3 &&
    config.buckets.includes(parts[0]) &&
    parts[2].startsWith('message_') &&
    parts[2].endsWith('.json')
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function boundString(value: string, maxChars: number): string {
  const chars = Array.from(value);
  return chars.length <= maxChars ? value : chars.slice(0, maxChars).join('');
}

function nullableBound(
  value: string | null | undefined,
  maxChars = MAX_DTO_STRING_CHARS,
): string | null {
  if (value === null || value === undefined) return null;
  return boundString(value, maxChars);
}

function fbText(value: unknown, depth = 0): string | null {
  if (depth > MAX_TEXT_DEPTH) return null;
  if (typeof value === 'string') return nullableBound(decodeFacebookText(value));
  if (Array.isArray(value)) {
    const text = value.map((item) => fbText(item, depth + 1) ?? '').join('');
    return nullableBound(text.trim() || null);
  }
  const record = asRecord(value);
  if (record) return fbText(record.text, depth + 1);
  return null;
}

function msDate(value: unknown): CatalogRecord['date'] {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? { value: date, source: 'message' } : null;
}

function recordSkip(
  ctx: ImportContext,
  skipped: SkippedItem[],
  ref: string,
  reason: string,
  code: string,
): void {
  const item = { ref, reason, code };
  skipped.push(item);
  ctx.onSkip(item);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function classify(pathOrName: string): MediaKind | null {
  return EXT_INFO.get(extname(pathOrName).toLowerCase()) ?? null;
}

async function openTextStream(path: string, deps: ImporterDeps): Promise<Readable> {
  if (deps.fs.openReadStream) return deps.fs.openReadStream(path);
  return Readable.from(await deps.fs.readFile(path));
}

async function readMarkerPrefix(path: string, deps: ImporterDeps): Promise<string> {
  const stream = await openTextStream(path, deps);
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of stream) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      const remaining = CAN_HANDLE_MAX_BYTES - total;
      chunks.push(buf.subarray(0, Math.max(0, remaining)));
      total += Math.min(buf.length, remaining);
      if (total >= CAN_HANDLE_MAX_BYTES) break;
    }
  } finally {
    stream.destroy();
  }
  return Buffer.concat(chunks).toString('utf8');
}

function looksLikeMetaThread(prefix: string): boolean {
  const trimmed = prefix.trimStart();
  return (
    trimmed.startsWith('{') &&
    prefix.includes('"participants"') &&
    prefix.includes('"messages"') &&
    prefix.includes('"sender_name"') &&
    prefix.includes('"timestamp_ms"')
  );
}

async function findMetaMarker(
  inputPath: string,
  deps: ImporterDeps,
  config: MetaMessagesRuntime,
): Promise<string | null> {
  const roots = [join(inputPath, config.rootDir, config.messagesDir)];
  if (config.allowRootlessMessages) roots.push(join(inputPath, config.messagesDir));
  for (const root of roots) {
    for (const bucket of config.buckets) {
      const bucketPath = join(root, bucket);
      if (!(await deps.fs.exists(bucketPath))) continue;
      const threads = await deps.fs.readDir(bucketPath);
      for (const thread of threads.slice(0, 20)) {
        const threadPath = join(bucketPath, thread);
        const threadStat = await deps.fs.stat(threadPath);
        if (!threadStat.isDirectory()) continue;
        const names = await deps.fs.readDir(threadPath);
        const message = names.find((name) => name.startsWith('message_') && name.endsWith('.json'));
        if (message !== undefined) return join(threadPath, message);
      }
    }
  }
  return null;
}

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

function isZip(inputPath: string): boolean {
  return inputPath.toLowerCase().endsWith('.zip');
}

async function gatherEntries(
  inputPath: string,
  ctx: ImportContext,
  skipped: SkippedItem[],
  config: MetaMessagesRuntime,
): Promise<{ entries: Entry[]; failed: boolean }> {
  if (isZip(inputPath)) {
    try {
      const extracted = await ctx.deps.extractArchive(inputPath, ctx.workDir, {
        signal: ctx.signal,
      });
      return {
        entries: extracted.map((entry) => ({
          entryPath: toPosix(entry.entryPath),
          absPath: entry.absPath,
        })),
        failed: false,
      };
    } catch (error) {
      recordSkip(
        ctx,
        skipped,
        inputPath,
        `could not extract ${config.archiveLabel} archive: ${errorMessage(error)}`,
        'E_EXTRACT',
      );
      return { entries: [], failed: true };
    }
  }
  const entries: Entry[] = [];
  for await (const absPath of walkFolder(inputPath, ctx, skipped)) {
    entries.push({ entryPath: toPosix(relative(inputPath, absPath)), absPath });
  }
  return { entries, failed: false };
}

function parseThreadMeta(prefix: string, rel: string): MetaThreadMeta {
  const parts = rel.split('/');
  const fallback: MetaThreadMeta = {
    thread: parts.slice(0, 2).join('/'),
    threadBucket: parts[0] ?? 'unknown',
    threadTitle: null,
    participants: [],
  };
  const keyIndex = prefix.lastIndexOf('"messages"');
  if (keyIndex < 0) return fallback;
  const beforeMessages = prefix.slice(0, keyIndex);
  const lastComma = beforeMessages.lastIndexOf(',');
  const metaText = `${lastComma >= 0 ? beforeMessages.slice(0, lastComma) : beforeMessages}}`;
  try {
    const parsed = asRecord(JSON.parse(metaText));
    if (parsed === null) return fallback;
    const participants = asArray(parsed.participants)
      .map((item) => (asRecord(item) ? fbText(asRecord(item)?.name) : null))
      .filter((name): name is string => name !== null)
      .map((name) => boundString(name, MAX_META_STRING_CHARS));
    return {
      ...fallback,
      threadTitle: nullableBound(fbText(parsed.title), MAX_META_STRING_CHARS),
      participants,
    };
  } catch {
    return fallback;
  }
}

async function* streamMessages(
  entry: Entry,
  ctx: ImportContext,
  skipped: SkippedItem[],
  config: MetaMessagesRuntime,
): AsyncGenerator<StreamedMessage> {
  const rel = metaMessagesRel(entry.entryPath, config) ?? entry.entryPath;
  const stream = await openTextStream(entry.absPath, ctx.deps);
  let mode: 'seek-key' | 'seek-colon' | 'seek-array' | 'in-array' = 'seek-key';
  let inString = false;
  let escaped = false;
  let token = '';
  let prefix = '';
  let meta: MetaThreadMeta | null = null;
  let objectDepth = 0;
  let objectText = '';
  let objectInString = false;
  let objectEscaped = false;
  let objectTooLarge = false;
  let index = 0;

  try {
    for await (const chunk of stream) {
      if (ctx.signal.aborted) break;
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      for (const ch of text) {
        if (ctx.signal.aborted) break;
        if (mode !== 'in-array') prefix = (prefix + ch).slice(-MAX_THREAD_META_CHARS);

        if (mode === 'in-array') {
          if (objectDepth === 0) {
            if (ch === ']') {
              mode = 'seek-key';
              continue;
            }
            if (ch !== '{') continue;
            objectDepth = 1;
            objectText = '{';
            objectTooLarge = false;
            objectInString = false;
            objectEscaped = false;
            continue;
          }

          if (!objectTooLarge) {
            objectText += ch;
            if (objectText.length > MAX_MESSAGE_JSON_CHARS) {
              objectTooLarge = true;
              objectText = '';
              recordSkip(
                ctx,
                skipped,
                rel,
                `message JSON object exceeded the ${config.archiveLabel} size cap`,
                'E_MESSAGE_TOO_LARGE',
              );
            }
          }
          if (objectInString) {
            if (objectEscaped) objectEscaped = false;
            else if (ch === '\\') objectEscaped = true;
            else if (ch === '"') objectInString = false;
            continue;
          }
          if (ch === '"') objectInString = true;
          else if (ch === '{') objectDepth += 1;
          else if (ch === '}') {
            objectDepth -= 1;
            if (objectDepth === 0) {
              if (!objectTooLarge) {
                try {
                  const parsed = asRecord(JSON.parse(objectText));
                  if (parsed)
                    yield { index, message: parsed, meta: meta ?? parseThreadMeta(prefix, rel) };
                } catch (error) {
                  recordSkip(
                    ctx,
                    skipped,
                    `${rel}#${index}`,
                    `malformed message JSON: ${errorMessage(error)}`,
                    'E_PARSE_MESSAGE',
                  );
                }
              }
              objectText = '';
              index += 1;
            }
          }
          continue;
        }

        if (mode === 'seek-key') {
          if (inString) {
            if (escaped) {
              token += ch;
              escaped = false;
            } else if (ch === '\\') {
              escaped = true;
            } else if (ch === '"') {
              inString = false;
              if (token === 'messages') mode = 'seek-colon';
              token = '';
            } else {
              token += ch;
            }
          } else if (ch === '"') {
            inString = true;
            token = '';
          }
          continue;
        }

        if (mode === 'seek-colon') {
          if (/\s/.test(ch)) continue;
          mode = ch === ':' ? 'seek-array' : 'seek-key';
          continue;
        }

        if (mode === 'seek-array') {
          if (/\s/.test(ch)) continue;
          if (ch === '[') {
            meta = parseThreadMeta(prefix, rel);
            mode = 'in-array';
          } else {
            mode = 'seek-key';
          }
        }
      }
    }
  } finally {
    stream.destroy();
  }
}

function buildMediaResolver(
  entries: readonly Entry[],
  config: MetaMessagesRuntime,
): (uri: string) => { absPath: string; mediaPath: string } | null {
  const byMediaPath = new Map<string, string>();
  for (const entry of entries) {
    const stripped = stripRoot(entry.entryPath, config);
    if (stripped.startsWith(`${MESSAGES_DIR}/`)) {
      byMediaPath.set(stripped, entry.absPath);
    }
  }
  return (uri: string) => {
    const normalized = uri.replace(/\\/g, '/').replace(/^\.?\//, '');
    if (normalized.length === 0 || normalized.includes('\0') || isAbsolute(normalized)) return null;
    const stripped = stripRoot(normalized, config);
    const parts = stripped.split('/').filter((part) => part.length > 0);
    if (parts.length === 0 || parts.some((part) => part === '.' || part === '..')) return null;
    const mediaPath = parts.join('/');
    if (!config.buckets.some((bucket) => mediaPath.startsWith(`${config.messagesDir}/${bucket}/`)))
      return null;
    const absPath = byMediaPath.get(mediaPath);
    return absPath === undefined ? null : { absPath, mediaPath };
  };
}

function baseMeta(meta: MetaThreadMeta): Record<string, unknown> {
  return {
    thread: meta.thread,
    threadBucket: meta.threadBucket,
    threadTitle: meta.threadTitle,
    participants: meta.participants,
  };
}

function textRef(rel: string, index: number): string {
  return `${rel}#${index}:text`;
}

function messageRecord(
  rel: string,
  streamed: StreamedMessage,
  config: MetaMessagesRuntime,
): CatalogRecord {
  const author = nullableBound(fbText(streamed.message.sender_name), MAX_META_STRING_CHARS);
  return {
    sourceType: config.id,
    mediaType: 'message',
    originalPath: null,
    mimeType: null,
    date: msDate(streamed.message.timestamp_ms),
    author,
    body: fbText(streamed.message.content),
    gps: null,
    durationSec: null,
    sourceRef: textRef(rel, streamed.index),
    sourceMeta: baseMeta(streamed.meta),
  };
}

async function buildMediaRecord(
  rel: string,
  streamed: StreamedMessage,
  field: string,
  mediaIndex: number,
  media: Record<string, unknown>,
  resolve: (uri: string) => { absPath: string; mediaPath: string } | null,
  ctx: ImportContext,
  skipped: SkippedItem[],
  config: MetaMessagesRuntime,
): Promise<CatalogRecord | null> {
  const sourceRef = `${rel}#${streamed.index}:${field}:${mediaIndex}`;
  const uri = asString(media.uri);
  if (uri === null || uri.trim() === '') {
    recordSkip(ctx, skipped, sourceRef, 'media entry has no uri', 'E_MEDIA_URI');
    return null;
  }
  const resolved = resolve(uri);
  if (resolved === null) {
    recordSkip(ctx, skipped, sourceRef, 'media path is missing or unsafe', 'E_MEDIA_PATH');
    return null;
  }
  const kind = classify(resolved.mediaPath);
  if (kind === null) {
    recordSkip(ctx, skipped, sourceRef, 'media type is not supported', 'E_MEDIA_TYPE');
    return null;
  }
  return {
    sourceType: config.id,
    mediaType: kind.mediaType,
    originalPath: resolved.absPath,
    mimeType: kind.mime,
    date: msDate(streamed.message.timestamp_ms),
    author: nullableBound(fbText(streamed.message.sender_name), MAX_META_STRING_CHARS),
    body: null,
    gps: null,
    durationSec: null,
    sourceRef,
    sourceMeta: {
      ...baseMeta(streamed.meta),
      parentMessageRef: textRef(rel, streamed.index),
      mediaPath: resolved.mediaPath,
      mediaFileName: basename(resolved.mediaPath),
      attachment: field,
    },
  };
}

export function createMetaMessagesImporter(configInput: MetaMessagesConfig): Importer {
  const config: MetaMessagesRuntime = { ...configInput, messagesDir: MESSAGES_DIR };
  return {
    id: config.id,
    displayName: config.displayName,

    async canHandle(inputPath: string, deps: ImporterDeps): Promise<boolean> {
      try {
        if (isZip(inputPath)) {
          return await zipHasEntryName(inputPath, [
            `${config.rootDir}/${config.messagesDir}/inbox/`,
            ...(config.allowRootlessMessages ? [`${config.messagesDir}/inbox/`] : []),
          ]);
        }
        const root = await deps.fs.stat(inputPath);
        if (!root.isDirectory()) return false;
        const marker = await findMetaMarker(inputPath, deps, config);
        if (marker === null) return false;
        return looksLikeMetaThread(await readMarkerPrefix(marker, deps));
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
      if (ctx.signal.aborted) return { recordCount, skipped };

      const { entries, failed } = await gatherEntries(inputPath, ctx, skipped, config);
      if (failed) return { recordCount, skipped };
      const messageFiles = entries
        .filter((entry) => isMessageFile(entry.entryPath, config))
        .sort((a, b) => {
          const aRel = metaMessagesRel(a.entryPath, config) ?? a.entryPath;
          const bRel = metaMessagesRel(b.entryPath, config) ?? b.entryPath;
          const aBucket = aRel.split('/')[0] ?? '';
          const bBucket = bRel.split('/')[0] ?? '';
          const bucketDiff = config.buckets.indexOf(aBucket) - config.buckets.indexOf(bBucket);
          return bucketDiff === 0 ? aRel.localeCompare(bRel) : bucketDiff;
        });
      const resolveMedia = buildMediaResolver(entries, config);

      ctx.onProgress({ phase: 'parse', processed: 0, total: null, message: null });
      for (const entry of messageFiles) {
        if (ctx.signal.aborted) return { recordCount, skipped };
        const rel = metaMessagesRel(entry.entryPath, config) ?? entry.entryPath;
        try {
          for await (const streamed of streamMessages(entry, ctx, skipped, config)) {
            if (ctx.signal.aborted) return { recordCount, skipped };
            for (const field of MEDIA_FIELDS) {
              const items = asArray(streamed.message[field]);
              for (let i = 0; i < items.length; i++) {
                const media = asRecord(items[i]);
                if (media === null) continue;
                const record = await buildMediaRecord(
                  rel,
                  streamed,
                  field,
                  i,
                  media,
                  resolveMedia,
                  ctx,
                  skipped,
                  config,
                );
                if (record === null) continue;
                recordCount += 1;
                ctx.onProgress({ phase: 'emit', processed: recordCount, total: null });
                yield record;
              }
            }
            const text = messageRecord(rel, streamed, config);
            recordCount += 1;
            ctx.onProgress({ phase: 'emit', processed: recordCount, total: null });
            yield text;
          }
        } catch (error) {
          recordSkip(
            ctx,
            skipped,
            rel,
            `could not read ${config.archiveLabel} thread: ${errorMessage(error)}`,
            'E_READ_JSON',
          );
        }
      }

      return { recordCount, skipped };
    },
  };
}
