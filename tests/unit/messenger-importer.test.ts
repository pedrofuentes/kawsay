import { createReadStream, mkdirSync, writeFileSync } from 'node:fs';
import { access, readdir, stat } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { messengerImporter } from '../../electron/main/importers/messenger-importer';
import { drainImporter } from '../../electron/main/importers/drain';
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

const WORK = '/work/messenger';
const MESSAGES_ROOT = join('your_activity_across_facebook', 'messages');

function ps(path: string | null | undefined): string {
  return (path ?? '').split(sep).join('/');
}

function depsForRealDir(): ImporterDeps {
  const fs: FsLike = {
    readFile: async (path: string) =>
      await import('node:fs/promises').then((m) => m.readFile(path)),
    readDir: readdir,
    stat,
    exists: async (path: string) =>
      access(path).then(
        () => true,
        () => false,
      ),
    openReadStream: (path: string) => createReadStream(path, { encoding: 'utf8' }),
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
      sourceId: 'src-messenger',
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
  const result = await drainImporter(messengerImporter, inputPath, c.ctx, (r) => records.push(r));
  return { ...c, records, result, byRef: new Map(records.map((r) => [r.sourceRef, r])) };
}

function writeMessageFile(
  root: string,
  bucket: string,
  thread: string,
  name: string,
  data: unknown,
): string {
  const dir = join(root, MESSAGES_ROOT, bucket, thread);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(data, null, 2));
  return path;
}

describe('messengerImporter (M3 — Facebook Messenger export connector)', () => {
  it('identifies itself as the messenger source', () => {
    expect(messengerImporter.id).toBe('messenger');
    expect(messengerImporter.displayName).toBe('Facebook Messenger');
  });

  it('canHandle cheaply accepts Messenger thread JSON and rejects non-Messenger dirs and read errors', async () => {
    const messengerDir = makeTmpDir('messenger-can-');
    const plainDir = makeTmpDir('messenger-plain-');
    try {
      writeMessageFile(messengerDir, 'inbox', 'family_abcd', 'message_1.json', {
        participants: [{ name: 'Mamá' }],
        messages: [{ sender_name: 'Mamá', timestamp_ms: 1_702_000_000_000, content: 'hola' }],
      });
      writeMessageFile(plainDir, 'inbox', 'not_thread', 'message_1.json', { messages: 'nope' });

      expect(await messengerImporter.canHandle(messengerDir, depsForRealDir())).toBe(true);
      expect(await messengerImporter.canHandle(plainDir, depsForRealDir())).toBe(false);
      expect(await messengerImporter.canHandle(join(plainDir, 'missing'), depsForRealDir())).toBe(
        false,
      );

      const deps = depsForRealDir();
      deps.fs.readDir = async () => {
        throw new Error('EACCES: denied');
      };
      expect(await messengerImporter.canHandle(messengerDir, deps)).toBe(false);
    } finally {
      removeTmpDir(messengerDir);
      removeTmpDir(plainDir);
    }
  });

  it('streams inbox/archived/filtered message files with mojibake decoding, dates, bounds, and provenance', async () => {
    const dir = makeTmpDir('messenger-import-');
    try {
      writeMessageFile(dir, 'inbox', 'family_abcd', 'message_1.json', {
        participants: [{ name: 'MamÃ¡' }, { name: 'Me' }],
        title: 'Familia',
        messages: [
          {
            sender_name: 'MamÃ¡',
            timestamp_ms: 1_706_933_106_000,
            content: 'Â¡Hola! ð',
          },
          {
            sender_name: 'Me',
            timestamp_ms: 1_706_933_167_000,
            content: 'x'.repeat(25_000),
          },
        ],
      });
      writeMessageFile(dir, 'archived_threads', 'old_efgh', 'message_1.json', {
        participants: [{ name: 'Ana' }],
        messages: [{ sender_name: 'Ana', timestamp_ms: 1_706_933_200_000, content: 'archived' }],
      });
      writeMessageFile(dir, 'filtered_threads', 'spam_ijkl', 'message_1.json', {
        participants: [{ name: 'Bot' }],
        messages: [{ sender_name: 'Bot', timestamp_ms: 1_706_933_300_000, content: 'filtered' }],
      });
      const deps = depsForRealDir();
      const readFiles: string[] = [];
      const realReadFile = deps.fs.readFile;
      deps.fs.readFile = async (path: string) => {
        readFiles.push(path);
        return await realReadFile(path);
      };

      const { records, result, byRef, skips } = await run(dir, deps);

      expect(result.recordCount).toBe(4);
      expect(skips).toEqual([]);
      expect(readFiles).toEqual([]);
      expect(records.every((r) => r.sourceType === 'messenger')).toBe(true);
      expect(records.every((r) => r.mediaType === 'message')).toBe(true);
      expect(records.map((r) => r.sourceRef)).toEqual([
        'inbox/family_abcd/message_1.json#0:text',
        'inbox/family_abcd/message_1.json#1:text',
        'archived_threads/old_efgh/message_1.json#0:text',
        'filtered_threads/spam_ijkl/message_1.json#0:text',
      ]);
      expect(byRef.get('inbox/family_abcd/message_1.json#0:text')).toMatchObject({
        author: 'Mamá',
        body: '¡Hola! 😀',
        originalPath: null,
        sourceMeta: {
          thread: 'inbox/family_abcd',
          threadBucket: 'inbox',
          threadTitle: 'Familia',
          participants: ['Mamá', 'Me'],
        },
      });
      expect(byRef.get('inbox/family_abcd/message_1.json#0:text')?.date?.value.toISOString()).toBe(
        '2024-02-03T04:05:06.000Z',
      );
      expect(byRef.get('inbox/family_abcd/message_1.json#1:text')?.body).toHaveLength(20_000);
    } finally {
      removeTmpDir(dir);
    }
  });

  it('links photo/video/audio files and skips traversal refs without statting outside the export root', async () => {
    const dir = makeTmpDir('messenger-media-');
    try {
      const threadDir = join(dir, MESSAGES_ROOT, 'inbox', 'media_abcd');
      mkdirSync(join(threadDir, 'photos'), { recursive: true });
      mkdirSync(join(threadDir, 'videos'), { recursive: true });
      mkdirSync(join(threadDir, 'audio'), { recursive: true });
      writeFileSync(join(threadDir, 'photos', 'pic.jpg'), 'photo-bytes');
      writeFileSync(join(threadDir, 'videos', 'clip.mp4'), 'video-bytes');
      writeFileSync(join(threadDir, 'audio', 'voice.m4a'), 'audio-bytes');
      writeMessageFile(dir, 'inbox', 'media_abcd', 'message_1.json', {
        participants: [{ name: 'Me' }],
        messages: [
          {
            sender_name: 'Me',
            timestamp_ms: 1_706_933_106_000,
            content: 'look',
            photos: [
              { uri: 'your_activity_across_facebook/messages/inbox/media_abcd/photos/pic.jpg' },
            ],
            videos: [{ uri: 'messages/inbox/media_abcd/videos/clip.mp4' }],
            audio: [{ uri: 'messages/inbox/media_abcd/audio/voice.m4a' }],
          },
          {
            sender_name: 'Me',
            timestamp_ms: 1_706_933_200_000,
            content: 'bad',
            photos: [{ uri: '../escape.jpg' }],
          },
        ],
      });
      const deps = depsForRealDir();
      const statPaths: string[] = [];
      const realStat = deps.fs.stat;
      deps.fs.stat = async (path: string): Promise<FileStat> => {
        statPaths.push(path);
        return await realStat(path);
      };

      const { records, byRef, result, skips } = await run(dir, deps);

      expect(result.recordCount).toBe(5);
      expect(records.map((r) => r.sourceRef)).toEqual([
        'inbox/media_abcd/message_1.json#0:photos:0',
        'inbox/media_abcd/message_1.json#0:videos:0',
        'inbox/media_abcd/message_1.json#0:audio:0',
        'inbox/media_abcd/message_1.json#0:text',
        'inbox/media_abcd/message_1.json#1:text',
      ]);
      expect(byRef.get('inbox/media_abcd/message_1.json#0:photos:0')).toMatchObject({
        mediaType: 'photo',
        mimeType: 'image/jpeg',
        author: 'Me',
        body: null,
        sourceMeta: {
          parentMessageRef: 'inbox/media_abcd/message_1.json#0:text',
          mediaPath: 'messages/inbox/media_abcd/photos/pic.jpg',
        },
      });
      expect(byRef.get('inbox/media_abcd/message_1.json#0:videos:0')?.mediaType).toBe('video');
      expect(byRef.get('inbox/media_abcd/message_1.json#0:audio:0')?.mediaType).toBe('audio');
      expect(ps(byRef.get('inbox/media_abcd/message_1.json#0:photos:0')?.originalPath)).toContain(
        '/messages/inbox/media_abcd/photos/pic.jpg',
      );
      expect(skips).toContainEqual(
        expect.objectContaining({
          ref: 'inbox/media_abcd/message_1.json#1:photos:0',
          code: 'E_MEDIA_PATH',
        }),
      );
      const safeRoot = ps(dir);
      for (const statted of statPaths.map(ps)) {
        expect(statted.startsWith(safeRoot)).toBe(true);
        expect(statted).not.toContain('/escape.jpg');
      }
    } finally {
      removeTmpDir(dir);
    }
  });

  it('caps one oversized message object and keeps later messages without unbounded buffering', async () => {
    const dir = makeTmpDir('messenger-bounds-');
    try {
      const path = writeMessageFile(dir, 'inbox', 'huge_abcd', 'message_1.json', {
        participants: [{ name: 'Mamá' }],
        messages: [
          { sender_name: 'Mamá', timestamp_ms: 1, content: 'A'.repeat(2_500_000) },
          { sender_name: 'Mamá', timestamp_ms: 2, content: 'after huge' },
        ],
      });

      const { records, skips } = await run(dir, depsForRealDir());

      expect(records.map((r) => r.body)).toEqual(['after huge']);
      expect(skips).toContainEqual(
        expect.objectContaining({
          ref: ps(path).split('/your_activity_across_facebook/messages/')[1],
          code: 'E_MESSAGE_TOO_LARGE',
        }),
      );
    } finally {
      removeTmpDir(dir);
    }
  });

  it('honors an already-aborted signal without opening message files', async () => {
    const dir = makeTmpDir('messenger-abort-');
    const controller = new AbortController();
    try {
      writeMessageFile(dir, 'inbox', 'family_abcd', 'message_1.json', {
        participants: [{ name: 'Mamá' }],
        messages: [{ sender_name: 'Mamá', timestamp_ms: 1, content: 'hola' }],
      });
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
