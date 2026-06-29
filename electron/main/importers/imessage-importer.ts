import { open } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import type { MediaType } from '@shared/catalog';
import Database, { type Database as SqliteDatabase } from 'better-sqlite3';
import type {
  CatalogRecord,
  ImportContext,
  Importer,
  ImporterDeps,
  ImportResult,
  SkippedItem,
} from './types';

const CHAT_DB = 'chat.db';
const ATTACHMENTS_DIR = 'Attachments';
const APPLE_EPOCH_MS = Date.UTC(2001, 0, 1);
const MAX_DTO_STRING_CHARS = 20_000;
const MAX_META_STRING_CHARS = 1_000;
const SQLITE_HEADER = Buffer.from('SQLite format 3\0', 'ascii');

interface MessageRow {
  rowid: number;
  guid: string | null;
  text: string | null;
  date: number | bigint | null;
  isFromMe: number | null;
  handleId: string | null;
  service: string | null;
  chatGuid: string | null;
  chatName: string | null;
  chatGuids: string | null;
  chatNames: string | null;
  attachmentRowid: number | null;
  attachmentGuid: string | null;
  attachmentFilename: string | null;
  attachmentMimeType: string | null;
  attachmentTransferName: string | null;
}

interface AttachmentInfo {
  mediaType: Extract<MediaType, 'photo' | 'video' | 'audio'>;
  mimeType: string;
}

const ATTACHMENT_EXTENSIONS = new Map<string, AttachmentInfo>([
  ['.jpg', { mediaType: 'photo', mimeType: 'image/jpeg' }],
  ['.jpeg', { mediaType: 'photo', mimeType: 'image/jpeg' }],
  ['.png', { mediaType: 'photo', mimeType: 'image/png' }],
  ['.gif', { mediaType: 'photo', mimeType: 'image/gif' }],
  ['.webp', { mediaType: 'photo', mimeType: 'image/webp' }],
  ['.heic', { mediaType: 'photo', mimeType: 'image/heic' }],
  ['.heif', { mediaType: 'photo', mimeType: 'image/heif' }],
  ['.mov', { mediaType: 'video', mimeType: 'video/quicktime' }],
  ['.mp4', { mediaType: 'video', mimeType: 'video/mp4' }],
  ['.m4v', { mediaType: 'video', mimeType: 'video/x-m4v' }],
  ['.avi', { mediaType: 'video', mimeType: 'video/x-msvideo' }],
  ['.webm', { mediaType: 'video', mimeType: 'video/webm' }],
  ['.mp3', { mediaType: 'audio', mimeType: 'audio/mpeg' }],
  ['.wav', { mediaType: 'audio', mimeType: 'audio/wav' }],
  ['.m4a', { mediaType: 'audio', mimeType: 'audio/mp4' }],
  ['.aac', { mediaType: 'audio', mimeType: 'audio/aac' }],
  ['.flac', { mediaType: 'audio', mimeType: 'audio/flac' }],
  ['.ogg', { mediaType: 'audio', mimeType: 'audio/ogg' }],
  ['.opus', { mediaType: 'audio', mimeType: 'audio/opus' }],
]);

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

function splitSqlList(value: string | null): string[] {
  if (value === null || value.length === 0) return [];
  return value.split('\u001f').map((part) => boundString(part, MAX_META_STRING_CHARS));
}

function openMessagesDb(chatDbPath: string): SqliteDatabase {
  return new Database(chatDbPath, { readonly: true, fileMustExist: true });
}

async function hasSqliteHeader(chatDbPath: string): Promise<boolean> {
  const handle = await open(chatDbPath, 'r');
  try {
    const header = Buffer.alloc(SQLITE_HEADER.length);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    return bytesRead === SQLITE_HEADER.length && header.equals(SQLITE_HEADER);
  } finally {
    await handle.close();
  }
}

function hasAttachmentSchema(db: SqliteDatabase): boolean {
  const rows = db
    .prepare(
      `SELECT name
       FROM sqlite_master
       WHERE type = 'table' AND name IN ('attachment', 'message_attachment_join')`,
    )
    .all<{ name: string }>();
  return rows.length === 2;
}

function appleDate(raw: number | bigint | null): { value: Date; source: 'message' } | null {
  if (raw === null) return null;
  const n = typeof raw === 'bigint' ? Number(raw) : raw;
  if (!Number.isFinite(n)) return null;
  const abs = Math.abs(n);
  let deltaMs: number;
  if (abs >= 100_000_000_000_000) deltaMs = n / 1_000_000;
  else if (abs >= 100_000_000_000) deltaMs = n / 1_000;
  else deltaMs = n * 1_000;
  const value = new Date(APPLE_EPOCH_MS + deltaMs);
  return Number.isFinite(value.getTime()) ? { value, source: 'message' } : null;
}

function baseSourceMeta(row: MessageRow): Record<string, unknown> {
  const chatGuids = splitSqlList(row.chatGuids);
  const chatNames = splitSqlList(row.chatNames);
  return {
    messageGuid: nullableBound(row.guid, MAX_META_STRING_CHARS),
    chatGuid: nullableBound(row.chatGuid, MAX_META_STRING_CHARS),
    chatName: nullableBound(row.chatName, MAX_META_STRING_CHARS),
    chatGuids,
    chatNames,
    service: nullableBound(row.service, MAX_META_STRING_CHARS),
    isFromMe: row.isFromMe === 1,
    handleId: nullableBound(row.handleId, MAX_META_STRING_CHARS),
    rawDate: row.date === null ? null : String(row.date),
  };
}

function normalizeMessageRow(row: MessageRow): CatalogRecord | SkippedItem | null {
  if (row.text === null) {
    return row.attachmentRowid === null
      ? {
          ref: `message:${row.rowid}`,
          reason: 'message has no text or supported attachment',
          code: 'E_EMPTY_MESSAGE',
        }
      : null;
  }
  const isFromMe = row.isFromMe === 1;
  const author = isFromMe ? 'Me' : nullableBound(row.handleId, MAX_META_STRING_CHARS);
  return {
    sourceType: 'imessage',
    mediaType: 'message',
    originalPath: null,
    mimeType: null,
    date: appleDate(row.date),
    author,
    body: nullableBound(row.text),
    gps: null,
    durationSec: null,
    sourceRef: `message:${row.rowid}`,
    sourceMeta: baseSourceMeta(row),
  };
}

function classifyAttachment(pathOrName: string, mimeType: string | null): AttachmentInfo | null {
  const normalizedMime = mimeType?.toLowerCase() ?? null;
  const byExt = ATTACHMENT_EXTENSIONS.get(extname(pathOrName).toLowerCase()) ?? null;
  if (normalizedMime?.startsWith('image/')) {
    return { mediaType: 'photo', mimeType: mimeType ?? byExt?.mimeType ?? 'application/octet-stream' };
  }
  if (normalizedMime?.startsWith('video/')) {
    return { mediaType: 'video', mimeType: mimeType ?? byExt?.mimeType ?? 'application/octet-stream' };
  }
  if (normalizedMime?.startsWith('audio/')) {
    return { mediaType: 'audio', mimeType: mimeType ?? byExt?.mimeType ?? 'application/octet-stream' };
  }
  return byExt;
}

function resolveAttachmentPath(
  inputPath: string,
  filename: string | null,
  transferName: string | null,
): { absPath: string; relativePath: string; fileName: string } | null {
  const raw = filename ?? transferName;
  if (raw === null) return null;
  const normalized = raw.replace(/\\/g, '/');
  const attachmentsMarker = '/Attachments/';
  const markerIndex = normalized.lastIndexOf(attachmentsMarker);
  const relative =
    markerIndex >= 0
      ? normalized.slice(markerIndex + attachmentsMarker.length)
      : normalized.startsWith('Attachments/')
        ? normalized.slice('Attachments/'.length)
        : normalized.replace(/^~?\/*(?:Library\/Messages\/)?/, '');
  const parts = relative.split('/').filter((part) => part.length > 0);
  if (parts.length === 0 || parts.some((part) => part === '.' || part === '..')) return null;
  const relativePath = parts.join('/');
  return {
    absPath: join(inputPath, ATTACHMENTS_DIR, ...parts),
    relativePath,
    fileName: nullableBound(transferName, MAX_META_STRING_CHARS) ?? basename(relativePath),
  };
}

async function normalizeAttachmentRow(
  inputPath: string,
  row: MessageRow,
  ctx: ImportContext,
  skipped: SkippedItem[],
): Promise<CatalogRecord | null> {
  if (row.attachmentRowid === null) return null;
  const attachmentRef = `message:${row.rowid}:attachment:${row.attachmentRowid}`;
  const resolved = resolveAttachmentPath(inputPath, row.attachmentFilename, row.attachmentTransferName);
  if (resolved === null) {
    recordSkip(ctx, skipped, attachmentRef, 'attachment path is missing or unsafe', 'E_ATTACHMENT_PATH');
    return null;
  }
  const info = classifyAttachment(resolved.fileName, row.attachmentMimeType);
  if (info === null) {
    recordSkip(ctx, skipped, attachmentRef, 'attachment type is not supported', 'E_ATTACHMENT_TYPE');
    return null;
  }
  try {
    const stat = await ctx.deps.fs.stat(resolved.absPath);
    if (!stat.isFile()) {
      recordSkip(ctx, skipped, attachmentRef, 'attachment path is not a file', 'E_ATTACHMENT_FILE');
      return null;
    }
  } catch (error) {
    recordSkip(ctx, skipped, attachmentRef, `attachment file is missing: ${String(error)}`, 'E_ATTACHMENT_MISSING');
    return null;
  }
  const isFromMe = row.isFromMe === 1;
  return {
    sourceType: 'imessage',
    mediaType: info.mediaType,
    originalPath: resolved.absPath,
    mimeType: row.attachmentMimeType ?? info.mimeType,
    date: appleDate(row.date),
    author: isFromMe ? 'Me' : nullableBound(row.handleId, MAX_META_STRING_CHARS),
    body: nullableBound(row.text),
    gps: null,
    durationSec: null,
    sourceRef: attachmentRef,
    sourceMeta: {
      ...baseSourceMeta(row),
      parentMessageRef: `message:${row.rowid}`,
      attachmentGuid: nullableBound(row.attachmentGuid, MAX_META_STRING_CHARS),
      attachmentFileName: resolved.fileName,
      attachmentRelativePath: resolved.relativePath,
    },
  };
}

export const imessageImporter: Importer = {
  id: 'imessage',
  displayName: 'iMessage/SMS',

  async canHandle(inputPath: string, deps: ImporterDeps): Promise<boolean> {
    try {
      const root = await deps.fs.stat(inputPath);
      if (!root.isDirectory()) return false;
      const chatDbPath = join(inputPath, CHAT_DB);
      const attachmentsPath = join(inputPath, ATTACHMENTS_DIR);
      if (!(await deps.fs.exists(chatDbPath))) return false;
      const attachments = await deps.fs.stat(attachmentsPath);
      if (!attachments.isDirectory()) return false;
      return await hasSqliteHeader(chatDbPath);
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

    const chatDbPath = join(inputPath, CHAT_DB);
    let db: SqliteDatabase;
    try {
      db = openMessagesDb(chatDbPath);
    } catch (error) {
      recordSkip(
        ctx,
        skipped,
        CHAT_DB,
        `could not open Messages chat.db: ${String(error)}`,
        'E_OPEN_DB',
      );
      return { recordCount, skipped };
    }

    try {
      ctx.onProgress({ phase: 'parse', processed: 0, total: null, message: null });
      const seenSourceRefs = new Set<string>();
      const attachmentSchema = hasAttachmentSchema(db);
      const attachmentColumns = attachmentSchema
        ? `a.ROWID AS attachmentRowid,
          a.guid AS attachmentGuid,
          a.filename AS attachmentFilename,
          a.mime_type AS attachmentMimeType,
          a.transfer_name AS attachmentTransferName`
        : `NULL AS attachmentRowid,
          NULL AS attachmentGuid,
          NULL AS attachmentFilename,
          NULL AS attachmentMimeType,
          NULL AS attachmentTransferName`;
      const attachmentJoins = attachmentSchema
        ? `LEFT JOIN message_attachment_join maj ON maj.message_id = m.ROWID
        LEFT JOIN attachment a ON a.ROWID = maj.attachment_id`
        : '';
      const attachmentOrder = attachmentSchema ? ', a.ROWID ASC' : '';
      const rows = db.prepare(`
        SELECT
          m.ROWID AS rowid,
          m.guid AS guid,
          m.text AS text,
          m.date AS date,
          m.is_from_me AS isFromMe,
          h.id AS handleId,
          m.service AS service,
          (
            SELECT c2.guid
            FROM chat_message_join cmj2
            LEFT JOIN chat c2 ON c2.ROWID = cmj2.chat_id
            WHERE cmj2.message_id = m.ROWID
            ORDER BY c2.ROWID ASC
            LIMIT 1
          ) AS chatGuid,
          (
            SELECT c2.display_name
            FROM chat_message_join cmj2
            LEFT JOIN chat c2 ON c2.ROWID = cmj2.chat_id
            WHERE cmj2.message_id = m.ROWID
            ORDER BY c2.ROWID ASC
            LIMIT 1
          ) AS chatName,
          (
            SELECT GROUP_CONCAT(guid, char(31))
            FROM (
              SELECT DISTINCT c2.guid AS guid, c2.ROWID AS rowid
              FROM chat_message_join cmj2
              LEFT JOIN chat c2 ON c2.ROWID = cmj2.chat_id
              WHERE cmj2.message_id = m.ROWID AND c2.guid IS NOT NULL
              ORDER BY c2.ROWID ASC
            )
          ) AS chatGuids,
          (
            SELECT GROUP_CONCAT(display_name, char(31))
            FROM (
              SELECT DISTINCT c2.display_name AS display_name, c2.ROWID AS rowid
              FROM chat_message_join cmj2
              LEFT JOIN chat c2 ON c2.ROWID = cmj2.chat_id
              WHERE cmj2.message_id = m.ROWID AND c2.display_name IS NOT NULL
              ORDER BY c2.ROWID ASC
            )
          ) AS chatNames,
          ${attachmentColumns}
        FROM message m
        LEFT JOIN handle h ON h.ROWID = m.handle_id
        ${attachmentJoins}
        ORDER BY m.date ASC, m.ROWID ASC${attachmentOrder}
      `);

      for (const row of rows.iterate<MessageRow>()) {
        if (ctx.signal.aborted) break;
        try {
          const normalized = normalizeMessageRow(row);
          if (normalized && 'reason' in normalized) {
            skipped.push(normalized);
            ctx.onSkip(normalized);
          } else if (normalized && !seenSourceRefs.has(normalized.sourceRef)) {
            seenSourceRefs.add(normalized.sourceRef);
            recordCount += 1;
            ctx.onProgress({ phase: 'emit', processed: recordCount, total: null });
            yield normalized;
          }
          if (ctx.signal.aborted) break;
          const attachment = await normalizeAttachmentRow(inputPath, row, ctx, skipped);
          if (attachment === null || seenSourceRefs.has(attachment.sourceRef)) {
            continue;
          }
          seenSourceRefs.add(attachment.sourceRef);
          recordCount += 1;
          ctx.onProgress({ phase: 'emit', processed: recordCount, total: null });
          yield attachment;
        } catch (error) {
          recordSkip(
            ctx,
            skipped,
            `message:${row.rowid}`,
            `could not normalize message: ${String(error)}`,
            'E_PARSE_MESSAGE',
          );
        }
      }
    } catch (error) {
      recordSkip(
        ctx,
        skipped,
        CHAT_DB,
        `could not read Messages chat.db: ${String(error)}`,
        'E_READ_DB',
      );
    } finally {
      db.close();
    }

    return { recordCount, skipped };
  },
};
