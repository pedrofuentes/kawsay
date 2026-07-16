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

// These tests target electron/main/importers/meta-dyi-messages.ts, the shared
// streaming-JSON connector behind both messengerImporter and instagramImporter.
// It has no dedicated fixture file of its own (only exercised indirectly via
// messenger-importer.test.ts / instagram-importer.test.ts); this file focuses
// specifically on the untrusted-input branches (malformed/oversized/adversarial
// export data) that those importer-identity-focused suites don't reach.

const WORK = '/work/meta-dyi';
const MESSAGES_ROOT = join('your_activity_across_facebook', 'messages');

function ps(path: string | null | undefined): string {
  return (path ?? '').split(sep).join('/');
}

function depsForRealDir(overrides: Partial<FsLike> = {}): ImporterDeps {
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
    ...overrides,
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
      sourceId: 'src-meta',
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

function writeRawMessageFile(root: string, bucket: string, thread: string, raw: string): string {
  const dir = join(root, MESSAGES_ROOT, bucket, thread);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'message_1.json');
  writeFileSync(path, raw);
  return path;
}

describe('meta-dyi-messages (shared Meta DYI streaming connector — untrusted-input branches)', () => {
  it('extracts messages and media from a zip export via injected extractArchive, ignoring entries outside the export root', async () => {
    const dir = makeTmpDir('meta-zip-ok-');
    try {
      const msgPath = writeMessageFile(dir, 'inbox', 'family_abcd', 'message_1.json', {
        participants: [{ name: 'Mamá' }],
        messages: [
          {
            sender_name: 'Mamá',
            timestamp_ms: 1_706_933_106_000,
            content: 'hola',
            photos: [
              { uri: 'your_activity_across_facebook/messages/inbox/family_abcd/photos/pic.jpg' },
            ],
          },
        ],
      });
      const photoDir = join(dir, MESSAGES_ROOT, 'inbox', 'family_abcd', 'photos');
      mkdirSync(photoDir, { recursive: true });
      const photoPath = join(photoDir, 'pic.jpg');
      writeFileSync(photoPath, 'photo-bytes');
      const readmePath = join(dir, 'README.txt');
      writeFileSync(readmePath, 'not part of the export root');

      const deps = depsForRealDir({
        // extractArchive is the injected, sandboxed seam — inject fake
        // extraction results instead of building a real zip.
      });
      deps.extractArchive = async () => [
        {
          entryPath: 'your_activity_across_facebook/messages/inbox/family_abcd/message_1.json',
          absPath: msgPath,
        },
        {
          entryPath: 'your_activity_across_facebook/messages/inbox/family_abcd/photos/pic.jpg',
          absPath: photoPath,
        },
        // An entry that does NOT start with the export's rootDir at all —
        // exercises the "not under our root" fallback path and must be
        // silently ignored rather than crash media indexing.
        { entryPath: 'README.txt', absPath: readmePath },
      ];

      const { records, byRef, skips } = await run(join(dir, 'export.zip'), deps);

      expect(skips).toEqual([]);
      expect(byRef.get('inbox/family_abcd/message_1.json#0:text')?.body).toBe('hola');
      expect(byRef.get('inbox/family_abcd/message_1.json#0:photos:0')).toMatchObject({
        mediaType: 'photo',
        mimeType: 'image/jpeg',
      });
      expect(records.some((r) => ps(r.originalPath).includes('README.txt'))).toBe(false);
    } finally {
      removeTmpDir(dir);
    }
  });

  it('reports E_ENTRY_LIMIT and still imports the entries within the cap when a zip yields more entries than the discovery cap', async () => {
    const dir = makeTmpDir('meta-zip-cap-');
    try {
      const msgPath = writeMessageFile(dir, 'inbox', 'family_abcd', 'message_1.json', {
        participants: [{ name: 'Mamá' }],
        messages: [{ sender_name: 'Mamá', timestamp_ms: 1, content: 'hola' }],
      });
      const deps = depsForRealDir();
      const junkEntries = Array.from({ length: 50_000 }, (_, i) => ({
        entryPath: `your_activity_across_facebook/junk/${i}.bin`,
        absPath: '/unused',
      }));
      deps.extractArchive = async () => [
        {
          entryPath: 'your_activity_across_facebook/messages/inbox/family_abcd/message_1.json',
          absPath: msgPath,
        },
        ...junkEntries,
      ];

      const { records, skips } = await run(join(dir, 'export.zip'), deps);

      expect(skips).toContainEqual(
        expect.objectContaining({
          ref: join(dir, 'export.zip'),
          code: 'E_ENTRY_LIMIT',
        }),
      );
      expect(records.some((r) => r.sourceRef === 'inbox/family_abcd/message_1.json#0:text')).toBe(
        true,
      );
    } finally {
      removeTmpDir(dir);
    }
  });

  it('reports E_EXTRACT and imports nothing when zip extraction throws', async () => {
    const dir = makeTmpDir('meta-zip-fail-');
    try {
      const deps = depsForRealDir();
      deps.extractArchive = async () => {
        throw new Error('corrupt central directory');
      };

      const { records, result, skips } = await run(join(dir, 'export.zip'), deps);

      expect(records).toEqual([]);
      expect(result.recordCount).toBe(0);
      expect(skips).toContainEqual(
        expect.objectContaining({ ref: join(dir, 'export.zip'), code: 'E_EXTRACT' }),
      );
    } finally {
      removeTmpDir(dir);
    }
  });

  it('caps the media index so a photo reference beyond the index cap is skipped as unresolved', async () => {
    const dir = makeTmpDir('meta-zip-mediacap-');
    try {
      const msgPath = writeMessageFile(dir, 'inbox', 'family_abcd', 'message_1.json', {
        participants: [{ name: 'Mamá' }],
        messages: [
          {
            sender_name: 'Mamá',
            timestamp_ms: 1,
            content: 'gallery',
            photos: [
              {
                uri: 'your_activity_across_facebook/messages/inbox/family_abcd/photos/overflow.jpg',
              },
            ],
          },
        ],
      });
      const deps = depsForRealDir();
      // Fill the media index past its cap (20,000) with synthetic photo
      // entries so the real referenced photo — indexed last — never makes it
      // in. Purely path strings; buildMediaResolver never touches disk for
      // these, so this stays cheap.
      const floodEntries = Array.from({ length: 20_000 }, (_, i) => ({
        entryPath: `your_activity_across_facebook/messages/inbox/family_abcd/photos/filler-${i}.jpg`,
        absPath: '/unused',
      }));
      deps.extractArchive = async () => [
        {
          entryPath: 'your_activity_across_facebook/messages/inbox/family_abcd/message_1.json',
          absPath: msgPath,
        },
        ...floodEntries,
        {
          entryPath: 'your_activity_across_facebook/messages/inbox/family_abcd/photos/overflow.jpg',
          absPath: '/unused-real',
        },
      ];

      const { records, skips } = await run(join(dir, 'export.zip'), deps);

      expect(records.some((r) => r.sourceRef === 'inbox/family_abcd/message_1.json#0:photos:0')).toBe(
        false,
      );
      expect(skips).toContainEqual(
        expect.objectContaining({
          ref: 'inbox/family_abcd/message_1.json#0:photos:0',
          code: 'E_MEDIA_PATH',
        }),
      );
    } finally {
      removeTmpDir(dir);
    }
  });

  it('reports E_ENTRY_LIMIT for a folder export whose discovery exceeds the entry cap', async () => {
    const dir = makeTmpDir('meta-folder-cap-');
    try {
      const bigDir = join(dir, 'flood');
      const names = Array.from({ length: 50_001 }, (_, i) => `f${i}.json`);
      const deps = depsForRealDir({
        readDir: async (path: string) => {
          if (path === dir) return ['flood'];
          if (path === bigDir) return names;
          return await readdir(path);
        },
        stat: async (path: string): Promise<FileStat> => {
          if (path === bigDir) {
            return { size: 0, mtimeMs: 0, isFile: () => false, isDirectory: () => true };
          }
          if (path.startsWith(bigDir + sep) || path.startsWith(`${bigDir}/`)) {
            return { size: 0, mtimeMs: 0, isFile: () => true, isDirectory: () => false };
          }
          return await stat(path);
        },
      });

      const { skips } = await run(dir, deps);

      expect(skips).toContainEqual(expect.objectContaining({ ref: dir, code: 'E_ENTRY_LIMIT' }));
    } finally {
      removeTmpDir(dir);
    }
  });

  it('reports E_READDIR for an unreadable thread bucket but keeps importing other threads', async () => {
    const dir = makeTmpDir('meta-readdir-fail-');
    try {
      writeMessageFile(dir, 'inbox', 'ok_abcd', 'message_1.json', {
        participants: [{ name: 'Mamá' }],
        messages: [{ sender_name: 'Mamá', timestamp_ms: 1, content: 'still works' }],
      });
      const badDir = join(dir, MESSAGES_ROOT, 'archived_threads');
      mkdirSync(badDir, { recursive: true });
      writeFileSync(join(badDir, 'placeholder'), 'x');

      const deps = depsForRealDir({
        readDir: async (path: string) => {
          if (path === badDir) throw new Error('EACCES: permission denied');
          return await readdir(path);
        },
      });

      const { records, skips } = await run(dir, deps);

      expect(skips).toContainEqual(
        expect.objectContaining({ ref: badDir, code: 'E_READDIR' }),
      );
      expect(records.some((r) => r.sourceRef === 'inbox/ok_abcd/message_1.json#0:text')).toBe(true);
    } finally {
      removeTmpDir(dir);
    }
  });

  it('reports E_STAT for an entry that cannot be statted during folder discovery', async () => {
    const dir = makeTmpDir('meta-stat-fail-');
    try {
      writeMessageFile(dir, 'inbox', 'ok_abcd', 'message_1.json', {
        participants: [{ name: 'Mamá' }],
        messages: [{ sender_name: 'Mamá', timestamp_ms: 1, content: 'still works' }],
      });
      const ghost = join(dir, MESSAGES_ROOT, 'inbox', 'ghost_entry');

      const deps = depsForRealDir({
        readDir: async (path: string) => {
          const names = await readdir(path);
          return path === join(dir, MESSAGES_ROOT, 'inbox') ? [...names, 'ghost_entry'] : names;
        },
        stat: async (path: string): Promise<FileStat> => {
          if (path === ghost) throw new Error('ENOENT: vanished mid-scan');
          return await stat(path);
        },
      });

      const { records, skips } = await run(dir, deps);

      expect(skips).toContainEqual(expect.objectContaining({ ref: ghost, code: 'E_STAT' }));
      expect(records.some((r) => r.sourceRef === 'inbox/ok_abcd/message_1.json#0:text')).toBe(true);
    } finally {
      removeTmpDir(dir);
    }
  });

  it('stops discovery early without crashing when the signal aborts mid folder-walk', async () => {
    const dir = makeTmpDir('meta-walk-abort-');
    const controller = new AbortController();
    try {
      writeMessageFile(dir, 'inbox', 'thread_a', 'message_1.json', {
        participants: [{ name: 'A' }],
        messages: [{ sender_name: 'A', timestamp_ms: 1, content: 'a' }],
      });
      writeMessageFile(dir, 'inbox', 'thread_b', 'message_1.json', {
        participants: [{ name: 'B' }],
        messages: [{ sender_name: 'B', timestamp_ms: 1, content: 'b' }],
      });
      const inboxDir = join(dir, MESSAGES_ROOT, 'inbox');
      const deps = depsForRealDir({
        readDir: async (path: string) => {
          const names = await readdir(path);
          if (path === inboxDir) controller.abort();
          return names;
        },
      });

      const { records, result } = await run(dir, deps, controller.signal);

      expect(records.length).toBeLessThanOrEqual(2);
      expect(result.recordCount).toBe(records.length);
    } finally {
      removeTmpDir(dir);
    }
  });

  it('reports E_READ_JSON when the deps do not support streaming reads', async () => {
    const dir = makeTmpDir('meta-no-stream-');
    try {
      const path = writeMessageFile(dir, 'inbox', 'family_abcd', 'message_1.json', {
        participants: [{ name: 'Mamá' }],
        messages: [{ sender_name: 'Mamá', timestamp_ms: 1, content: 'hola' }],
      });
      const deps = depsForRealDir();
      delete deps.fs.openReadStream;

      const { records, skips } = await run(dir, deps);

      expect(records).toEqual([]);
      const rel = ps(path).split('/your_activity_across_facebook/messages/')[1];
      expect(skips).toContainEqual(
        expect.objectContaining({
          ref: rel,
          code: 'E_READ_JSON',
          reason: expect.stringContaining('streaming file reads are unavailable'),
        }),
      );
    } finally {
      removeTmpDir(dir);
    }
  });

  it('decodes raw (non-encoded) Buffer stream chunks the same as pre-decoded string chunks', async () => {
    const dir = makeTmpDir('meta-buffer-chunks-');
    try {
      writeMessageFile(dir, 'inbox', 'family_abcd', 'message_1.json', {
        participants: [{ name: 'Mamá' }],
        messages: [{ sender_name: 'Mamá', timestamp_ms: 1_706_933_106_000, content: 'hola' }],
      });
      // No `encoding` option — Node emits raw Buffer chunks instead of strings.
      const deps = depsForRealDir({ openReadStream: (path: string) => createReadStream(path) });

      expect(await messengerImporter.canHandle(dir, deps)).toBe(true);

      const { byRef, skips } = await run(dir, deps);

      expect(skips).toEqual([]);
      expect(byRef.get('inbox/family_abcd/message_1.json#0:text')?.body).toBe('hola');
    } finally {
      removeTmpDir(dir);
    }
  });

  it('canHandle safely returns false (without hanging) when required markers sit beyond the bounded read cap', async () => {
    const dir = makeTmpDir('meta-can-oversized-');
    try {
      writeMessageFile(dir, 'inbox', 'huge_abcd', 'message_1.json', {
        participants: [{ name: 'Mamá' }],
        title: 'x'.repeat(1_200_000),
        messages: [{ sender_name: 'Mamá', timestamp_ms: 1, content: 'hola' }],
      });

      expect(await messengerImporter.canHandle(dir, depsForRealDir())).toBe(false);
    } finally {
      removeTmpDir(dir);
    }
  });

  it('canHandle skips a stray non-directory entry sitting alongside real thread directories', async () => {
    const dir = makeTmpDir('meta-can-strayfile-');
    try {
      writeMessageFile(dir, 'inbox', 'family_abcd', 'message_1.json', {
        participants: [{ name: 'Mamá' }],
        messages: [{ sender_name: 'Mamá', timestamp_ms: 1, content: 'hola' }],
      });
      writeFileSync(join(dir, MESSAGES_ROOT, 'inbox', 'README.txt'), 'not a thread');

      expect(await messengerImporter.canHandle(dir, depsForRealDir())).toBe(true);
    } finally {
      removeTmpDir(dir);
    }
  });

  it('skips a media entry with a missing or non-string uri as E_MEDIA_URI', async () => {
    const dir = makeTmpDir('meta-media-nouri-');
    try {
      writeMessageFile(dir, 'inbox', 'family_abcd', 'message_1.json', {
        participants: [{ name: 'Me' }],
        messages: [
          {
            sender_name: 'Me',
            timestamp_ms: 1,
            content: 'bad media',
            photos: [{}, { uri: 12345 }, { uri: '   ' }],
          },
        ],
      });

      const { records, skips } = await run(dir, depsForRealDir());

      expect(records.map((r) => r.sourceRef)).toEqual(['inbox/family_abcd/message_1.json#0:text']);
      expect(skips.filter((s) => s.code === 'E_MEDIA_URI')).toHaveLength(3);
    } finally {
      removeTmpDir(dir);
    }
  });

  it('yields no records (without crashing) when a thread\'s "messages" field is not an array, even with a decoy participant literally named "messages"', async () => {
    const dir = makeTmpDir('meta-notarray-');
    try {
      writeRawMessageFile(
        dir,
        'inbox',
        'weird_abcd',
        '{"participants":[{"name":"messages"}],"messages":"not-an-array"}',
      );

      const { records, skips } = await run(dir, depsForRealDir());

      expect(records).toEqual([]);
      expect(skips).toEqual([]);
    } finally {
      removeTmpDir(dir);
    }
  });

  it('falls back to safe default thread metadata when the metadata prefix overflows the bounded reconstruction window, but still imports the message itself', async () => {
    const dir = makeTmpDir('meta-badmeta-');
    try {
      // The importer only keeps a bounded sliding window (64 KiB) of prefix
      // text for reconstructing thread metadata ahead of the "messages" key.
      // A title long enough to push the opening `{` out of that window makes
      // the reconstructed metadata text invalid JSON — this must degrade to
      // fallback metadata (derived from the path alone) rather than throw or
      // corrupt the message stream itself.
      writeMessageFile(dir, 'inbox', 'badmeta_abcd', 'message_1.json', {
        participants: [{ name: 'A' }],
        title: 'x'.repeat(70_000),
        messages: [{ sender_name: 'A', timestamp_ms: 1, content: 'hi' }],
      });

      const { records, byRef, skips } = await run(dir, depsForRealDir());

      expect(skips).toEqual([]);
      expect(records.map((r) => r.sourceRef)).toEqual([
        'inbox/badmeta_abcd/message_1.json#0:text',
      ]);
      const record = byRef.get('inbox/badmeta_abcd/message_1.json#0:text');
      expect(record?.body).toBe('hi');
      expect(record?.sourceMeta).toMatchObject({
        thread: 'inbox/badmeta_abcd',
        threadBucket: 'inbox',
        threadTitle: null,
        participants: [],
      });
    } finally {
      removeTmpDir(dir);
    }
  });

  it('parses thread metadata containing an escaped quote and filters out non-object participant entries', async () => {
    const dir = makeTmpDir('meta-escapedmeta-');
    try {
      writeMessageFile(dir, 'inbox', 'escaped_abcd', 'message_1.json', {
        participants: ['stray-string-participant', { name: 'Ana "Anita"' }, null],
        title: 'Chat with \\backslash and "quotes"',
        messages: [{ sender_name: 'Ana "Anita"', timestamp_ms: 1, content: 'hi' }],
      });

      const { byRef, skips } = await run(dir, depsForRealDir());

      expect(skips).toEqual([]);
      const record = byRef.get('inbox/escaped_abcd/message_1.json#0:text');
      expect(record?.sourceMeta).toMatchObject({
        participants: ['Ana "Anita"'],
      });
    } finally {
      removeTmpDir(dir);
    }
  });

  it('bounds recursive text extraction depth and handles array/object/scalar content shapes', async () => {
    const dir = makeTmpDir('meta-textshapes-');
    try {
      let deeplyNested: unknown = 'buried too deep';
      for (let i = 0; i < 25; i++) deeplyNested = { text: deeplyNested };

      writeMessageFile(dir, 'inbox', 'shapes_abcd', 'message_1.json', {
        participants: [{ name: 'Me' }],
        messages: [
          { sender_name: 'Me', timestamp_ms: 1, content: deeplyNested },
          { sender_name: 'Me', timestamp_ms: 2, content: ['Hello ', 'World'] },
          { sender_name: 'Me', timestamp_ms: 3, content: 42 },
          { sender_name: 'Me', timestamp_ms: 4, content: { sticker: { uri: 'x' } } },
        ],
      });

      const { byRef, skips } = await run(dir, depsForRealDir());

      expect(skips).toEqual([]);
      expect(byRef.get('inbox/shapes_abcd/message_1.json#0:text')?.body).toBeNull();
      expect(byRef.get('inbox/shapes_abcd/message_1.json#1:text')?.body).toBe('Hello World');
      expect(byRef.get('inbox/shapes_abcd/message_1.json#2:text')?.body).toBeNull();
      expect(byRef.get('inbox/shapes_abcd/message_1.json#3:text')?.body).toBeNull();
    } finally {
      removeTmpDir(dir);
    }
  });

  it('degrades a missing, non-numeric, or out-of-range timestamp_ms to a null date instead of throwing', async () => {
    const dir = makeTmpDir('meta-badtimestamp-');
    try {
      writeMessageFile(dir, 'inbox', 'dates_abcd', 'message_1.json', {
        participants: [{ name: 'Me' }],
        messages: [
          { sender_name: 'Me', content: 'no timestamp field at all' },
          { sender_name: 'Me', timestamp_ms: 'not-a-number', content: 'corrupted timestamp' },
          { sender_name: 'Me', timestamp_ms: 8.64e18, content: 'astronomically out of range' },
        ],
      });

      const { byRef, skips } = await run(dir, depsForRealDir());

      expect(skips).toEqual([]);
      expect(byRef.get('inbox/dates_abcd/message_1.json#0:text')?.date).toBeNull();
      expect(byRef.get('inbox/dates_abcd/message_1.json#1:text')?.date).toBeNull();
      expect(byRef.get('inbox/dates_abcd/message_1.json#2:text')?.date).toBeNull();
    } finally {
      removeTmpDir(dir);
    }
  });

  it('bounds recursive array-text extraction: breaks once the bounded cap is reached and degrades non-text items and all-whitespace results to null', async () => {
    const dir = makeTmpDir('meta-textarray-');
    try {
      writeMessageFile(dir, 'inbox', 'array_abcd', 'message_1.json', {
        participants: [{ name: 'Me' }],
        messages: [
          {
            sender_name: 'Me',
            timestamp_ms: 1,
            // Two 15k-char parts push the joined text past the 20k bound,
            // so the third element must never be reached (loop breaks early).
            content: ['A'.repeat(15_000), 'B'.repeat(15_000), 'C'],
          },
          {
            sender_name: 'Me',
            timestamp_ms: 2,
            // A non-text array item (number) degrades to '' via the ?? fallback,
            // and an all-whitespace result trims to '' -> null via the || fallback.
            content: [42, '   '],
          },
        ],
      });

      const { byRef, skips } = await run(dir, depsForRealDir());

      expect(skips).toEqual([]);
      const capped = byRef.get('inbox/array_abcd/message_1.json#0:text')?.body;
      expect(capped).toHaveLength(20_000);
      expect(capped?.endsWith('C')).toBe(false);
      expect(byRef.get('inbox/array_abcd/message_1.json#1:text')?.body).toBeNull();
    } finally {
      removeTmpDir(dir);
    }
  });

  it('reports E_READDIR with a stringified (non-Error) failure reason when readDir throws a non-Error value', async () => {
    const dir = makeTmpDir('meta-nonerror-throw-');
    try {
      const badDir = join(dir, MESSAGES_ROOT, 'inbox');
      mkdirSync(badDir, { recursive: true });

      const deps = depsForRealDir({
        readDir: async (path: string) => {
          if (path === badDir) throw 'EACCES: permission denied';
          return await readdir(path);
        },
      });

      const { skips } = await run(dir, deps);

      expect(skips).toContainEqual(
        expect.objectContaining({
          ref: badDir,
          code: 'E_READDIR',
          reason: expect.stringContaining('EACCES: permission denied'),
        }),
      );
    } finally {
      removeTmpDir(dir);
    }
  });

  it('canHandle returns false when a bucket only contains thread directories with no message_*.json inside', async () => {
    const dir = makeTmpDir('meta-can-emptythreads-');
    try {
      mkdirSync(join(dir, MESSAGES_ROOT, 'inbox', 'empty_thread'), { recursive: true });
      writeFileSync(
        join(dir, MESSAGES_ROOT, 'inbox', 'empty_thread', 'not-a-message.txt'),
        'nope',
      );

      expect(await messengerImporter.canHandle(dir, depsForRealDir())).toBe(false);
    } finally {
      removeTmpDir(dir);
    }
  });

  it('stops a sibling directory walk before it starts once the signal is aborted while statting an earlier entry', async () => {
    const dir = makeTmpDir('meta-walk-abort-sibling-');
    const controller = new AbortController();
    try {
      writeMessageFile(dir, 'inbox', 'thread_a', 'message_1.json', {
        participants: [{ name: 'A' }],
        messages: [{ sender_name: 'A', timestamp_ms: 1, content: 'a' }],
      });
      writeMessageFile(dir, 'inbox', 'thread_b', 'message_1.json', {
        participants: [{ name: 'B' }],
        messages: [{ sender_name: 'B', timestamp_ms: 1, content: 'b' }],
      });
      const threadADir = join(dir, MESSAGES_ROOT, 'inbox', 'thread_a');
      const deps = depsForRealDir({
        stat: async (path: string): Promise<FileStat> => {
          const result = await stat(path);
          if (path === threadADir) controller.abort();
          return result;
        },
      });

      const { records } = await run(dir, deps, controller.signal);

      // thread_b's directory must never even be entered once aborted.
      expect(records.some((r) => r.sourceRef.includes('thread_b'))).toBe(false);
    } finally {
      removeTmpDir(dir);
    }
  });

  it('skips a message whose JSON object nesting exceeds the depth cap with E_MESSAGE_TOO_DEEP', async () => {
    const dir = makeTmpDir('meta-toodeep-');
    try {
      const nestDepth = 105;
      const nested = '{"a":'.repeat(nestDepth) + 'null' + '}'.repeat(nestDepth);
      const raw = `{"participants":[{"name":"A"}],"messages":[{"sender_name":"A","timestamp_ms":1,"content":"buried","junk":${nested}},{"sender_name":"A","timestamp_ms":2,"content":"after"}]}`;
      writeRawMessageFile(dir, 'inbox', 'toodeep_abcd', raw);

      const { records, skips } = await run(dir, depsForRealDir());

      expect(records.map((r) => r.body)).toEqual(['after']);
      expect(skips).toContainEqual(
        expect.objectContaining({
          ref: 'inbox/toodeep_abcd/message_1.json#0',
          code: 'E_MESSAGE_TOO_DEEP',
        }),
      );
    } finally {
      removeTmpDir(dir);
    }
  });

  it('skips a syntactically malformed message object with E_PARSE_MESSAGE and keeps draining later messages', async () => {
    const dir = makeTmpDir('meta-malformed-msg-');
    try {
      const raw =
        '{"participants":[{"name":"A"}],"messages":[' +
        '{"sender_name":"A",timestamp_ms:1,"content":"unquoted key is invalid JSON"},' +
        '{"sender_name":"A","timestamp_ms":2,"content":"still parses fine"}' +
        ']}';
      writeRawMessageFile(dir, 'inbox', 'malformed_abcd', raw);

      const { records, skips } = await run(dir, depsForRealDir());

      expect(records.map((r) => r.body)).toEqual(['still parses fine']);
      expect(skips).toContainEqual(
        expect.objectContaining({
          ref: 'inbox/malformed_abcd/message_1.json#0',
          code: 'E_PARSE_MESSAGE',
        }),
      );
    } finally {
      removeTmpDir(dir);
    }
  });

  it('tolerates whitespace between the "messages" key and its colon', async () => {
    const dir = makeTmpDir('meta-whitespace-colon-');
    try {
      const raw =
        '{"participants":[{"name":"A"}],"messages"   :   [{"sender_name":"A","timestamp_ms":1,"content":"hi"}]}';
      writeRawMessageFile(dir, 'inbox', 'wscolon_abcd', raw);

      const { records, skips } = await run(dir, depsForRealDir());

      expect(skips).toEqual([]);
      expect(records.map((r) => r.body)).toEqual(['hi']);
    } finally {
      removeTmpDir(dir);
    }
  });

  it('resolves a media uri to null when normalization empties the path or the path targets a bucket outside the export config', async () => {
    const dir = makeTmpDir('meta-media-edgepaths-');
    try {
      writeMessageFile(dir, 'inbox', 'family_abcd', 'message_1.json', {
        participants: [{ name: 'Me' }],
        messages: [
          {
            sender_name: 'Me',
            timestamp_ms: 1,
            content: 'bad refs',
            photos: [{ uri: './' }, { uri: 'messages/not_a_real_bucket/thread/pic.jpg' }],
          },
        ],
      });

      const { records, skips } = await run(dir, depsForRealDir());

      expect(records.map((r) => r.sourceRef)).toEqual(['inbox/family_abcd/message_1.json#0:text']);
      expect(skips.filter((s) => s.code === 'E_MEDIA_PATH')).toHaveLength(2);
    } finally {
      removeTmpDir(dir);
    }
  });

  it('canHandle accepts a rootless-messages .zip export when the source config allows it', async () => {
    const dir = makeTmpDir('meta-zip-rootless-');
    try {
      // messengerImporter.allowRootlessMessages is true, so canHandle's zip
      // marker scan must also accept the ROOTLESS `messages/inbox/` prefix
      // (no rootDir segment at all) alongside the rooted one.
      const { buildZip } = await import('../helpers/zip');
      const zipPath = join(dir, 'export.zip');
      writeFileSync(
        zipPath,
        buildZip([{ name: 'messages/inbox/family_abcd/message_1.json', data: Buffer.from('{}') }]),
      );

      expect(await messengerImporter.canHandle(zipPath, depsForRealDir())).toBe(true);
    } finally {
      removeTmpDir(dir);
    }
  });

  it('canHandle rejects a plain file path that is neither a .zip nor a directory', async () => {
    const parent = makeTmpDir('meta-can-filepath-');
    try {
      const file = join(parent, 'not-a-dir.txt');
      writeFileSync(file, 'just a file');

      expect(await messengerImporter.canHandle(file, depsForRealDir())).toBe(false);
    } finally {
      removeTmpDir(parent);
    }
  });

  it('silently ignores a non-object entry within a media array without recording a skip', async () => {
    const dir = makeTmpDir('meta-media-nonobject-');
    try {
      writeMessageFile(dir, 'inbox', 'family_abcd', 'message_1.json', {
        participants: [{ name: 'Me' }],
        messages: [
          {
            sender_name: 'Me',
            timestamp_ms: 1,
            content: 'mixed media array',
            photos: [null, 'not-an-object'],
          },
        ],
      });

      const { records, skips } = await run(dir, depsForRealDir());

      expect(records.map((r) => r.sourceRef)).toEqual(['inbox/family_abcd/message_1.json#0:text']);
      expect(skips).toEqual([]);
    } finally {
      removeTmpDir(dir);
    }
  });

  it('stops streaming further messages within the same thread once aborted mid-thread', async () => {
    const dir = makeTmpDir('meta-abort-midthread-');
    const controller = new AbortController();
    try {
      writeMessageFile(dir, 'inbox', 'family_abcd', 'message_1.json', {
        participants: [{ name: 'Me' }],
        messages: [
          { sender_name: 'Me', timestamp_ms: 1, content: 'first' },
          { sender_name: 'Me', timestamp_ms: 2, content: 'second' },
        ],
      });
      const deps = depsForRealDir();
      const ctx: ImportContext = {
        sourceId: 'src-meta',
        workDir: WORK,
        signal: controller.signal,
        deps,
        onSkip: () => {},
        onProgress: (update) => {
          if (update.phase === 'emit' && update.processed === 1) controller.abort();
        },
      };
      const records: CatalogRecord[] = [];
      const result = await drainImporter(messengerImporter, dir, ctx, (r) => records.push(r));

      expect(records.map((r) => r.body)).toEqual(['first']);
      expect(result.recordCount).toBe(1);
    } finally {
      removeTmpDir(dir);
    }
  });

  it('stops before starting the next thread file once aborted after the current thread finishes', async () => {
    const dir = makeTmpDir('meta-abort-nextthread-');
    const controller = new AbortController();
    try {
      writeMessageFile(dir, 'inbox', 'alpha_thread', 'message_1.json', {
        participants: [{ name: 'A' }],
        messages: [{ sender_name: 'A', timestamp_ms: 1, content: 'from alpha' }],
      });
      writeMessageFile(dir, 'inbox', 'zeta_thread', 'message_1.json', {
        participants: [{ name: 'Z' }],
        messages: [{ sender_name: 'Z', timestamp_ms: 1, content: 'from zeta' }],
      });
      const deps = depsForRealDir();
      const ctx: ImportContext = {
        sourceId: 'src-meta',
        workDir: WORK,
        signal: controller.signal,
        deps,
        onSkip: () => {},
        onProgress: (update) => {
          if (update.phase === 'emit' && update.processed === 1) controller.abort();
        },
      };
      const records: CatalogRecord[] = [];
      const result = await drainImporter(messengerImporter, dir, ctx, (r) => records.push(r));

      expect(records.map((r) => r.body)).toEqual(['from alpha']);
      expect(result.recordCount).toBe(1);
    } finally {
      removeTmpDir(dir);
    }
  });

  it('sorts message files within the same bucket alphabetically by thread', async () => {
    const dir = makeTmpDir('meta-samebucket-sort-');
    try {
      writeMessageFile(dir, 'inbox', 'zeta_thread', 'message_1.json', {
        participants: [{ name: 'Z' }],
        messages: [{ sender_name: 'Z', timestamp_ms: 1, content: 'zeta' }],
      });
      writeMessageFile(dir, 'inbox', 'alpha_thread', 'message_1.json', {
        participants: [{ name: 'A' }],
        messages: [{ sender_name: 'A', timestamp_ms: 1, content: 'alpha' }],
      });

      const { records } = await run(dir, depsForRealDir());

      expect(records.map((r) => r.sourceRef)).toEqual([
        'inbox/alpha_thread/message_1.json#0:text',
        'inbox/zeta_thread/message_1.json#0:text',
      ]);
    } finally {
      removeTmpDir(dir);
    }
  });
});
