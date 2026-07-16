import { createReadStream, mkdirSync, writeFileSync } from 'node:fs';
import { access, readdir, stat } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { instagramImporter } from '../../electron/main/importers/instagram-importer';
import { buildZip } from '../helpers/zip';
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

const WORK = '/work/instagram';
const IG_MESSAGES_ROOT = join('your_instagram_activity', 'messages');
const FB_MESSAGES_ROOT = join('your_activity_across_facebook', 'messages');

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
      sourceId: 'src-instagram',
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
  const result = await drainImporter(instagramImporter, inputPath, c.ctx, (r) => records.push(r));
  return { ...c, records, result, byRef: new Map(records.map((r) => [r.sourceRef, r])) };
}

function writeInstagramMessageFile(
  root: string,
  thread: string,
  name: string,
  data: unknown,
): string {
  const dir = join(root, IG_MESSAGES_ROOT, 'inbox', thread);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(data, null, 2));
  return path;
}

function writeMessengerMessageFile(root: string, thread: string, data: unknown): string {
  const dir = join(root, FB_MESSAGES_ROOT, 'inbox', thread);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'message_1.json');
  writeFileSync(path, JSON.stringify(data, null, 2));
  return path;
}

describe('instagramImporter (M3 — Instagram Meta DYI direct messages connector)', () => {
  it('identifies itself as the Instagram source', () => {
    expect(instagramImporter.id).toBe('instagram');
    expect(instagramImporter.displayName).toBe('Instagram');
  });

  it('canHandle cheaply accepts Instagram inbox thread JSON, rejects non-IG dirs and read errors, and does not collide with Messenger', async () => {
    const instagramDir = makeTmpDir('instagram-can-');
    const messengerDir = makeTmpDir('instagram-fb-can-');
    const plainDir = makeTmpDir('instagram-plain-');
    try {
      writeInstagramMessageFile(instagramDir, 'family_abcd', 'message_1.json', {
        participants: [{ name: 'MamÃ¡' }],
        messages: [{ sender_name: 'MamÃ¡', timestamp_ms: 1_702_000_000_000, content: 'hola' }],
      });
      writeMessengerMessageFile(messengerDir, 'family_abcd', {
        participants: [{ name: 'MamÃ¡' }],
        messages: [{ sender_name: 'MamÃ¡', timestamp_ms: 1_702_000_000_000, content: 'hola' }],
      });
      writeInstagramMessageFile(plainDir, 'not_thread', 'message_1.json', { messages: 'nope' });

      expect(await instagramImporter.canHandle(instagramDir, depsForRealDir())).toBe(true);
      expect(await instagramImporter.canHandle(plainDir, depsForRealDir())).toBe(false);
      expect(await instagramImporter.canHandle(join(plainDir, 'missing'), depsForRealDir())).toBe(
        false,
      );
      expect(await instagramImporter.canHandle(messengerDir, depsForRealDir())).toBe(false);
      expect(await messengerImporter.canHandle(instagramDir, depsForRealDir())).toBe(false);

      const deps = depsForRealDir();
      deps.fs.readDir = async () => {
        throw new Error('EACCES: denied');
      };
      expect(await instagramImporter.canHandle(instagramDir, deps)).toBe(false);
    } finally {
      removeTmpDir(instagramDir);
      removeTmpDir(messengerDir);
      removeTmpDir(plainDir);
    }
  });

  it('accepts an Instagram .zip by scanning entry names and rejects unrelated zips', async () => {
    const dir = makeTmpDir('instagram-zip-can-');
    try {
      const instagramZip = join(dir, 'instagram.zip');
      const unrelatedZip = join(dir, 'plain.zip');
      writeFileSync(
        instagramZip,
        buildZip([
          {
            name: 'your_instagram_activity/messages/inbox/family_abcd/message_1.json',
            data: Buffer.from('{}'),
          },
        ]),
      );
      writeFileSync(unrelatedZip, buildZip([{ name: 'photos/pic.jpg', data: Buffer.from('x') }]));

      expect(await instagramImporter.canHandle(instagramZip, depsForRealDir())).toBe(true);
      expect(await instagramImporter.canHandle(unrelatedZip, depsForRealDir())).toBe(false);
    } finally {
      removeTmpDir(dir);
    }
  });

  it('rejects absolute drive UNC and traversal media URIs before normalization', async () => {
    const dir = makeTmpDir('instagram-unsafe-media-');
    try {
      const threadDir = join(dir, IG_MESSAGES_ROOT, 'inbox', 'unsafe_abcd');
      mkdirSync(join(threadDir, 'photos'), { recursive: true });
      writeFileSync(join(threadDir, 'photos', 'pic.jpg'), 'photo-bytes');
      writeInstagramMessageFile(dir, 'unsafe_abcd', 'message_1.json', {
        participants: [{ name: 'Me' }],
        messages: [
          {
            sender_name: 'Me',
            timestamp_ms: 1_706_933_106_000,
            content: 'bad refs',
            photos: [
              { uri: '/your_instagram_activity/messages/inbox/unsafe_abcd/photos/pic.jpg' },
              { uri: '/etc/passwd' },
              { uri: 'C:\\Users\\me\\pic.jpg' },
              { uri: '\\\\srv\\share\\pic.jpg' },
              { uri: '../../pic.jpg' },
            ],
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

      const { records, skips } = await run(dir, deps);

      expect(records.map((r) => r.sourceRef)).toEqual(['inbox/unsafe_abcd/message_1.json#0:text']);
      expect(skips.filter((skip) => skip.code === 'E_MEDIA_PATH')).toHaveLength(5);
      const safeRoot = ps(dir);
      for (const statted of statPaths.map(ps)) {
        expect(statted.startsWith(safeRoot)).toBe(true);
      }
    } finally {
      removeTmpDir(dir);
    }
  });

  it('streams inbox message files with mojibake decoding, dates, bounded text, and provenance', async () => {
    const dir = makeTmpDir('instagram-import-');
    try {
      writeInstagramMessageFile(dir, 'family_abcd', 'message_1.json', {
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
      const deps = depsForRealDir();
      const readFiles: string[] = [];
      const realReadFile = deps.fs.readFile;
      deps.fs.readFile = async (path: string) => {
        readFiles.push(path);
        return await realReadFile(path);
      };

      const { records, result, byRef, skips } = await run(dir, deps);

      expect(result.recordCount).toBe(2);
      expect(skips).toEqual([]);
      expect(readFiles).toEqual([]);
      expect(records.every((r) => r.sourceType === 'instagram')).toBe(true);
      expect(records.every((r) => r.mediaType === 'message')).toBe(true);
      expect(records.map((r) => r.sourceRef)).toEqual([
        'inbox/family_abcd/message_1.json#0:text',
        'inbox/family_abcd/message_1.json#1:text',
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
    const dir = makeTmpDir('instagram-media-');
    try {
      const threadDir = join(dir, IG_MESSAGES_ROOT, 'inbox', 'media_abcd');
      mkdirSync(join(threadDir, 'photos'), { recursive: true });
      mkdirSync(join(threadDir, 'videos'), { recursive: true });
      mkdirSync(join(threadDir, 'audio'), { recursive: true });
      writeFileSync(join(threadDir, 'photos', 'pic.jpg'), 'photo-bytes');
      writeFileSync(join(threadDir, 'videos', 'clip.mp4'), 'video-bytes');
      writeFileSync(join(threadDir, 'audio', 'voice.m4a'), 'audio-bytes');
      writeInstagramMessageFile(dir, 'media_abcd', 'message_1.json', {
        participants: [{ name: 'Me' }],
        messages: [
          {
            sender_name: 'Me',
            timestamp_ms: 1_706_933_106_000,
            content: 'look',
            photos: [{ uri: 'your_instagram_activity/messages/inbox/media_abcd/photos/pic.jpg' }],
            videos: [{ uri: 'messages/inbox/media_abcd/videos/clip.mp4' }],
            audio_files: [{ uri: 'messages/inbox/media_abcd/audio/voice.m4a' }],
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
        'inbox/media_abcd/message_1.json#0:audio_files:0',
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
      expect(byRef.get('inbox/media_abcd/message_1.json#0:audio_files:0')?.mediaType).toBe('audio');
      expect(ps(byRef.get('inbox/media_abcd/message_1.json#0:photos:0')?.originalPath)).toContain(
        '/your_instagram_activity/messages/inbox/media_abcd/photos/pic.jpg',
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

  // De-flake (#454): shrink the oversized fixture to just OVER the cap
  // (`MAX_MESSAGE_JSON_CHARS` = 1_000_000) instead of 2.5 MB — it proves the exact
  // same cap behaviour with the minimal input the parser must scan, so the test no
  // longer leans on a wall-clock timeout for a multi-MB parse. Generous timeout kept
  // only as margin.
  it('caps one oversized message object and keeps later messages without unbounded buffering', { timeout: 20_000 }, async () => {
    const dir = makeTmpDir('instagram-bounds-');
    try {
      const path = writeInstagramMessageFile(dir, 'huge_abcd', 'message_1.json', {
        participants: [{ name: 'Mamá' }],
        messages: [
          { sender_name: 'Mamá', timestamp_ms: 1, content: 'A'.repeat(1_000_001) },
          { sender_name: 'Mamá', timestamp_ms: 2, content: 'after huge' },
        ],
      });

      const { records, skips } = await run(dir, depsForRealDir());

      expect(records.map((r) => r.body)).toEqual(['after huge']);
      expect(skips).toContainEqual(
        expect.objectContaining({
          ref: `${ps(path).split('/your_instagram_activity/messages/')[1]}#0`,
          code: 'E_MESSAGE_TOO_LARGE',
        }),
      );
    } finally {
      removeTmpDir(dir);
    }
  });

  it('honors an already-aborted signal without opening message files', async () => {
    const dir = makeTmpDir('instagram-abort-');
    const controller = new AbortController();
    try {
      writeInstagramMessageFile(dir, 'family_abcd', 'message_1.json', {
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
