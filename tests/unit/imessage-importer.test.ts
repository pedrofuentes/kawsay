import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
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

function createMessagesDb(
  root: string,
  rows: { text: string; date: number; fromMe?: boolean }[],
): void {
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

function createMessagesDbWithMaliciousAttachment(root: string, filename: string): void {
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
      CREATE TABLE attachment (
        ROWID INTEGER PRIMARY KEY,
        guid TEXT,
        filename TEXT,
        mime_type TEXT,
        total_bytes INTEGER,
        transfer_name TEXT
      );
      CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER);
      INSERT INTO handle (ROWID, id) VALUES (1, '+15551234567');
      INSERT INTO chat (ROWID, guid, display_name) VALUES (7, 'iMessage;-;+15551234567', 'Mamá');
      INSERT INTO message (ROWID, guid, text, date, is_from_me, handle_id, service)
        VALUES (1, 'msg-1', 'look', ${appleNs('2024-02-03T04:05:06.000Z')}, 0, 1, 'iMessage');
      INSERT INTO chat_message_join (chat_id, message_id) VALUES (7, 1);
      INSERT INTO attachment (ROWID, guid, filename, mime_type, total_bytes, transfer_name) VALUES
        (10, 'att-evil', '${filename}', 'image/jpeg', 11, 'escape.jpg');
      INSERT INTO message_attachment_join (message_id, attachment_id) VALUES (1, 10);
    `);
  } finally {
    db.close();
  }
}

function normalizePath(path: string): string {
  return path.split(/[\\/]/).join('/');
}

function createMessagesDbWithAttachments(root: string): void {
  mkdirSync(join(root, 'Attachments', 'aa'), { recursive: true });
  mkdirSync(join(root, 'Attachments', 'bb'), { recursive: true });
  mkdirSync(join(root, 'Attachments', 'cc'), { recursive: true });
  writeFileSync(join(root, 'Attachments', 'aa', 'IMG_0001.JPG'), 'photo-bytes');
  writeFileSync(join(root, 'Attachments', 'bb', 'clip.MOV'), 'video-bytes');
  writeFileSync(join(root, 'Attachments', 'cc', 'voice.m4a'), 'audio-bytes');

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
      CREATE TABLE attachment (
        ROWID INTEGER PRIMARY KEY,
        guid TEXT,
        filename TEXT,
        mime_type TEXT,
        total_bytes INTEGER,
        transfer_name TEXT
      );
      CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER);
      INSERT INTO handle (ROWID, id) VALUES (1, '+15551234567');
      INSERT INTO chat (ROWID, guid, display_name) VALUES
        (7, 'iMessage;-;+15551234567', 'Mamá'),
        (8, 'iMessage;-;family', 'Familia');
      INSERT INTO message (ROWID, guid, text, date, is_from_me, handle_id, service)
        VALUES (1, 'msg-1', 'look at these', ${appleNs('2024-02-03T04:05:06.000Z')}, 0, 1, 'iMessage');
      INSERT INTO chat_message_join (chat_id, message_id) VALUES (7, 1), (8, 1);
      INSERT INTO attachment (ROWID, guid, filename, mime_type, total_bytes, transfer_name) VALUES
        (10, 'att-photo', '~/Library/Messages/Attachments/aa/IMG_0001.JPG', 'image/jpeg', 11, 'IMG_0001.JPG'),
        (11, 'att-video', 'Attachments/bb/clip.MOV', 'video/quicktime', 11, 'clip.MOV'),
        (12, 'att-audio', 'cc/voice.m4a', 'audio/mp4', 11, 'voice.m4a');
      INSERT INTO message_attachment_join (message_id, attachment_id) VALUES (1, 10), (1, 11), (1, 12);
    `);
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

  it('canHandle accepts only a Messages-shaped folder using the SQLite header marker', async () => {
    const dir = makeTmpDir('imessage-can-');
    const plain = makeTmpDir('imessage-plain-');
    try {
      mkdirSync(join(dir, 'Attachments'), { recursive: true });
      writeFileSync(join(dir, 'chat.db'), Buffer.from('SQLite format 3\0rest of file'));
      mkdirSync(join(plain, 'Attachments'), { recursive: true });
      writeFileSync(join(plain, 'chat.db'), 'not sqlite');

      expect(await imessageImporter.canHandle(dir, depsForRealDir())).toBe(true);
      expect(await imessageImporter.canHandle(plain, depsForRealDir())).toBe(false);
    } finally {
      removeTmpDir(dir);
      removeTmpDir(plain);
    }
  });

  it('emits linked photo, video, and audio attachments once when a message appears in multiple chats', async () => {
    const dir = makeTmpDir('imessage-attachments-');
    try {
      createMessagesDbWithAttachments(dir);

      const { records, result, byRef, skips } = await run(dir, depsForRealDir());

      expect(result.recordCount).toBe(4);
      expect(skips).toEqual([]);
      expect(records.map((r) => r.sourceRef)).toEqual([
        'message:1',
        'message:1:attachment:10',
        'message:1:attachment:11',
        'message:1:attachment:12',
      ]);
      expect(byRef.get('message:1')?.sourceMeta).toMatchObject({
        chatGuid: 'iMessage;-;+15551234567',
        chatName: 'Mamá',
        chatGuids: ['iMessage;-;+15551234567', 'iMessage;-;family'],
      });

      const photo = byRef.get('message:1:attachment:10');
      const video = byRef.get('message:1:attachment:11');
      const audio = byRef.get('message:1:attachment:12');
      expect(photo).toMatchObject({
        mediaType: 'photo',
        mimeType: 'image/jpeg',
        body: 'look at these',
        author: '+15551234567',
        sourceMeta: {
          parentMessageRef: 'message:1',
          attachmentGuid: 'att-photo',
          attachmentFileName: 'IMG_0001.JPG',
          attachmentRelativePath: 'aa/IMG_0001.JPG',
        },
      });
      expect(normalizePath(photo?.originalPath ?? '')).toContain('/Attachments/aa/IMG_0001.JPG');
      expect(video).toMatchObject({ mediaType: 'video', mimeType: 'video/quicktime' });
      expect(normalizePath(video?.originalPath ?? '')).toContain('/Attachments/bb/clip.MOV');
      expect(audio).toMatchObject({ mediaType: 'audio', mimeType: 'audio/mp4' });
      expect(normalizePath(audio?.originalPath ?? '')).toContain('/Attachments/cc/voice.m4a');
      expect(photo?.date?.value.toISOString()).toBe('2024-02-03T04:05:06.000Z');
    } finally {
      removeTmpDir(dir);
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

  it('skips a traversal attachment filename and never stats or copies outside the Attachments root', async () => {
    const dir = makeTmpDir('imessage-traversal-');
    const escapeFile = join(dir, '..', 'escape.jpg');
    try {
      createMessagesDbWithMaliciousAttachment(dir, '../../escape.jpg');
      writeFileSync(escapeFile, 'escaped-bytes');

      const realDeps = depsForRealDir();
      const statPaths: string[] = [];
      const deps: ImporterDeps = {
        ...realDeps,
        fs: {
          ...realDeps.fs,
          async stat(path: string): Promise<FileStat> {
            statPaths.push(path);
            return await realDeps.fs.stat(path);
          },
        },
      };

      const { records, result, skips } = await run(dir, deps);

      expect(records.some((r) => r.sourceRef === 'message:1:attachment:10')).toBe(false);
      expect(skips).toContainEqual(
        expect.objectContaining({
          ref: 'message:1:attachment:10',
          code: 'E_ATTACHMENT_PATH',
        }),
      );
      expect(records.some((r) => (r.originalPath ?? '').includes('escape.jpg'))).toBe(false);

      const safeRoot = normalizePath(join(dir, 'Attachments'));
      for (const statted of statPaths.map(normalizePath)) {
        expect(statted.startsWith(safeRoot) || statted.startsWith(normalizePath(dir))).toBe(true);
        expect(statted).not.toContain('/escape.jpg');
      }
      expect(result.recordCount).toBe(1);
    } finally {
      removeTmpDir(dir);
      try {
        rmSync(escapeFile, { force: true });
      } catch {
        /* ignore */
      }
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
