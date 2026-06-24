import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drainImporter } from '../../electron/main/importers/drain';
import {
  decodeFacebookText,
  facebookImporter,
} from '../../electron/main/importers/facebook-importer';
import type {
  CatalogRecord,
  FileStat,
  FsLike,
  ImportContext,
  ImporterDeps,
  ImportProgress,
  ImportResult,
  SkippedItem,
} from '../../electron/main/importers/types';

// The Facebook "Download Your Information" export ships as a zip of JSON files
// where every non-ASCII string is mojibake — each UTF-8 byte escaped as its own
// \u00XX code unit. The fixtures below are byte-faithful captures of that quirk
// (generated from real UTF-8: accents, an emoji, and a Cyrillic name), so these
// tests prove the importer recovers the true text (AC-16) rather than storing
// garbled names/messages in a memorial archive.
function fbFixture(rel: string): string {
  return readFileSync(fileURLToPath(new URL(`../fixtures/facebook/${rel}`, import.meta.url)), 'utf8');
}
const POSTS_1 = fbFixture('posts/your_posts_1.json');
const POSTS_2_BAD = fbFixture('posts/your_posts_2.json');
const MESSAGE_1 = fbFixture('messages/inbox/jose_abc/message_1.json');
const ALBUM_0 = fbFixture('photos_and_videos/album/0.json');

const WORK = '/work/facebook';

// originalPath is a real, OS-native absolute path (back-slashed on Windows). The
// fixtures use POSIX uris, so compare separator-agnostically: a no-op on POSIX.
function ps(p: string | null | undefined): string {
  return (p ?? '').split(sep).join('/');
}

// The real, correct text the mojibake fixtures must decode back to.
const POST0_TEXT = 'Feliz Año Nuevo 🎉 — con José y Жанна';
const POST1_TEXT = 'Día en la playa ☀️';
const MSG0_TEXT = '¡Hola! ¿Cómo estás? 😀';
const MSG1_TEXT = 'Mira esta foto 📸';

interface ArchiveEntry {
  entryPath: string;
  content?: string;
}

// A zip-backed deps double mirroring the guarded SafeExtractFn: extractArchive
// returns each entry at an absPath under workDir and registers its bytes so the
// importer's fs.readFile resolves — JSON files and their referenced media alike.
function makeZipDeps(entries: readonly ArchiveEntry[]): {
  deps: ImporterDeps;
  extractCalls: string[];
  contentByAbs: Map<string, string>;
} {
  const contentByAbs = new Map<string, string>();
  const extractCalls: string[] = [];

  const fs: FsLike = {
    async readFile(path: string): Promise<Buffer> {
      const text = contentByAbs.get(path);
      if (text === undefined) throw new Error(`ENOENT readFile ${path}`);
      return Buffer.from(text, 'utf8');
    },
    async readDir(): Promise<readonly string[]> {
      throw new Error('readDir not used in zip mode');
    },
    async stat(): Promise<FileStat> {
      return { size: 0, mtimeMs: 0, isFile: () => true, isDirectory: () => false };
    },
    async exists(): Promise<boolean> {
      return true;
    },
  };

  const deps: ImporterDeps = {
    fs,
    async extractArchive(archivePath: string, destDir: string) {
      extractCalls.push(archivePath);
      return entries.map((entry) => {
        const absPath = join(destDir, entry.entryPath);
        contentByAbs.set(absPath, entry.content ?? '');
        return { entryPath: entry.entryPath, absPath };
      });
    },
    readExif: async () => null,
    probeMedia: async () => ({ durationSec: null, width: null, height: null, mimeType: null }),
    hashFile: async () => 'deadbeef',
  };
  return { deps, extractCalls, contentByAbs };
}

// A nested in-memory folder (a Facebook export the user already extracted). The
// tree is built along the exact join(root, ...segments) chain the importer's
// walkFolder rebuilds, so the double is consistent on POSIX and Windows alike.
function makeFolderDeps(root: string, files: Record<string, string>): ImporterDeps {
  const fileMap = new Map<string, string>();
  const childrenByDir = new Map<string, Set<string>>();
  const addChild = (dir: string, name: string): void => {
    const existing = childrenByDir.get(dir);
    if (existing) existing.add(name);
    else childrenByDir.set(dir, new Set([name]));
  };
  for (const [rel, content] of Object.entries(files)) {
    const segments = rel.split('/');
    let cur = root;
    for (let i = 0; i < segments.length; i++) {
      addChild(cur, segments[i]);
      cur = join(cur, segments[i]);
      if (i === segments.length - 1) fileMap.set(cur, content);
    }
  }
  const isDir = (path: string): boolean => path === root || childrenByDir.has(path);
  const fs: FsLike = {
    async readFile(path: string): Promise<Buffer> {
      const text = fileMap.get(path);
      if (text === undefined) throw new Error(`ENOENT readFile ${path}`);
      return Buffer.from(text, 'utf8');
    },
    async readDir(path: string): Promise<readonly string[]> {
      const children = childrenByDir.get(path);
      if (children === undefined && path !== root) throw new Error(`ENOTDIR ${path}`);
      return [...(children ?? [])];
    },
    async stat(path: string): Promise<FileStat> {
      const file = fileMap.has(path);
      const dir = isDir(path);
      if (!file && !dir) throw new Error(`ENOENT stat ${path}`);
      return { size: 0, mtimeMs: 0, isFile: () => file, isDirectory: () => dir };
    },
    async exists(path: string): Promise<boolean> {
      return isDir(path) || fileMap.has(path);
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

function makeContext(
  deps: ImporterDeps,
  signal?: AbortSignal,
): { ctx: ImportContext; skips: SkippedItem[]; progress: Partial<ImportProgress>[] } {
  const skips: SkippedItem[] = [];
  const progress: Partial<ImportProgress>[] = [];
  const ctx: ImportContext = {
    sourceId: 'src-facebook',
    workDir: WORK,
    signal: signal ?? new AbortController().signal,
    deps,
    onSkip: (item) => skips.push(item),
    onProgress: (update) => progress.push(update),
  };
  return { ctx, skips, progress };
}

async function run(
  inputPath: string,
  deps: ImporterDeps,
  signal?: AbortSignal,
): Promise<{
  records: CatalogRecord[];
  result: ImportResult;
  skips: SkippedItem[];
  progress: Partial<ImportProgress>[];
}> {
  const c = makeContext(deps, signal);
  const records: CatalogRecord[] = [];
  const result = await drainImporter(facebookImporter, inputPath, c.ctx, (r) => records.push(r));
  return { records, result, skips: c.skips, progress: c.progress };
}

// The full, real-shaped export: posts (text + photo attachments), a message
// thread (text + a photo + an empty message), and a standalone album — plus a
// garbage post entry and a wholly malformed posts file to exercise resilience.
const FULL_ENTRIES: ArchiveEntry[] = [
  { entryPath: 'posts/your_posts_1.json', content: POSTS_1 },
  { entryPath: 'posts/your_posts_2.json', content: POSTS_2_BAD },
  { entryPath: 'posts/media/playa.jpg', content: 'jpeg-bytes' },
  { entryPath: 'posts/media/familia.png', content: 'png-bytes' },
  { entryPath: 'messages/inbox/jose_abc/message_1.json', content: MESSAGE_1 },
  { entryPath: 'messages/inbox/jose_abc/photos/pic.jpg', content: 'jpeg-bytes' },
  { entryPath: 'photos_and_videos/album/0.json', content: ALBUM_0 },
  { entryPath: 'photos_and_videos/album/media/abuela.jpg', content: 'jpeg-bytes' },
  { entryPath: 'photos_and_videos/album/media/perro.jpg', content: 'jpeg-bytes' },
];
const ZIP = '/drop/facebook-jose.zip';

describe('facebookImporter (card C5 — Facebook "Download Your Information", AC-16)', () => {
  it('identifies itself as the facebook source', () => {
    expect(facebookImporter.id).toBe('facebook');
    expect(facebookImporter.displayName).toBeTypeOf('string');
    expect(facebookImporter.displayName.length).toBeGreaterThan(0);
  });

  describe('mojibake fix — latin1-escaped UTF-8 → faithful text (the AC-16 crux)', () => {
    it('a naive JSON.parse leaves the post text garbled (proves the bug exists)', () => {
      const naive = (JSON.parse(POSTS_1) as { data: { post: string }[] }[])[0].data[0].post;
      expect(naive).not.toBe(POST0_TEXT);
    });

    it('decodes accents, an emoji, and a non-Latin (Cyrillic) name byte-for-byte', () => {
      const naive = (JSON.parse(POSTS_1) as { data: { post: string }[] }[])[0].data[0].post;
      expect(decodeFacebookText(naive)).toBe(POST0_TEXT);
    });

    it('leaves plain ASCII untouched', () => {
      expect(decodeFacebookText('Hello, world! 123')).toBe('Hello, world! 123');
    });

    it('is a safe no-op on already-correct text (never double-decodes genuine Unicode)', () => {
      expect(decodeFacebookText('café ☕')).toBe('café ☕');
      expect(decodeFacebookText('Жанна')).toBe('Жанна');
    });
  });

  describe('canHandle discriminates Facebook from LinkedIn and unknown zips', () => {
    function zipWithBytes(marker: string): ImporterDeps {
      const deps = makeZipDeps([]).deps;
      (deps.fs as unknown as { readFile: (p: string) => Promise<Buffer> }).readFile = async () =>
        Buffer.from(`PK\u0003\u0004........${marker}........`);
      return deps;
    }

    it('accepts a zip whose central directory carries Facebook markers', async () => {
      expect(
        await facebookImporter.canHandle('/drop/fb.zip', zipWithBytes('posts/your_posts_1.json')),
      ).toBe(true);
      expect(
        await facebookImporter.canHandle(
          '/drop/fb.zip',
          zipWithBytes('messages/inbox/thread/message_1.json'),
        ),
      ).toBe(true);
    });

    it('rejects a LinkedIn zip and an unrelated zip', async () => {
      expect(await facebookImporter.canHandle('/drop/li.zip', zipWithBytes('Connections.csv'))).toBe(
        false,
      );
      expect(
        await facebookImporter.canHandle('/drop/x.zip', zipWithBytes('Takeout/index.html')),
      ).toBe(false);
    });

    it('accepts a folder that contains the Facebook layout', async () => {
      const deps = makeFolderDeps('/export/fb', { 'posts/your_posts_1.json': POSTS_1 });
      expect(await facebookImporter.canHandle('/export/fb', deps)).toBe(true);
      const plain = makeFolderDeps('/export/plain', { 'a.json': '{}' });
      expect(await facebookImporter.canHandle('/export/plain', plain)).toBe(false);
    });
  });

  describe('full import over the export zip', () => {
    it('emits the expected record count and reports both malformed entries (AC-15)', async () => {
      const { records, result, skips } = await run(ZIP, makeZipDeps(FULL_ENTRIES).deps);

      expect(records).toHaveLength(10);
      expect(result.recordCount).toBe(10);
      expect(records.every((r) => r.sourceType === 'facebook')).toBe(true);
      // The garbage array entry AND the wholly malformed file are both reported,
      // and the run still produced every good record (never aborted).
      expect(skips.filter((s) => s.code === 'E_PARSE')).toHaveLength(2);
      expect(result.skipped.filter((s) => s.code === 'E_PARSE')).toHaveLength(2);
    });

    it('recovers post text faithfully (mojibake fixed) with the post timestamp in SECONDS', async () => {
      const { records } = await run(ZIP, makeZipDeps(FULL_ENTRIES).deps);
      const post0 = records.find((r) => r.body === POST0_TEXT);

      expect(post0).toBeDefined();
      expect(post0?.mediaType).toBe('message');
      expect(post0?.originalPath).toBeNull();
      expect(post0?.author).toBeNull();
      expect(post0?.date?.source).toBe('message');
      // FB post timestamps are Unix SECONDS → ×1000.
      expect(post0?.date?.value.getTime()).toBe(1672531200 * 1000);
    });

    it('links a post photo attachment to its extracted file with its own caption + creation time', async () => {
      const { records } = await run(ZIP, makeZipDeps(FULL_ENTRIES).deps);
      const photo = records.find((r) => ps(r.originalPath).endsWith('posts/media/playa.jpg'));

      expect(photo?.mediaType).toBe('photo');
      expect(photo?.mimeType).toBe('image/jpeg');
      expect(photo?.originalPath).toBe(join(WORK, 'posts/media/playa.jpg'));
      expect(photo?.body).toBe('Atardecer en la costa');
      // The media's own creation_timestamp (seconds) wins over the post time.
      expect(photo?.date?.value.getTime()).toBe(1659312000 * 1000);
    });

    it('keeps a text post and its separate photo as two records (no text or media lost)', async () => {
      const { records } = await run(ZIP, makeZipDeps(FULL_ENTRIES).deps);
      const text = records.find((r) => r.body === POST1_TEXT);
      const photo = records.find((r) => ps(r.originalPath).endsWith('posts/media/playa.jpg'));

      expect(text?.mediaType).toBe('message');
      expect(text?.date?.value.getTime()).toBe(1659315600 * 1000);
      expect(photo).toBeDefined();
    });

    it('links a photo-only post (no body) to its media file', async () => {
      const { records } = await run(ZIP, makeZipDeps(FULL_ENTRIES).deps);
      const photo = records.find((r) => ps(r.originalPath).endsWith('posts/media/familia.png'));

      expect(photo?.mediaType).toBe('photo');
      expect(photo?.mimeType).toBe('image/png');
      expect(photo?.body).toBeNull();
    });

    it('maps a message with sender + content + the timestamp in MILLISECONDS', async () => {
      const { records } = await run(ZIP, makeZipDeps(FULL_ENTRIES).deps);
      const m0 = records.find((r) => r.body === MSG0_TEXT);

      expect(m0?.mediaType).toBe('message');
      expect(m0?.author).toBe('José García');
      // FB message timestamps are already Unix MILLISECONDS — used verbatim.
      expect(m0?.date?.value.getTime()).toBe(1672617600000);
    });

    it('links a message photo to its extracted file, carrying the sender', async () => {
      const { records } = await run(ZIP, makeZipDeps(FULL_ENTRIES).deps);
      const text = records.find((r) => r.body === MSG1_TEXT);
      const photo = records.find((r) =>
        ps(r.originalPath).endsWith('messages/inbox/jose_abc/photos/pic.jpg'),
      );

      expect(text?.author).toBe('Me');
      expect(photo?.mediaType).toBe('photo');
      expect(photo?.author).toBe('Me');
      expect(photo?.originalPath).toBe(join(WORK, 'messages/inbox/jose_abc/photos/pic.jpg'));
      expect(photo?.date?.value.getTime()).toBe(1672617660000);
    });

    it('KEEPS a contentless message (no text, no media) — never silently dropped', async () => {
      const { records } = await run(ZIP, makeZipDeps(FULL_ENTRIES).deps);
      const empties = records.filter(
        (r) => r.mediaType === 'message' && r.author === 'José García' && r.body === null,
      );
      // The third message has neither content nor media; it must still be catalogued.
      expect(empties).toHaveLength(1);
      expect(empties[0]?.date?.value.getTime()).toBe(1672617720000);
    });

    it('catalogs standalone album photos with their captions + capture seconds', async () => {
      const { records } = await run(ZIP, makeZipDeps(FULL_ENTRIES).deps);
      const abuela = records.find((r) => ps(r.originalPath).endsWith('album/media/abuela.jpg'));
      const perro = records.find((r) => ps(r.originalPath).endsWith('album/media/perro.jpg'));

      expect(abuela?.mediaType).toBe('photo');
      expect(abuela?.body).toBe('Mi abuela 👵');
      expect(abuela?.date?.value.getTime()).toBe(1659000000 * 1000);
      expect(perro?.mediaType).toBe('photo');
      expect(perro?.body).toBeNull();
    });
  });

  describe('folder import (extracted in place)', () => {
    it('produces the same records reading the JSON + media in place', async () => {
      const root = '/export/fb';
      const deps = makeFolderDeps(root, {
        'posts/your_posts_1.json': POSTS_1,
        'posts/media/playa.jpg': 'jpeg-bytes',
        'posts/media/familia.png': 'png-bytes',
      });
      const { records } = await run(root, deps);

      const post0 = records.find((r) => r.body === POST0_TEXT);
      const photo = records.find((r) => ps(r.originalPath).endsWith('posts/media/playa.jpg'));
      expect(post0).toBeDefined();
      expect(photo?.originalPath).toBe(join(root, 'posts/media/playa.jpg'));
    });
  });

  describe('resilience — reported, never thrown (AC-15)', () => {
    it('reports E_EXTRACT and completes when extractArchive throws (corrupt/locked zip)', async () => {
      const { deps } = makeZipDeps([]);
      deps.extractArchive = () => Promise.reject(new Error('EBUSY: archive is locked'));

      const { records, result, skips } = await run('/drop/corrupt.zip', deps);

      expect(records).toEqual([]);
      expect(result.recordCount).toBe(0);
      expect(result.skipped.some((s) => s.code === 'E_EXTRACT')).toBe(true);
      expect(skips.some((s) => s.code === 'E_EXTRACT')).toBe(true);
    });

    it('skips an unreadable JSON file and keeps every other source intact', async () => {
      const { deps } = makeZipDeps(FULL_ENTRIES);
      const realReadFile = deps.fs.readFile;
      deps.fs.readFile = (path: string) =>
        ps(path).endsWith('photos_and_videos/album/0.json')
          ? Promise.reject(new Error('EACCES: permission denied'))
          : realReadFile(path);

      const { records, result, skips } = await run(ZIP, deps);

      // The 2 album records are gone; posts (4) + messages (4) remain.
      expect(records).toHaveLength(8);
      expect(result.skipped.some((s) => s.code === 'E_READ')).toBe(true);
      expect(skips.some((s) => s.code === 'E_READ')).toBe(true);
    });

    it('reports E_MISSING_MEDIA for a referenced photo absent from the export, keeping the post text', async () => {
      // Same posts file, but the playa.jpg / familia.png media are NOT extracted.
      const entries: ArchiveEntry[] = [{ entryPath: 'posts/your_posts_1.json', content: POSTS_1 }];
      const { records, skips } = await run(ZIP, makeZipDeps(entries).deps);

      expect(skips.some((s) => s.code === 'E_MISSING_MEDIA')).toBe(true);
      // The post bodies are still catalogued even though their media is missing.
      expect(records.find((r) => r.body === POST0_TEXT)).toBeDefined();
      expect(records.find((r) => r.body === POST1_TEXT)).toBeDefined();
    });
  });

  describe('cancellation & progress', () => {
    it('honors a pre-aborted signal — emits nothing, never extracts', async () => {
      const controller = new AbortController();
      controller.abort();
      const { deps, extractCalls } = makeZipDeps(FULL_ENTRIES);
      const { records, result } = await run(ZIP, deps, controller.signal);

      expect(records).toEqual([]);
      expect(result.recordCount).toBe(0);
      expect(extractCalls).toEqual([]);
    });

    it('stops emitting once the signal aborts mid-stream', async () => {
      const controller = new AbortController();
      const c = makeContext(makeZipDeps(FULL_ENTRIES).deps, controller.signal);
      const gen = facebookImporter.import(ZIP, c.ctx);

      const first = await gen.next();
      expect(first.done).toBe(false);
      controller.abort();
      let steps = 0;
      let next = await gen.next();
      while (!next.done && steps < 100) {
        next = await gen.next();
        steps += 1;
      }
      expect(next.done).toBe(true);
      if (next.done) {
        // A partial result: at least the first record, fewer than the full 10.
        expect(next.value.recordCount).toBeGreaterThanOrEqual(1);
        expect(next.value.recordCount).toBeLessThan(10);
      }
    });

    it('emits a discover update and one emit update per record', async () => {
      const { progress, records } = await run(ZIP, makeZipDeps(FULL_ENTRIES).deps);
      expect(progress[0]?.phase).toBe('discover');
      expect(progress.filter((p) => p.phase === 'emit')).toHaveLength(records.length);
    });
  });
});
