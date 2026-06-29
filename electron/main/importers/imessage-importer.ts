import { join } from 'node:path';
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

function openMessagesDb(chatDbPath: string): SqliteDatabase {
  return new Database(chatDbPath, { readonly: true, fileMustExist: true });
}

function hasMessagesSchema(db: SqliteDatabase): boolean {
  const required = new Set(['message', 'handle', 'chat']);
  const rows = db
    .prepare(
      `SELECT name
       FROM sqlite_master
       WHERE type = 'table' AND name IN ('message', 'handle', 'chat')`,
    )
    .all<{ name: string }>();
  for (const row of rows) required.delete(row.name);
  return required.size === 0;
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

function normalizeRow(row: MessageRow): CatalogRecord | SkippedItem {
  if (row.text === null) {
    return {
      ref: `message:${row.rowid}`,
      reason: 'message has no text; iMessage attachments are deferred for this connector slice',
      code: 'E_DEFERRED_ATTACHMENT',
    };
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
    sourceMeta: {
      messageGuid: nullableBound(row.guid, MAX_META_STRING_CHARS),
      chatGuid: nullableBound(row.chatGuid, MAX_META_STRING_CHARS),
      chatName: nullableBound(row.chatName, MAX_META_STRING_CHARS),
      service: nullableBound(row.service, MAX_META_STRING_CHARS),
      isFromMe,
      handleId: nullableBound(row.handleId, MAX_META_STRING_CHARS),
      rawDate: row.date === null ? null : String(row.date),
      attachmentsDeferred: true,
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
      const db = openMessagesDb(chatDbPath);
      try {
        return hasMessagesSchema(db);
      } finally {
        db.close();
      }
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
      const rows = db.prepare(`
        SELECT
          m.ROWID AS rowid,
          m.guid AS guid,
          m.text AS text,
          m.date AS date,
          m.is_from_me AS isFromMe,
          h.id AS handleId,
          m.service AS service,
          c.guid AS chatGuid,
          c.display_name AS chatName
        FROM message m
        LEFT JOIN handle h ON h.ROWID = m.handle_id
        LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
        LEFT JOIN chat c ON c.ROWID = cmj.chat_id
        ORDER BY m.date ASC, m.ROWID ASC
      `);

      for (const row of rows.iterate<MessageRow>()) {
        if (ctx.signal.aborted) break;
        try {
          const normalized = normalizeRow(row);
          if ('reason' in normalized) {
            skipped.push(normalized);
            ctx.onSkip(normalized);
            continue;
          }
          recordCount += 1;
          ctx.onProgress({ phase: 'emit', processed: recordCount, total: null });
          yield normalized;
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
