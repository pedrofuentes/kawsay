import { createReadStream, mkdirSync, writeFileSync } from 'node:fs';
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
      expect(await telegramImporter.canHandle(join(plainDir, 'result.json'), depsForRealDir())).toBe(
        false,
      );
      expect(await telegramImporter.canHandle(join(plainDir, 'missing'), depsForRealDir())).toBe(false);
    } finally {
      removeTmpDir(jsonDir);
      removeTmpDir(htmlDir);
      removeTmpDir(plainDir);
      removeTmpDir(genericJsonDir);
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
      expect(normalizePath(byRef.get('message:10:media:photos/photo_1.jpg')?.originalPath ?? '')).toContain(
        '/photos/photo_1.jpg',
      );
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
