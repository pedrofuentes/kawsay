import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { drainImporter } from '../../electron/main/importers/drain';
import { imessageImporter } from '../../electron/main/importers/imessage-importer';
import type {
  CatalogRecord,
  FileStat,
  FsLike,
  ImportContext,
  ImporterDeps,
  ImportProgress,
  SkippedItem,
} from '../../electron/main/importers/types';
import { makeTmpDir, removeTmpDir } from '../helpers/tmp';

const WORK = '/work/imessage';
const APPLE_EPOCH_MS = Date.UTC(2001, 0, 1);

function appleNs(iso: string): number {
  return (Date.parse(iso) - APPLE_EPOCH_MS) * 1_000_000;
}

function makeContext(
  deps: ImporterDeps,
  signal?: AbortSignal,
): { ctx: ImportContext; skips: SkippedItem[]; progress: Partial<ImportProgress>[] } {
  const skips: SkippedItem[] = [];
  const progress: Partial<ImportProgress>[] = [];
  return {
    skips,
    progress,
    ctx: {
      sourceId: 'src-imessage',
      workDir: WORK,
      signal: signal ?? new AbortController().signal,
      deps,
      onSkip: (item) => skips.push(item),
      onProgress: (update) => progress.push(update),
    },
  };
}

function depsForRealDir(): ImporterDeps {
  const fs: FsLike = {
    async readFile(path: string): Promise<Buffer> {
      return await import('node:fs/promises').then((fs) => fs.readFile(path));
    },
    async readDir(path: string): Promise<readonly string[]> {
      return await import('node:fs/promises').then((fs) => fs.readdir(path));
    },
    async stat(path: string): Promise<FileStat> {
      return await import('node:fs/promises').then((fs) => fs.stat(path));
    },
    async exists(path: string): Promise<boolean> {
      return await import('node:fs/promises')
        .then((fs) => fs.access(path))
        .then(
          () => true,
          () => false,
        );
    },
  };
  return {
    fs,
    extractArchive: async () => [],
    readExif: async () => null,
    probeMedia: async () => ({ durationSec: null, width: null, height: null, mimeType: null }),
    hashFile: async () => 'deadbeef',
  };
}

function createMessagesDb(root: string, rows: { text: string; date: number; fromMe?: boolean }[]): void {
  mkdirSync(join(root, 'Attachments'), { recursive: true });
  const db = new Database(join(root, 'chat.db'));
  try {
    db.exec(`
      CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
      CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, display_name TEXT);
      CREATE TABLE message (
        ROWID INTEGER PRIMARY KEY,
        guid TEXT,
        text TEXT,
        date INTEGER,
        is_from_me INTEGER,
        handle_id INTEGER,
        service TEXT
      );
      CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
      INSERT INTO handle (ROWID, id) VALUES (1, '+15551234567');
      INSERT INTO chat (ROWID, guid, display_name) VALUES (7, 'iMessage;-;+15551234567', 'Mamá');
    `);
    const insert = db.prepare(
      `INSERT INTO message (ROWID, guid, text, date, is_from_me, handle_id, service)
       VALUES (@id, @guid, @text, @date, @isFromMe, 1, @service)`,
    );
    const joinMessage = db.prepare(
      'INSERT INTO chat_message_join (chat_id, message_id) VALUES (7, @id)',
    );
    rows.forEach((row, index) => {
      const id = index + 1;
      insert.run({
        id,
        guid: `msg-${id}`,
        text: row.text,
        date: row.date,
        isFromMe: row.fromMe ? 1 : 0,
        service: row.fromMe ? 'SMS' : 'iMessage',
      });
      joinMessage.run({ id });
    });
  } finally {
    db.close();
  }
}

async function run(inputPath: string, deps: ImporterDeps, signal?: AbortSignal) {
  const c = makeContext(deps, signal);
  const records: CatalogRecord[] = [];
  const result = await drainImporter(imessageImporter, inputPath, c.ctx, (r) => records.push(r));
  return { ...c, records, result, byRef: new Map(records.map((r) => [r.sourceRef, r])) };
}

describe('imessageImporter (M3 — macOS Messages chat.db connector)', () => {
  it('identifies itself as the imessage source', () => {
    expect(imessageImporter.id).toBe('imessage');
    expect(imessageImporter.displayName).toBe('iMessage/SMS');
  });

  it('canHandle accepts only a macOS Messages folder with chat.db and Attachments', async () => {
    const dir = makeTmpDir('imessage-can-');
    const plain = makeTmpDir('imessage-plain-');
    try {
      createMessagesDb(dir, [{ text: 'hola', date: appleNs('2024-02-03T04:05:06.000Z') }]);
      mkdirSync(join(plain, 'Attachments'), { recursive: true });
      new Database(join(plain, 'chat.db')).close();

      expect(await imessageImporter.canHandle(dir, depsForRealDir())).toBe(true);
      expect(await imessageImporter.canHandle(plain, depsForRealDir())).toBe(false);
    } finally {
      removeTmpDir(dir);
      removeTmpDir(plain);
    }
  });

  it('extracts chat.db messages with sender, Apple-epoch date, bounded text, and provenance', async () => {
    const dir = makeTmpDir('imessage-import-');
    try {
      createMessagesDb(dir, [
        { text: 'hola mamá', date: appleNs('2024-02-03T04:05:06.000Z') },
        { text: 'x'.repeat(25_000), date: appleNs('2024-02-03T04:06:07.000Z'), fromMe: true },
      ]);

      const { records, result, byRef, skips } = await run(dir, depsForRealDir());

      expect(result.recordCount).toBe(2);
      expect(skips).toEqual([]);
      expect(records.every((r) => r.sourceType === 'imessage')).toBe(true);
      expect(records.every((r) => r.mediaType === 'message')).toBe(true);
      expect(byRef.get('message:1')).toMatchObject({
        author: '+15551234567',
        body: 'hola mamá',
        originalPath: null,
        sourceMeta: {
          chatGuid: 'iMessage;-;+15551234567',
          chatName: 'Mamá',
          service: 'iMessage',
          isFromMe: false,
        },
      });
      expect(byRef.get('message:1')?.date?.source).toBe('message');
      expect(byRef.get('message:1')?.date?.value.toISOString()).toBe('2024-02-03T04:05:06.000Z');
      expect(byRef.get('message:2')?.author).toBe('Me');
      expect(byRef.get('message:2')?.body).toHaveLength(20_000);
    } finally {
      removeTmpDir(dir);
    }
  });

  it('honors an already-aborted signal without opening or emitting chat rows', async () => {
    const dir = makeTmpDir('imessage-abort-');
    const controller = new AbortController();
    try {
      createMessagesDb(dir, [{ text: 'do not emit', date: appleNs('2024-02-03T04:05:06.000Z') }]);
      controller.abort();

      const { records, result } = await run(dir, depsForRealDir(), controller.signal);

      expect(records).toEqual([]);
      expect(result.recordCount).toBe(0);
      expect(result.skipped).toEqual([]);
    } finally {
      removeTmpDir(dir);
    }
  });
});
