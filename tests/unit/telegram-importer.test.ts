import { createReadStream, mkdirSync, writeFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { drainImporter } from '../../electron/main/importers/drain';
import { telegramImporter } from '../../electron/main/importers/telegram-importer';
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

const WORK = '/work/telegram';

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
    openReadStream: (path: string) => createReadStream(path),
  };
  return {
    fs,
    extractArchive: async () => [],
    readExif: async () => null,
    probeMedia: async () => ({ durationSec: null, width: null, height: null, mimeType: null }),
    hashFile: async () => 'deadbeef',
  };
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
      sourceId: 'src-telegram',
      workDir: WORK,
      signal: signal ?? new AbortController().signal,
      deps,
      onSkip: (item) => skips.push(item),
      onProgress: (update) => progress.push(update),
    },
  };
}

async function run(inputPath: string, deps: ImporterDeps, signal?: AbortSignal) {
  const c = makeContext(deps, signal);
  const records: CatalogRecord[] = [];
  const result = await drainImporter(telegramImporter, inputPath, c.ctx, (r) => records.push(r));
  return { ...c, records, result, byRef: new Map(records.map((r) => [r.sourceRef, r])) };
}

function writeResult(root: string, data: unknown): void {
  writeFileSync(join(root, 'result.json'), JSON.stringify(data, null, 2));
}

function normalizePath(path: string): string {
  return path.split(/[\\/]/).join('/');
}

describe('telegramImporter (M3 — Telegram Desktop export connector)', () => {
  it('identifies itself as the telegram source', () => {
    expect(telegramImporter.id).toBe('telegram');
    expect(telegramImporter.displayName).toBe('Telegram');
  });

  it('canHandle accepts Telegram result.json or messages.html markers and rejects other folders', async () => {
    const jsonDir = makeTmpDir('telegram-json-');
    const htmlDir = makeTmpDir('telegram-html-');
    const plainDir = makeTmpDir('telegram-plain-');
    const genericJsonDir = makeTmpDir('telegram-generic-json-');
    try {
      writeResult(jsonDir, { name: 'Mamá', type: 'personal_chat', id: 42, messages: [] });
      writeFileSync(join(htmlDir, 'messages.html'), '<html><title>Telegram Desktop</title></html>');
      writeFileSync(join(plainDir, 'result.json'), '{"not":"telegram"}');
      writeResult(genericJsonDir, { messages: [] });

      expect(await telegramImporter.canHandle(jsonDir, depsForRealDir())).toBe(true);
      expect(await telegramImporter.canHandle(htmlDir, depsForRealDir())).toBe(true);
      expect(await telegramImporter.canHandle(plainDir, depsForRealDir())).toBe(false);
      expect(await telegramImporter.canHandle(genericJsonDir, depsForRealDir())).toBe(false);
      expect(
        await telegramImporter.canHandle(join(plainDir, 'result.json'), depsForRealDir()),
      ).toBe(false);
      expect(await telegramImporter.canHandle(join(plainDir, 'missing'), depsForRealDir())).toBe(
        false,
      );
    } finally {
      removeTmpDir(jsonDir);
      removeTmpDir(htmlDir);
      removeTmpDir(plainDir);
      removeTmpDir(genericJsonDir);
    }
  });

  it('returns false when the messages.html marker cannot be read', async () => {
    const dir = makeTmpDir('telegram-html-read-error-');
    try {
      writeFileSync(join(dir, 'messages.html'), '<html><title>Telegram Desktop</title></html>');
      const deps = depsForRealDir();
      deps.fs.openReadStream = () => {
        throw new Error('EACCES: denied');
      };

      expect(await telegramImporter.canHandle(dir, deps)).toBe(false);
    } finally {
      removeTmpDir(dir);
    }
  });

  // De-flake (#454): the old fixture was a 2.5 MB message (~650 ms isolated) whose
  // char-by-char streamed parse ballooned to 5–13 s under parallel CI CPU load,
  // tripping the 5 s default. The cap is `MAX_MESSAGE_JSON_CHARS` (1_000_000), so a
  // message just OVER that threshold proves the exact same cap behaviour with the
  // MINIMAL input the parser must scan — no dependence on a wall-clock timeout for a
  // multi-MB parse. `MAX_MESSAGE_JSON_CHARS + 1` chars guarantees the object exceeds
  // the cap once the `{…"text":"` wrapper is added. Keep a generous timeout purely as
  // margin; the fast fixture is what removes the flake.
  it('caps one oversized message object and keeps later Telegram messages', { timeout: 20_000 }, async () => {
    const dir = makeTmpDir('telegram-bounds-');
    try {
      writeResult(dir, {
        name: 'Mamá',
        type: 'personal_chat',
        id: 42,
        messages: [
          {
            id: 1,
            type: 'message',
            date_unixtime: 1,
            from: 'Mamá',
            text: 'A'.repeat(1_000_001),
          },
          { id: 2, type: 'message', date_unixtime: 2, from: 'Mamá', text: 'after huge' },
        ],
      });

      const { records, skips, result } = await run(dir, depsForRealDir());

      expect(records.map((r) => r.body)).toEqual(['after huge']);
      expect(skips).toContainEqual(
        expect.objectContaining({ ref: 'message:0', code: 'E_MESSAGE_TOO_LARGE' }),
      );
      // Stat-path: the returned ImportResult mirrors the skip callback and record counter.
      expect(result.recordCount).toBe(1);
      expect(result.skipped).toContainEqual(
        expect.objectContaining({ ref: 'message:0', code: 'E_MESSAGE_TOO_LARGE' }),
      );
    } finally {
      removeTmpDir(dir);
    }
  });

  it('caps one deeply nested message object and keeps later Telegram messages', async () => {
    const dir = makeTmpDir('telegram-depth-bounds-');
    try {
      // Nest well past MAX_JSON_NESTING_DEPTH (100) so the streaming parser trips the
      // depth cap. JSON.parse handles this nesting fine, so without the cap the message
      // would be emitted — this test fails if the cap is removed or raised unboundedly.
      let deeplyNested: unknown = 'bottom';
      for (let i = 0; i < 130; i++) deeplyNested = { nested: deeplyNested };
      writeResult(dir, {
        name: 'Mamá',
        type: 'personal_chat',
        id: 42,
        messages: [
          {
            id: 1,
            type: 'message',
            date_unixtime: 1,
            from: 'Mamá',
            text: 'deep one',
            nested: deeplyNested,
          },
          { id: 2, type: 'message', date_unixtime: 2, from: 'Mamá', text: 'after deep' },
        ],
      });

      const { records, skips, result } = await run(dir, depsForRealDir());

      expect(records.map((r) => r.body)).toEqual(['after deep']);
      expect(skips).toContainEqual(
        expect.objectContaining({ ref: 'message:0', code: 'E_MESSAGE_TOO_DEEP' }),
      );
      // Stat-path: the returned ImportResult mirrors the skip callback and record counter.
      expect(result.recordCount).toBe(1);
      expect(result.skipped).toContainEqual(
        expect.objectContaining({ ref: 'message:0', code: 'E_MESSAGE_TOO_DEEP' }),
      );
    } finally {
      removeTmpDir(dir);
    }
  });

  it('caps deeply nested and wide rich text without overflowing recursion or memory', async () => {
    const dir = makeTmpDir('telegram-text-bounds-');
    try {
      let nested: unknown = 'too deep';
      for (let i = 0; i < 80; i++) nested = { text: nested };
      writeResult(dir, {
        name: 'Mamá',
        type: 'personal_chat',
        id: 42,
        messages: [
          { id: 1, type: 'message', date_unixtime: 1, from: 'Mamá', text: nested },
          {
            id: 2,
            type: 'message',
            date_unixtime: 2,
            from: 'Mamá',
            text: Array.from({ length: 50_000 }, () => 'x'),
          },
        ],
      });

      const { byRef } = await run(dir, depsForRealDir());

      expect(byRef.get('message:1')?.body).toBeNull();
      expect(byRef.get('message:2')?.body).toHaveLength(20_000);
    } finally {
      removeTmpDir(dir);
    }
  });

  it('rejects absolute drive UNC and traversal media paths before normalization', async () => {
    const dir = makeTmpDir('telegram-unsafe-media-');
    try {
      mkdirSync(join(dir, 'photos'), { recursive: true });
      writeFileSync(join(dir, 'photos', 'photo_1.jpg'), 'photo-bytes');
      writeResult(dir, {
        name: 'Family',
        type: 'private_group',
        id: 7,
        messages: [
          { id: 1, type: 'message', text: 'abs', photo: '/photos/photo_1.jpg' },
          { id: 2, type: 'message', text: 'unix', photo: '/etc/passwd' },
          { id: 3, type: 'message', text: 'drive', photo: 'C:\\Users\\me\\pic.jpg' },
          { id: 4, type: 'message', text: 'unc', photo: '\\\\srv\\share\\pic.jpg' },
          { id: 5, type: 'message', text: 'trav', photo: '../../pic.jpg' },
        ],
      });
      const deps = depsForRealDir();
      const statPaths: string[] = [];
      const realStat = deps.fs.stat;
      deps.fs.stat = async (path: string): Promise<FileStat> => {
        statPaths.push(path);
        return await realStat(path);
      };

      const { records, skips } = await run(dir, deps);

      expect(records.map((r) => r.mediaType)).toEqual([
        'message',
        'message',
        'message',
        'message',
        'message',
      ]);
      expect(skips.filter((skip) => skip.code === 'E_MEDIA_PATH')).toHaveLength(5);
      expect(statPaths.map(normalizePath)).not.toContain(expect.stringContaining('photo_1.jpg'));
    } finally {
      removeTmpDir(dir);
    }
  });

  it('stops cleanly when aborted mid-stream', async () => {
    const dir = makeTmpDir('telegram-mid-abort-');
    const controller = new AbortController();
    try {
      writeResult(dir, {
        name: 'Mamá',
        type: 'personal_chat',
        id: 42,
        messages: [
          { id: 1, type: 'message', date_unixtime: 1, from: 'Mamá', text: 'first' },
          { id: 2, type: 'message', date_unixtime: 2, from: 'Mamá', text: 'second' },
        ],
      });
      const deps = depsForRealDir();
      const realOpen = deps.fs.openReadStream;
      deps.fs.openReadStream = (path: string) => {
        const source = realOpen?.(path) ?? Readable.from([]);
        let chunked = false;
        return source.on('data', () => {
          if (!chunked) {
            chunked = true;
            controller.abort();
          }
        });
      };

      const { records, result } = await run(dir, deps, controller.signal);

      expect(records.length).toBeLessThan(2);
      expect(result.recordCount).toBe(records.length);
    } finally {
      removeTmpDir(dir);
    }
  });

  it('streams result.json messages with sender, ISO/unix timestamps, bounded rich text, and provenance', async () => {
    const dir = makeTmpDir('telegram-import-');
    try {
      writeResult(dir, {
        chats: [
          {
            name: 'Mamá',
            type: 'personal_chat',
            id: 42,
            messages: [
              {
                id: 1,
                type: 'message',
                date: '2024-02-03T04:05:06Z',
                from: 'Mamá',
                text: ['hola ', { type: 'bold', text: 'familia' }, { type: 'link', text: '!' }],
              },
              {
                id: 2,
                type: 'message',
                date_unixtime: '1706933167',
                from: 'Me',
                text: 'x'.repeat(25_000),
              },
            ],
          },
        ],
      });
      const realDeps = depsForRealDir();
      const readFiles: string[] = [];
      const deps: ImporterDeps = {
        ...realDeps,
        fs: {
          ...realDeps.fs,
          async readFile(path: string): Promise<Buffer> {
            readFiles.push(path);
            return await realDeps.fs.readFile(path);
          },
        },
      };

      const { records, result, byRef, skips } = await run(dir, deps);

      expect(result.recordCount).toBe(2);
      expect(skips).toEqual([]);
      expect(readFiles).not.toContain(join(dir, 'result.json'));
      expect(records.every((r) => r.sourceType === 'telegram')).toBe(true);
      expect(records.every((r) => r.mediaType === 'message')).toBe(true);
      expect(records.map((r) => r.sourceRef)).toEqual(['message:1', 'message:2']);
      expect(byRef.get('message:1')).toMatchObject({
        author: 'Mamá',
        body: 'hola familia!',
        originalPath: null,
        sourceMeta: { chatId: 42, chatName: 'Mamá', messageId: 1, rawType: 'message' },
      });
      expect(byRef.get('message:1')?.date?.source).toBe('message');
      expect(byRef.get('message:1')?.date?.value.toISOString()).toBe('2024-02-03T04:05:06.000Z');
      expect(byRef.get('message:2')?.date?.value.toISOString()).toBe(
        new Date(1_706_933_167_000).toISOString(),
      );
      expect(byRef.get('message:2')?.body).toHaveLength(20_000);
    } finally {
      removeTmpDir(dir);
    }
  });

  it('uses JSON structure rather than quoted text when associating messages with chat metadata', async () => {
    const dir = makeTmpDir('telegram-json-structure-');
    try {
      writeResult(dir, {
        chats: [
          {
            name: 'Family',
            type: 'private_group',
            id: 42,
            pinned_message: {
              id: 999,
              type: 'message',
              name: 'Nested Trap',
              text: 'Ignore nested JSON-looking metadata with : and { braces',
            },
            messages: [
              {
                id: 1,
                type: 'message',
                date: '2024-02-03T04:05:06Z',
                from: 'Mamá',
                text: 'literal punctuation should stay text: "name": "Trap" and : {',
              },
            ],
          },
        ],
      });

      const { result, byRef, skips } = await run(dir, depsForRealDir());

      expect(result.recordCount).toBe(1);
      expect(skips).toEqual([]);
      expect(byRef.get('message:1')).toMatchObject({
        body: 'literal punctuation should stay text: "name": "Trap" and : {',
        sourceMeta: { chatId: 42, chatName: 'Family', chatType: 'private_group' },
      });
    } finally {
      removeTmpDir(dir);
    }
  });

  it('links photo/video/voice files and skips traversal refs without statting outside the export root', async () => {
    const dir = makeTmpDir('telegram-media-');
    try {
      mkdirSync(join(dir, 'photos'), { recursive: true });
      mkdirSync(join(dir, 'video_files'), { recursive: true });
      mkdirSync(join(dir, 'voice_messages'), { recursive: true });
      writeFileSync(join(dir, 'photos', 'photo_1.jpg'), 'photo-bytes');
      writeFileSync(join(dir, 'video_files', 'clip.mp4'), 'video-bytes');
      writeFileSync(join(dir, 'voice_messages', 'voice.ogg'), 'voice-bytes');
      writeResult(dir, {
        name: 'Family',
        type: 'private_group',
        id: 7,
        messages: [
          {
            id: 10,
            type: 'message',
            date: '2024-02-03T04:05:06Z',
            from: 'Mamá',
            text: 'look',
            photo: 'photos/photo_1.jpg',
          },
          {
            id: 11,
            type: 'message',
            date: '2024-02-03T04:06:06Z',
            from: 'Mamá',
            text: '',
            media_type: 'video_file',
            file: 'video_files/clip.mp4',
          },
          {
            id: 12,
            type: 'message',
            date: '2024-02-03T04:07:06Z',
            from: 'Mamá',
            text: '',
            media_type: 'voice_message',
            file: 'voice_messages/voice.ogg',
          },
          {
            id: 13,
            type: 'message',
            date: '2024-02-03T04:08:06Z',
            from: 'Mamá',
            text: 'bad',
            photo: '../escape.jpg',
          },
        ],
      });
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

      const { records, result, byRef, skips } = await run(dir, deps);

      expect(result.recordCount).toBe(7);
      expect(records.map((r) => r.sourceRef)).toEqual([
        'message:10',
        'message:10:media:photos/photo_1.jpg',
        'message:11',
        'message:11:media:video_files/clip.mp4',
        'message:12',
        'message:12:media:voice_messages/voice.ogg',
        'message:13',
      ]);
      expect(byRef.get('message:10:media:photos/photo_1.jpg')).toMatchObject({
        mediaType: 'photo',
        mimeType: 'image/jpeg',
        author: 'Mamá',
        body: 'look',
        sourceMeta: { parentMessageRef: 'message:10', mediaPath: 'photos/photo_1.jpg' },
      });
      expect(byRef.get('message:11:media:video_files/clip.mp4')).toMatchObject({
        mediaType: 'video',
        mimeType: 'video/mp4',
      });
      expect(byRef.get('message:12:media:voice_messages/voice.ogg')).toMatchObject({
        mediaType: 'audio',
        mimeType: 'audio/ogg',
      });
      expect(
        normalizePath(byRef.get('message:10:media:photos/photo_1.jpg')?.originalPath ?? ''),
      ).toContain('/photos/photo_1.jpg');
      expect(skips).toContainEqual(
        expect.objectContaining({
          ref: 'message:13:media:../escape.jpg',
          code: 'E_MEDIA_PATH',
        }),
      );
      const safeRoot = normalizePath(dir);
      for (const statted of statPaths.map(normalizePath)) {
        expect(statted.startsWith(safeRoot)).toBe(true);
        expect(statted).not.toContain('/escape.jpg');
      }
    } finally {
      removeTmpDir(dir);
    }
  });

  it('honors an already-aborted signal without opening result.json', async () => {
    const dir = makeTmpDir('telegram-abort-');
    const controller = new AbortController();
    try {
      writeResult(dir, { name: 'Mamá', type: 'personal_chat', id: 42, messages: [] });
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
