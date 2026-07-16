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

function createMessagesDbEmptyMessage(root: string): void {
  mkdirSync(join(root, 'Attachments'), { recursive: true });
  const db = new Database(join(root, 'chat.db'));
  try {
    db.exec(`
      CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
      CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, display_name TEXT);
      CREATE TABLE message (
        ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, date INTEGER,
        is_from_me INTEGER, handle_id INTEGER, service TEXT
      );
      CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
      INSERT INTO handle (ROWID, id) VALUES (1, '+15551234567');
      INSERT INTO chat (ROWID, guid, display_name) VALUES (7, 'iMessage;-;+15551234567', 'Mamá');
      INSERT INTO message (ROWID, guid, text, date, is_from_me, handle_id, service)
        VALUES (1, 'msg-1', NULL, ${appleNs('2024-02-03T04:05:06.000Z')}, 0, 1, 'iMessage');
      INSERT INTO chat_message_join (chat_id, message_id) VALUES (7, 1);
    `);
  } finally {
    db.close();
  }
}

function createMessagesDbNullTextWithAttachment(root: string): void {
  mkdirSync(join(root, 'Attachments'), { recursive: true });
  writeFileSync(join(root, 'Attachments', 'clip.mov'), 'video-bytes');
  const db = new Database(join(root, 'chat.db'));
  try {
    db.exec(`
      CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
      CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, display_name TEXT);
      CREATE TABLE message (
        ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, date INTEGER,
        is_from_me INTEGER, handle_id INTEGER, service TEXT
      );
      CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
      CREATE TABLE attachment (
        ROWID INTEGER PRIMARY KEY, guid TEXT, filename TEXT, mime_type TEXT,
        total_bytes INTEGER, transfer_name TEXT
      );
      CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER);
      INSERT INTO handle (ROWID, id) VALUES (1, '+15551234567');
      INSERT INTO chat (ROWID, guid, display_name) VALUES (7, 'iMessage;-;+15551234567', 'Mamá');
      INSERT INTO message (ROWID, guid, text, date, is_from_me, handle_id, service)
        VALUES (1, 'msg-1', NULL, ${appleNs('2024-02-03T04:05:06.000Z')}, 0, 1, 'iMessage');
      INSERT INTO chat_message_join (chat_id, message_id) VALUES (7, 1);
      INSERT INTO attachment (ROWID, guid, filename, mime_type, total_bytes, transfer_name) VALUES
        (10, 'att-video', 'clip.mov', NULL, 11, 'clip.mov');
      INSERT INTO message_attachment_join (message_id, attachment_id) VALUES (1, 10);
    `);
  } finally {
    db.close();
  }
}

function createMessagesDbWithOneAttachment(
  root: string,
  attachment: { filename: string; mimeType: string | null },
  fileFixture?: 'file' | 'dir' | 'missing',
): void {
  mkdirSync(join(root, 'Attachments'), { recursive: true });
  if (fileFixture === 'file') {
    writeFileSync(join(root, 'Attachments', attachment.filename), 'bytes');
  } else if (fileFixture === 'dir') {
    mkdirSync(join(root, 'Attachments', attachment.filename), { recursive: true });
  }
  const db = new Database(join(root, 'chat.db'));
  try {
    db.exec(`
      CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
      CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, display_name TEXT);
      CREATE TABLE message (
        ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, date INTEGER,
        is_from_me INTEGER, handle_id INTEGER, service TEXT
      );
      CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
      CREATE TABLE attachment (
        ROWID INTEGER PRIMARY KEY, guid TEXT, filename TEXT, mime_type TEXT,
        total_bytes INTEGER, transfer_name TEXT
      );
      CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER);
      INSERT INTO handle (ROWID, id) VALUES (1, '+15551234567');
      INSERT INTO chat (ROWID, guid, display_name) VALUES (7, 'iMessage;-;+15551234567', 'Mamá');
      INSERT INTO message (ROWID, guid, text, date, is_from_me, handle_id, service)
        VALUES (1, 'msg-1', 'attached', ${appleNs('2024-02-03T04:05:06.000Z')}, 0, 1, 'iMessage');
      INSERT INTO chat_message_join (chat_id, message_id) VALUES (7, 1);
      INSERT INTO attachment (ROWID, guid, filename, mime_type, total_bytes, transfer_name) VALUES
        (10, 'att-1', '${attachment.filename}', ${attachment.mimeType ? `'${attachment.mimeType}'` : 'NULL'}, 5, '${attachment.filename}');
      INSERT INTO message_attachment_join (message_id, attachment_id) VALUES (1, 10);
    `);
  } finally {
    db.close();
  }
}

function createOrphanMessageDb(root: string): void {
  mkdirSync(join(root, 'Attachments'), { recursive: true });
  const db = new Database(join(root, 'chat.db'));
  try {
    db.exec(`
      CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
      CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, display_name TEXT);
      CREATE TABLE message (
        ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, date INTEGER,
        is_from_me INTEGER, handle_id INTEGER, service TEXT
      );
      CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
      INSERT INTO message (ROWID, guid, text, date, is_from_me, handle_id, service)
        VALUES (1, NULL, 'orphan message', ${appleNs('2024-02-03T04:05:06.000Z')}, 0, NULL, NULL);
    `);
  } finally {
    db.close();
  }
}

function createDateScaleMessagesDb(root: string): void {
  mkdirSync(join(root, 'Attachments'), { recursive: true });
  const db = new Database(join(root, 'chat.db'));
  try {
    db.exec(`
      CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
      CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, display_name TEXT);
      CREATE TABLE message (
        ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, date INTEGER,
        is_from_me INTEGER, handle_id INTEGER, service TEXT
      );
      CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
      INSERT INTO handle (ROWID, id) VALUES (1, '+15551234567');
      INSERT INTO chat (ROWID, guid, display_name) VALUES (7, 'iMessage;-;+15551234567', 'Mamá');
      INSERT INTO message (ROWID, guid, text, date, is_from_me, handle_id, service) VALUES
        (1, 'msg-1', 'microsecond scale', 700000000000, 0, 1, 'iMessage'),
        (2, 'msg-2', 'second scale', 700000000, 0, 1, 'iMessage'),
        (3, 'msg-3', 'no date', NULL, 0, 1, 'iMessage'),
        (4, 'msg-4', 'out-of-range timestamp', 1e22, 0, 1, 'iMessage'),
        (5, 'msg-5', 'corrupted non-numeric timestamp', 'not-a-number', 0, 1, 'iMessage');
      INSERT INTO chat_message_join (chat_id, message_id) VALUES (7, 1), (7, 2), (7, 3), (7, 4), (7, 5);
    `);
  } finally {
    db.close();
  }
}

function createAttachmentPathEdgeCasesDb(root: string): void {
  mkdirSync(join(root, 'Attachments', 'nested', 'dir'), { recursive: true });
  writeFileSync(join(root, 'Attachments', 'nested', 'dir', 'photo.jpg'), 'photo-bytes');
  writeFileSync(join(root, 'Attachments', 'present.jpg'), 'present-bytes');
  const db = new Database(join(root, 'chat.db'));
  try {
    db.exec(`
      CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
      CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, display_name TEXT);
      CREATE TABLE message (
        ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, date INTEGER,
        is_from_me INTEGER, handle_id INTEGER, service TEXT
      );
      CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
      CREATE TABLE attachment (
        ROWID INTEGER PRIMARY KEY, guid TEXT, filename TEXT, mime_type TEXT,
        total_bytes INTEGER, transfer_name TEXT
      );
      CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER);
      INSERT INTO handle (ROWID, id) VALUES (1, '+15551234567');
      INSERT INTO chat (ROWID, guid, display_name) VALUES (7, 'iMessage;-;+15551234567', 'Mamá');
      INSERT INTO message (ROWID, guid, text, date, is_from_me, handle_id, service) VALUES
        (1, 'msg-1', 'from them', ${appleNs('2024-02-03T04:05:06.000Z')}, 0, 1, 'iMessage'),
        (2, 'msg-2', 'no filename or transfer name', ${appleNs('2024-02-03T04:06:06.000Z')}, 0, 1, 'iMessage'),
        (3, 'msg-3', 'from me', ${appleNs('2024-02-03T04:07:06.000Z')}, 1, 1, 'iMessage');
      INSERT INTO chat_message_join (chat_id, message_id) VALUES (7, 1), (7, 2), (7, 3);
      INSERT INTO attachment (ROWID, guid, filename, mime_type, total_bytes, transfer_name) VALUES
        (10, 'att-transfer-fallback', NULL, 'image/jpeg', 5, 'present.jpg'),
        (11, 'att-basename-fallback', 'nested/dir/photo.jpg', 'image/jpeg', 5, NULL),
        (12, 'att-both-null', NULL, 'image/jpeg', 5, NULL),
        (13, 'att-fromme', 'present.jpg', 'image/jpeg', 5, 'present.jpg');
      INSERT INTO message_attachment_join (message_id, attachment_id) VALUES (1, 10), (1, 11), (2, 12), (3, 13);
    `);
  } finally {
    db.close();
  }
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

  it('skips a text-less, attachment-less message with E_EMPTY_MESSAGE', async () => {
    const dir = makeTmpDir('imessage-empty-');
    try {
      createMessagesDbEmptyMessage(dir);

      const { records, result, skips } = await run(dir, depsForRealDir());

      expect(records).toEqual([]);
      expect(result.recordCount).toBe(0);
      expect(skips).toContainEqual(
        expect.objectContaining({ ref: 'message:1', code: 'E_EMPTY_MESSAGE' }),
      );
    } finally {
      removeTmpDir(dir);
    }
  });

  it('suppresses a text-less message that carries an attachment (no E_EMPTY_MESSAGE) and classifies the attachment by extension when mime_type is null', async () => {
    const dir = makeTmpDir('imessage-nulltext-att-');
    try {
      createMessagesDbNullTextWithAttachment(dir);

      const { records, result, byRef, skips } = await run(dir, depsForRealDir());

      expect(skips).toEqual([]);
      expect(records.map((r) => r.sourceRef)).toEqual(['message:1:attachment:10']);
      expect(result.recordCount).toBe(1);
      const attachment = byRef.get('message:1:attachment:10');
      expect(attachment).toMatchObject({ mediaType: 'video', mimeType: 'video/quicktime' });
    } finally {
      removeTmpDir(dir);
    }
  });

  it('skips an attachment whose type is unrecognized by both mime_type and extension with E_ATTACHMENT_TYPE', async () => {
    const dir = makeTmpDir('imessage-unknown-type-');
    try {
      createMessagesDbWithOneAttachment(dir, { filename: 'archive.zip', mimeType: null }, 'file');

      const { records, skips } = await run(dir, depsForRealDir());

      expect(records.some((r) => r.sourceRef === 'message:1:attachment:10')).toBe(false);
      expect(skips).toContainEqual(
        expect.objectContaining({ ref: 'message:1:attachment:10', code: 'E_ATTACHMENT_TYPE' }),
      );
    } finally {
      removeTmpDir(dir);
    }
  });

  it('skips an attachment whose resolved path is a directory with E_ATTACHMENT_FILE', async () => {
    const dir = makeTmpDir('imessage-att-isdir-');
    try {
      createMessagesDbWithOneAttachment(dir, { filename: 'notafile.jpg', mimeType: 'image/jpeg' }, 'dir');

      const { records, skips } = await run(dir, depsForRealDir());

      expect(records.some((r) => r.sourceRef === 'message:1:attachment:10')).toBe(false);
      expect(skips).toContainEqual(
        expect.objectContaining({ ref: 'message:1:attachment:10', code: 'E_ATTACHMENT_FILE' }),
      );
    } finally {
      removeTmpDir(dir);
    }
  });

  it('skips an attachment whose file is missing on disk with E_ATTACHMENT_MISSING', async () => {
    const dir = makeTmpDir('imessage-att-missing-');
    try {
      createMessagesDbWithOneAttachment(dir, { filename: 'ghost.jpg', mimeType: 'image/jpeg' }, 'missing');

      const { records, skips } = await run(dir, depsForRealDir());

      expect(records.some((r) => r.sourceRef === 'message:1:attachment:10')).toBe(false);
      expect(skips).toContainEqual(
        expect.objectContaining({ ref: 'message:1:attachment:10', code: 'E_ATTACHMENT_MISSING' }),
      );
    } finally {
      removeTmpDir(dir);
    }
  });

  it('canHandle rejects when Attachments exists but is a file, not a directory', async () => {
    const dir = makeTmpDir('imessage-attfile-');
    try {
      writeFileSync(join(dir, 'chat.db'), Buffer.from('SQLite format 3\0rest of file'));
      writeFileSync(join(dir, 'Attachments'), 'not a directory');

      expect(await imessageImporter.canHandle(dir, depsForRealDir())).toBe(false);
    } finally {
      removeTmpDir(dir);
    }
  });

  it('canHandle returns false when the input path cannot be statted', async () => {
    const parent = makeTmpDir('imessage-missing-');
    const missing = join(parent, 'does-not-exist');
    try {
      expect(await imessageImporter.canHandle(missing, depsForRealDir())).toBe(false);
    } finally {
      removeTmpDir(parent);
    }
  });

  it('reports E_OPEN_DB when chat.db cannot be opened as a database (e.g. a directory)', async () => {
    const dir = makeTmpDir('imessage-badopen-');
    try {
      mkdirSync(join(dir, 'Attachments'), { recursive: true });
      mkdirSync(join(dir, 'chat.db'), { recursive: true });

      const { records, result, skips } = await run(dir, depsForRealDir());

      expect(records).toEqual([]);
      expect(result.recordCount).toBe(0);
      expect(skips).toContainEqual(expect.objectContaining({ ref: 'chat.db', code: 'E_OPEN_DB' }));
    } finally {
      removeTmpDir(dir);
    }
  });

  it('reports E_READ_DB when chat.db lacks the expected message schema', async () => {
    const dir = makeTmpDir('imessage-badschema-');
    try {
      mkdirSync(join(dir, 'Attachments'), { recursive: true });
      const db = new Database(join(dir, 'chat.db'));
      db.close();

      const { records, result, skips } = await run(dir, depsForRealDir());

      expect(records).toEqual([]);
      expect(result.recordCount).toBe(0);
      expect(skips).toContainEqual(expect.objectContaining({ ref: 'chat.db', code: 'E_READ_DB' }));
    } finally {
      removeTmpDir(dir);
    }
  });

  it('reports E_PARSE_MESSAGE and keeps draining subsequent rows when per-row processing throws unexpectedly', async () => {
    const dir = makeTmpDir('imessage-rowthrow-');
    try {
      createMessagesDb(dir, [
        { text: 'first', date: appleNs('2024-02-03T04:05:06.000Z') },
        { text: 'second', date: appleNs('2024-02-03T04:06:07.000Z') },
      ]);
      const deps = depsForRealDir();
      const skips: SkippedItem[] = [];
      let emits = 0;
      const ctx: ImportContext = {
        sourceId: 'src-imessage',
        workDir: WORK,
        signal: new AbortController().signal,
        deps,
        onSkip: (item) => skips.push(item),
        onProgress: (update) => {
          if (update.phase === 'emit') {
            emits += 1;
            if (emits === 1) throw new Error('sink unavailable');
          }
        },
      };
      const records: CatalogRecord[] = [];
      await drainImporter(imessageImporter, dir, ctx, (r) => records.push(r));

      expect(records.map((r) => r.sourceRef)).not.toContain('message:1');
      expect(records.map((r) => r.sourceRef)).toContain('message:2');
      expect(skips).toContainEqual(
        expect.objectContaining({ ref: 'message:1', code: 'E_PARSE_MESSAGE' }),
      );
    } finally {
      removeTmpDir(dir);
    }
  });

  it('stops immediately after the current message once aborted, without processing its attachment', async () => {
    const dir = makeTmpDir('imessage-abort-preattachment-');
    try {
      createMessagesDb(dir, [
        { text: 'first', date: appleNs('2024-02-03T04:05:06.000Z') },
        { text: 'second', date: appleNs('2024-02-03T04:06:07.000Z') },
      ]);
      const deps = depsForRealDir();
      const controller = new AbortController();
      const ctx: ImportContext = {
        sourceId: 'src-imessage',
        workDir: WORK,
        signal: controller.signal,
        deps,
        onSkip: () => {},
        onProgress: (update) => {
          if (update.phase === 'emit' && update.processed === 1) controller.abort();
        },
      };
      const records: CatalogRecord[] = [];
      const result = await drainImporter(imessageImporter, dir, ctx, (r) => records.push(r));

      expect(records.map((r) => r.sourceRef)).toEqual(['message:1']);
      expect(result.recordCount).toBe(1);
    } finally {
      removeTmpDir(dir);
    }
  });

  it('stops before starting the next row once the signal is aborted after a full row completes', async () => {
    const dir = makeTmpDir('imessage-abort-nextrow-');
    try {
      createMessagesDbWithAttachments(dir);
      const deps = depsForRealDir();
      const controller = new AbortController();
      const ctx: ImportContext = {
        sourceId: 'src-imessage',
        workDir: WORK,
        signal: controller.signal,
        deps,
        onSkip: () => {},
        onProgress: (update) => {
          if (update.phase === 'emit' && update.processed === 2) controller.abort();
        },
      };
      const records: CatalogRecord[] = [];
      const result = await drainImporter(imessageImporter, dir, ctx, (r) => records.push(r));

      expect(records.map((r) => r.sourceRef)).toEqual(['message:1', 'message:1:attachment:10']);
      expect(result.recordCount).toBe(2);
    } finally {
      removeTmpDir(dir);
    }
  });

  it('normalizes an orphan message (no guid, chat link, or handle) to null-safe metadata', async () => {
    const dir = makeTmpDir('imessage-orphan-');
    try {
      createOrphanMessageDb(dir);

      const { byRef, skips } = await run(dir, depsForRealDir());

      expect(skips).toEqual([]);
      const record = byRef.get('message:1');
      expect(record).toMatchObject({
        author: null,
        sourceMeta: {
          messageGuid: null,
          chatGuid: null,
          chatName: null,
          chatGuids: [],
          chatNames: [],
          service: null,
          handleId: null,
        },
      });
    } finally {
      removeTmpDir(dir);
    }
  });

  it('converts legacy Apple-epoch magnitudes (microseconds, seconds), a null date, an out-of-range timestamp, and a corrupted non-numeric timestamp', async () => {
    const dir = makeTmpDir('imessage-datescale-');
    try {
      createDateScaleMessagesDb(dir);

      const { byRef, skips } = await run(dir, depsForRealDir());

      expect(skips).toEqual([]);
      expect(byRef.get('message:1')?.date?.value.getTime()).toBe(APPLE_EPOCH_MS + 700_000_000_000 / 1000);
      expect(byRef.get('message:2')?.date?.value.getTime()).toBe(APPLE_EPOCH_MS + 700_000_000 * 1000);
      expect(byRef.get('message:3')?.date).toBeNull();
      // A timestamp so large it produces an out-of-range (invalid) Date must
      // degrade to a null date rather than surface a corrupt/NaN value.
      expect(byRef.get('message:4')?.date).toBeNull();
      // A non-numeric value in the `date` column (a corrupted/adversarial
      // export) must degrade to a null date rather than throw.
      expect(byRef.get('message:5')?.date).toBeNull();
    } finally {
      removeTmpDir(dir);
    }
  });

  it('resolves an attachment path from transfer_name when filename is null, falls back to a basename-derived fileName when transfer_name is null, skips when both are null, and attributes an outgoing attachment to Me', async () => {
    const dir = makeTmpDir('imessage-attpath-edge-');
    try {
      createAttachmentPathEdgeCasesDb(dir);

      const { records, byRef, skips } = await run(dir, depsForRealDir());

      const transferFallback = byRef.get('message:1:attachment:10');
      expect(transferFallback).toMatchObject({
        sourceMeta: { attachmentFileName: 'present.jpg', attachmentRelativePath: 'present.jpg' },
      });

      const basenameFallback = byRef.get('message:1:attachment:11');
      expect(basenameFallback).toMatchObject({
        sourceMeta: { attachmentFileName: 'photo.jpg', attachmentRelativePath: 'nested/dir/photo.jpg' },
      });

      expect(records.some((r) => r.sourceRef === 'message:2:attachment:12')).toBe(false);
      expect(skips).toContainEqual(
        expect.objectContaining({ ref: 'message:2:attachment:12', code: 'E_ATTACHMENT_PATH' }),
      );

      expect(byRef.get('message:3:attachment:13')).toMatchObject({ author: 'Me' });
    } finally {
      removeTmpDir(dir);
    }
  });

  it('canHandle rejects a plain file path (not a directory)', async () => {
    const parent = makeTmpDir('imessage-filepath-');
    const file = join(parent, 'not-a-dir.txt');
    try {
      writeFileSync(file, 'just a file');
      expect(await imessageImporter.canHandle(file, depsForRealDir())).toBe(false);
    } finally {
      removeTmpDir(parent);
    }
  });

  it('canHandle rejects a directory with no chat.db at all', async () => {
    const dir = makeTmpDir('imessage-nodb-');
    try {
      expect(await imessageImporter.canHandle(dir, depsForRealDir())).toBe(false);
    } finally {
      removeTmpDir(dir);
    }
  });
});
