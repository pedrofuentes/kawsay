import { basename, extname, isAbsolute, join } from 'node:path';
import { Readable } from 'node:stream';
import type { MediaType } from '@shared/catalog';
import type {
  CatalogRecord,
  ImportContext,
  Importer,
  ImporterDeps,
  ImportResult,
  SkippedItem,
} from './types';

const RESULT_JSON = 'result.json';
const MESSAGES_HTML = 'messages.html';
const MAX_DTO_STRING_CHARS = 20_000;
const MAX_META_STRING_CHARS = 1_000;
const CAN_HANDLE_MAX_BYTES = 64 * 1024;

interface TelegramChatContext {
  chatId: number | string | null;
  chatName: string | null;
  chatType: string | null;
}

interface TelegramMessage {
  id?: unknown;
  type?: unknown;
  date?: unknown;
  date_unixtime?: unknown;
  from?: unknown;
  from_id?: unknown;
  text?: unknown;
  photo?: unknown;
  file?: unknown;
  media_type?: unknown;
}

interface StreamedMessage {
  message: TelegramMessage;
  chat: TelegramChatContext;
}

interface MediaKind {
  mediaType: Extract<MediaType, 'photo' | 'video' | 'audio'>;
  mime: string;
}

const EMPTY_CHAT: TelegramChatContext = { chatId: null, chatName: null, chatType: null };

const EXT_INFO = new Map<string, MediaKind>([
  ['.jpg', { mediaType: 'photo', mime: 'image/jpeg' }],
  ['.jpeg', { mediaType: 'photo', mime: 'image/jpeg' }],
  ['.png', { mediaType: 'photo', mime: 'image/png' }],
  ['.gif', { mediaType: 'photo', mime: 'image/gif' }],
  ['.webp', { mediaType: 'photo', mime: 'image/webp' }],
  ['.mp4', { mediaType: 'video', mime: 'video/mp4' }],
  ['.mov', { mediaType: 'video', mime: 'video/quicktime' }],
  ['.m4v', { mediaType: 'video', mime: 'video/x-m4v' }],
  ['.webm', { mediaType: 'video', mime: 'video/webm' }],
  ['.ogg', { mediaType: 'audio', mime: 'audio/ogg' }],
  ['.oga', { mediaType: 'audio', mime: 'audio/ogg' }],
  ['.opus', { mediaType: 'audio', mime: 'audio/opus' }],
  ['.mp3', { mediaType: 'audio', mime: 'audio/mpeg' }],
  ['.m4a', { mediaType: 'audio', mime: 'audio/mp4' }],
  ['.wav', { mediaType: 'audio', mime: 'audio/wav' }],
]);

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

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
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

function flattenText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(flattenText).join('');
  const record = asRecord(value);
  if (record) return flattenText(record.text);
  return '';
}

function parseTelegramDate(message: TelegramMessage): CatalogRecord['date'] {
  const unix = message.date_unixtime;
  if (typeof unix === 'string' || typeof unix === 'number') {
    const seconds = Number(unix);
    if (Number.isFinite(seconds)) {
      const value = new Date(seconds * 1_000);
      if (Number.isFinite(value.getTime())) return { value, source: 'message' };
    }
  }

  if (typeof message.date === 'number') {
    const value = new Date(message.date * 1_000);
    if (Number.isFinite(value.getTime())) return { value, source: 'message' };
  }
  if (typeof message.date === 'string') {
    const raw = message.date;
    const iso = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw) ? raw : `${raw}Z`;
    const value = new Date(iso);
    if (Number.isFinite(value.getTime())) return { value, source: 'message' };
  }
  return null;
}

function sourceRefFor(message: TelegramMessage): string {
  const id =
    typeof message.id === 'number' || typeof message.id === 'string'
      ? String(message.id)
      : 'unknown';
  return `message:${boundString(id, MAX_META_STRING_CHARS)}`;
}

function baseSourceMeta(
  message: TelegramMessage,
  chat: TelegramChatContext,
): Record<string, unknown> {
  return {
    messageId: message.id ?? null,
    rawType: nullableBound(asString(message.type), MAX_META_STRING_CHARS),
    chatId: chat.chatId,
    chatName: nullableBound(chat.chatName, MAX_META_STRING_CHARS),
    chatType: nullableBound(chat.chatType, MAX_META_STRING_CHARS),
    fromId: nullableBound(asString(message.from_id), MAX_META_STRING_CHARS),
  };
}

function normalizeMessage(
  message: TelegramMessage,
  chat: TelegramChatContext,
): CatalogRecord | SkippedItem {
  const ref = sourceRefFor(message);
  const rawType = asString(message.type);
  if (rawType !== null && rawType !== 'message') {
    return {
      ref,
      reason: 'service message is deferred for a later Telegram slice',
      code: 'E_SERVICE_MESSAGE',
    };
  }

  return {
    sourceType: 'telegram',
    mediaType: 'message',
    originalPath: null,
    mimeType: null,
    date: parseTelegramDate(message),
    author: nullableBound(asString(message.from), MAX_META_STRING_CHARS),
    body: nullableBound(flattenText(message.text).trim() || null),
    gps: null,
    durationSec: null,
    sourceRef: ref,
    sourceMeta: baseSourceMeta(message, chat),
  };
}

function classify(pathOrName: string, mediaType: string | null): MediaKind | null {
  const byExt = EXT_INFO.get(extname(pathOrName).toLowerCase()) ?? null;
  if (mediaType === 'voice_message')
    return byExt ?? { mediaType: 'audio', mime: 'application/octet-stream' };
  if (mediaType === 'video_file')
    return byExt ?? { mediaType: 'video', mime: 'application/octet-stream' };
  if (mediaType === 'animation')
    return byExt ?? { mediaType: 'video', mime: 'application/octet-stream' };
  if (mediaType === 'photo')
    return byExt ?? { mediaType: 'photo', mime: 'application/octet-stream' };
  return byExt;
}

function normalizeMediaPath(rawPath: string): string | null {
  const normalized = rawPath.replace(/\\/g, '/');
  if (normalized.length === 0 || normalized.includes('\0') || isAbsolute(normalized)) return null;
  const parts = normalized.split('/').filter((part) => part.length > 0);
  if (parts.length === 0 || parts.some((part) => part === '.' || part === '..')) return null;
  const safe = parts.join('/');
  if (
    !(
      safe.startsWith('photos/') ||
      safe.startsWith('video_files/') ||
      safe.startsWith('voice_messages/')
    )
  ) {
    return null;
  }
  return safe;
}

function mediaRefs(message: TelegramMessage): string[] {
  const refs: string[] = [];
  if (typeof message.photo === 'string') refs.push(message.photo);
  if (typeof message.file === 'string') refs.push(message.file);
  return Array.from(new Set(refs));
}

async function normalizeMediaRecord(
  inputPath: string,
  message: TelegramMessage,
  chat: TelegramChatContext,
  rawPath: string,
  ctx: ImportContext,
  skipped: SkippedItem[],
): Promise<CatalogRecord | null> {
  const parentRef = sourceRefFor(message);
  const mediaRef = `${parentRef}:media:${rawPath}`;
  const relativePath = normalizeMediaPath(rawPath);
  if (relativePath === null) {
    recordSkip(ctx, skipped, mediaRef, 'media path is missing or unsafe', 'E_MEDIA_PATH');
    return null;
  }

  const kind = classify(relativePath, asString(message.media_type));
  if (kind === null) {
    recordSkip(ctx, skipped, mediaRef, 'media type is not supported', 'E_MEDIA_TYPE');
    return null;
  }

  const absPath = join(inputPath, ...relativePath.split('/'));
  try {
    const stat = await ctx.deps.fs.stat(absPath);
    if (!stat.isFile()) {
      recordSkip(ctx, skipped, mediaRef, 'media path is not a file', 'E_MEDIA_FILE');
      return null;
    }
  } catch (error) {
    recordSkip(
      ctx,
      skipped,
      mediaRef,
      `media file is missing: ${errorMessage(error)}`,
      'E_MEDIA_MISSING',
    );
    return null;
  }

  return {
    sourceType: 'telegram',
    mediaType: kind.mediaType,
    originalPath: absPath,
    mimeType: kind.mime,
    date: parseTelegramDate(message),
    author: nullableBound(asString(message.from), MAX_META_STRING_CHARS),
    body: nullableBound(flattenText(message.text).trim() || null),
    gps: null,
    durationSec: null,
    sourceRef: `${parentRef}:media:${relativePath}`,
    sourceMeta: {
      ...baseSourceMeta(message, chat),
      parentMessageRef: parentRef,
      mediaPath: relativePath,
      mediaFileName: basename(relativePath),
      telegramMediaType: nullableBound(asString(message.media_type), MAX_META_STRING_CHARS),
    },
  };
}

async function openTextStream(path: string, deps: ImporterDeps): Promise<Readable> {
  if (deps.fs.openReadStream) return deps.fs.openReadStream(path);
  return Readable.from(await deps.fs.readFile(path));
}

function findMessagesArrayPrefix(
  prefix: string,
): { objectStart: number; arrayStart: number } | null {
  const stack: Array<{ type: 'object' | 'array'; start: number }> = [];
  let inString = false;
  let escaped = false;
  let token = '';
  let pendingMessages: { objectStart: number; colonIndex: number } | null = null;
  let latest: { objectStart: number; arrayStart: number } | null = null;

  for (let index = 0; index < prefix.length; index += 1) {
    const ch = prefix[index];
    if (inString) {
      if (escaped) {
        token += ch;
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
        let next = index + 1;
        while (next < prefix.length && /\s/.test(prefix[next])) next += 1;
        if (token === 'messages' && prefix[next] === ':') {
          const object = stack.at(-1);
          if (object?.type === 'object') {
            pendingMessages = { objectStart: object.start, colonIndex: next };
          }
        }
      } else {
        token += ch;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      escaped = false;
      token = '';
    } else if (ch === '{') {
      stack.push({ type: 'object', start: index });
    } else if (ch === '[') {
      if (
        pendingMessages !== null &&
        prefix.slice(pendingMessages.colonIndex + 1, index).trim() === ''
      ) {
        latest = { objectStart: pendingMessages.objectStart, arrayStart: index };
      }
      stack.push({ type: 'array', start: index });
      pendingMessages = null;
    } else if (ch === '}' || ch === ']') {
      stack.pop();
      pendingMessages = null;
    } else if (!/\s/.test(ch) && ch !== ':') {
      pendingMessages = null;
    }
  }

  return latest;
}

function chatFromPrefix(prefix: string): TelegramChatContext {
  const messagesArray = findMessagesArrayPrefix(prefix);
  if (messagesArray === null) return EMPTY_CHAT;

  let chat: Record<string, unknown>;
  try {
    chat = JSON.parse(`${prefix.slice(messagesArray.objectStart, messagesArray.arrayStart)}[]}`);
  } catch {
    return EMPTY_CHAT;
  }

  const chatId = chat.id;
  return {
    chatId: typeof chatId === 'string' || typeof chatId === 'number' ? chatId : null,
    chatName: asString(chat.name),
    chatType: asString(chat.type),
  };
}

async function* streamTelegramMessages(
  path: string,
  ctx: ImportContext,
): AsyncGenerator<StreamedMessage> {
  const stream = await openTextStream(path, ctx.deps);
  let mode: 'seek-key' | 'seek-colon' | 'seek-array' | 'in-array' = 'seek-key';
  let inString = false;
  let escaped = false;
  let token = '';
  let prefix = '';
  let currentChat = EMPTY_CHAT;
  let objectDepth = 0;
  let objectText = '';
  let objectInString = false;
  let objectEscaped = false;

  try {
    for await (const chunk of stream) {
      if (ctx.signal.aborted) break;
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      for (const ch of text) {
        if (ctx.signal.aborted) break;
        prefix = (prefix + ch).slice(-8_192);

        if (mode === 'in-array') {
          if (objectDepth === 0) {
            if (ch === ']') {
              mode = 'seek-key';
              continue;
            }
            if (ch !== '{') continue;
            objectDepth = 1;
            objectText = '{';
            objectInString = false;
            objectEscaped = false;
            continue;
          }

          objectText += ch;
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
              try {
                const parsed = JSON.parse(objectText) as unknown;
                const message = asRecord(parsed);
                if (message) yield { message: message as TelegramMessage, chat: currentChat };
              } catch {
                // Malformed objects are reported by the caller when JSON.parse fails
                // within an object boundary; the stream then continues with later objects.
              }
              objectText = '';
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
            currentChat = chatFromPrefix(prefix);
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

function looksLikeTelegramJson(prefix: string): boolean {
  const trimmed = prefix.trimStart();
  if (!trimmed.startsWith('{')) return false;
  const hasChatIdentity =
    /"name"\s*:/.test(prefix) && /"type"\s*:/.test(prefix) && /"id"\s*:/.test(prefix);
  return (/"messages"\s*:/.test(prefix) && hasChatIdentity) || /"chats"\s*:/.test(prefix);
}

function looksLikeTelegramHtml(prefix: string): boolean {
  return /Telegram Desktop|messages\.html|tgme_page/i.test(prefix);
}

export const telegramImporter: Importer = {
  id: 'telegram',
  displayName: 'Telegram',

  async canHandle(inputPath: string, deps: ImporterDeps): Promise<boolean> {
    try {
      const root = await deps.fs.stat(inputPath);
      if (!root.isDirectory()) return false;

      const resultPath = join(inputPath, RESULT_JSON);
      if (await deps.fs.exists(resultPath)) {
        try {
          return looksLikeTelegramJson(await readMarkerPrefix(resultPath, deps));
        } catch {
          return false;
        }
      }

      const htmlPath = join(inputPath, MESSAGES_HTML);
      if (await deps.fs.exists(htmlPath)) {
        try {
          return looksLikeTelegramHtml(await readMarkerPrefix(htmlPath, deps));
        } catch {
          return true;
        }
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
    const resultPath = join(inputPath, RESULT_JSON);

    ctx.onProgress({ phase: 'discover', processed: 0, total: null, message: null });
    if (ctx.signal.aborted) return { recordCount, skipped };

    try {
      ctx.onProgress({ phase: 'parse', processed: 0, total: null, message: null });
      const seenSourceRefs = new Set<string>();
      for await (const { message, chat } of streamTelegramMessages(resultPath, ctx)) {
        if (ctx.signal.aborted) break;
        const normalized = normalizeMessage(message, chat);
        if ('reason' in normalized) {
          skipped.push(normalized);
          ctx.onSkip(normalized);
          continue;
        }
        if (!seenSourceRefs.has(normalized.sourceRef)) {
          seenSourceRefs.add(normalized.sourceRef);
          recordCount += 1;
          ctx.onProgress({ phase: 'emit', processed: recordCount, total: null });
          yield normalized;
        }

        for (const mediaPath of mediaRefs(message)) {
          if (ctx.signal.aborted) break;
          const media = await normalizeMediaRecord(
            inputPath,
            message,
            chat,
            mediaPath,
            ctx,
            skipped,
          );
          if (media === null || seenSourceRefs.has(media.sourceRef)) continue;
          seenSourceRefs.add(media.sourceRef);
          recordCount += 1;
          ctx.onProgress({ phase: 'emit', processed: recordCount, total: null });
          yield media;
        }
      }
    } catch (error) {
      recordSkip(
        ctx,
        skipped,
        RESULT_JSON,
        `could not read Telegram result.json: ${errorMessage(error)}`,
        'E_READ_JSON',
      );
    }

    return { recordCount, skipped };
  },
};
