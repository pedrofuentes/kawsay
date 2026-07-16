import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drainImporter } from '../../electron/main/importers/drain';
import {
  decodeFacebookText,
  facebookImporter,
} from '../../electron/main/importers/facebook-importer';
import { toIsoUtc } from '../../electron/main/db/catalog-repo';
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
import { buildZip } from '../helpers/zip';
import { makeTmpDir, removeTmpDir } from '../helpers/tmp';

// The Facebook "Download Your Information" export ships as a zip of JSON files
// where every non-ASCII string is mojibake — each UTF-8 byte escaped as its own
// \u00XX code unit. The fixtures below are byte-faithful captures of that quirk
// (generated from real UTF-8: accents, an emoji, and a Cyrillic name), so these
// tests prove the importer recovers the true text (AC-16) rather than storing
// garbled names/messages in a memorial archive.
function fbFixture(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../fixtures/facebook/${rel}`, import.meta.url)),
    'utf8',
  );
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

    it('leaves genuine multibyte / Latin-1-range text untouched and is idempotent (report finding 3)', () => {
      // Report sentinel-pr64-a1f1b5a-c5 finding 3 PROVED this guard cannot
      // double-decode conformant exports: FB DYI byte-escapes EVERY non-ASCII
      // character, so a real ©/é/emoji never arrives as raw multibyte bytes.
      // Ratchet that proven-safe behaviour (a genuine `©` = U+00A9 included) so
      // a future change to decodeFacebookText cannot silently regress it.
      for (const s of ['José', 'Schön', 'café ☕', 'Жанна', '日本語', '😀', '©', 'plain', '']) {
        const once = decodeFacebookText(s);
        expect(once).toBe(s); // genuine text passes through byte-for-byte
        expect(decodeFacebookText(once)).toBe(once); // second pass == first (idempotent)
      }
    });
  });

  describe('canHandle discriminates Facebook from LinkedIn and unknown zips', () => {
    it('accepts a zip whose central directory carries Facebook markers', async () => {
      const dir = makeTmpDir('fb-can-handle-');
      const archive = join(dir, 'fb.zip');
      writeFileSync(archive, buildZip([{ name: 'messages/inbox/thread/message_1.json' }]));
      const deps = makeZipDeps([]).deps;
      deps.fs.readFile = async () => {
        throw new Error('canHandle must not materialize zip bytes');
      };
      try {
        expect(await facebookImporter.canHandle(archive, deps)).toBe(true);
      } finally {
        removeTmpDir(dir);
      }
    });

    it('rejects a LinkedIn zip and an unrelated zip', async () => {
      const dir = makeTmpDir('fb-negative-can-handle-');
      const linkedinArchive = join(dir, 'linkedin.zip');
      const unrelatedArchive = join(dir, 'unrelated.zip');
      writeFileSync(linkedinArchive, buildZip([{ name: 'Connections.csv' }]));
      writeFileSync(unrelatedArchive, buildZip([{ name: 'Takeout/index.html' }]));
      try {
        expect(await facebookImporter.canHandle(linkedinArchive, makeZipDeps([]).deps)).toBe(false);
        expect(await facebookImporter.canHandle(unrelatedArchive, makeZipDeps([]).deps)).toBe(
          false,
        );
      } finally {
        removeTmpDir(dir);
      }
    });

    it('accepts a folder that contains the Facebook layout', async () => {
      const deps = makeFolderDeps('/export/fb', { 'posts/your_posts_1.json': POSTS_1 });
      expect(await facebookImporter.canHandle('/export/fb', deps)).toBe(true);
      const plain = makeFolderDeps('/export/plain', { 'a.json': '{}' });
      expect(await facebookImporter.canHandle('/export/plain', plain)).toBe(false);
    });
  });

  describe('full import over the export zip', () => {
    it('yields early records before processing later malformed entries in the same file', async () => {
      const content = JSON.stringify([{ data: [{ post: 'first' }], timestamp: 1 }, 'BADROW']);
      const c = makeContext(makeZipDeps([{ entryPath: 'posts/your_posts_1.json', content }]).deps);
      const iterator = facebookImporter.import(ZIP, c.ctx);

      const first = await iterator.next();

      expect(first.done).toBe(false);
      if (first.done) throw new Error('expected first Facebook record');
      expect(first.value.body).toBe('first');
      expect(c.skips).toEqual([]);
      await iterator.return?.({ recordCount: 1, skipped: [] });
    });

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

  describe('out-of-range timestamps — never emit an Invalid Date that aborts ingest (AC-15)', () => {
    // The downstream ingest consumer renders every record's date through
    // catalog-repo `toIsoUtc` → `Date.prototype.toISOString()`, which throws
    // `RangeError: Invalid time value` on an Invalid Date. With no per-record
    // catch in the ingest drain loop, that single throw aborts the whole import
    // and drops every not-yet-persisted memory — the exact WhatsApp data-loss
    // class AC-15 exists to prevent. A finite-but-out-of-range FB timestamp
    // (`asFiniteNumber` lets it through) must therefore yield a record kept with
    // `date: null`, never an Invalid Date pushed across the importer boundary.
    const OUT_OF_RANGE = 1e16; // finite, but new Date(1e16[ ms ]) / *1000 overflows → Invalid Date

    it('keeps a post with an out-of-range SECONDS timestamp as date:null, preserving other posts', async () => {
      const content = JSON.stringify([
        { timestamp: 1672531200, data: [{ post: 'good post' }] },
        { timestamp: OUT_OF_RANGE, data: [{ post: 'bad timestamp post' }] },
      ]);
      const entries: ArchiveEntry[] = [{ entryPath: 'posts/your_posts_1.json', content }];

      const { records, result, skips } = await run(ZIP, makeZipDeps(entries).deps);

      // The good post keeps its valid date; the out-of-range post is still
      // catalogued (never silently dropped) but with NO date.
      expect(records).toHaveLength(2);
      const good = records.find((r) => r.body === 'good post');
      const bad = records.find((r) => r.body === 'bad timestamp post');
      expect(good?.date?.value.getTime()).toBe(1672531200 * 1000);
      expect(bad).toBeDefined();
      expect(bad?.date).toBeNull();
      // The run completed (no abort, nothing skipped) and EVERY emitted date is
      // safe to render — the downstream toIsoUtc never sees an Invalid Date.
      expect(result.recordCount).toBe(2);
      expect(skips).toHaveLength(0);
      for (const r of records) {
        const d = r.date;
        if (d) expect(() => toIsoUtc(d.value)).not.toThrow();
      }
    });

    it('keeps a message with an out-of-range MILLISECONDS timestamp as date:null, preserving other messages', async () => {
      const content = JSON.stringify({
        participants: [{ name: 'Ana' }],
        messages: [
          { sender_name: 'Ana', timestamp_ms: 1672617600000, content: 'good message' },
          { sender_name: 'Ana', timestamp_ms: OUT_OF_RANGE, content: 'bad timestamp message' },
        ],
      });
      const entries: ArchiveEntry[] = [
        { entryPath: 'messages/inbox/ana_xyz/message_1.json', content },
      ];

      const { records, result, skips } = await run(ZIP, makeZipDeps(entries).deps);

      expect(records).toHaveLength(2);
      const good = records.find((r) => r.body === 'good message');
      const bad = records.find((r) => r.body === 'bad timestamp message');
      expect(good?.date?.value.getTime()).toBe(1672617600000);
      expect(bad).toBeDefined();
      expect(bad?.date).toBeNull();
      expect(result.recordCount).toBe(2);
      expect(skips).toHaveLength(0);
      for (const r of records) {
        const d = r.date;
        if (d) expect(() => toIsoUtc(d.value)).not.toThrow();
      }
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

    it('stops before starting the next file in the same stage once aborted after a single-record file completes', async () => {
      // Each thread yields exactly one record, so the abort (raised while
      // emitting file A's lone record) is only observed once the outer
      // per-file loop is about to move on to file B — never mid-stream
      // within a single file's own record loop.
      const controller = new AbortController();
      const entries: ArchiveEntry[] = [
        {
          entryPath: 'messages/inbox/alpha_thread/message_1.json',
          content: JSON.stringify({
            participants: [{ name: 'A' }],
            messages: [{ sender_name: 'A', timestamp_ms: 1, content: 'alpha' }],
          }),
        },
        {
          entryPath: 'messages/inbox/zeta_thread/message_1.json',
          content: JSON.stringify({
            participants: [{ name: 'Z' }],
            messages: [{ sender_name: 'Z', timestamp_ms: 1, content: 'zeta' }],
          }),
        },
      ];
      const deps = makeZipDeps(entries).deps;
      const ctx: ImportContext = {
        sourceId: 'src-facebook',
        workDir: WORK,
        signal: controller.signal,
        deps,
        onSkip: () => {},
        onProgress: (update) => {
          if (update.phase === 'emit' && update.processed === 1) controller.abort();
        },
      };
      const records: CatalogRecord[] = [];
      const result = await drainImporter(facebookImporter, ZIP, ctx, (r) => records.push(r));

      expect(records.map((r) => r.body)).toEqual(['alpha']);
      expect(result.recordCount).toBe(1);
    });
  });

  describe('BOM stripping and non-Error failure formatting', () => {
    it('strips a UTF-8 BOM before parsing the posts JSON', async () => {
      const content = '﻿' + JSON.stringify([{ timestamp: 1, data: [{ post: 'bom ok' }] }]);
      const entries: ArchiveEntry[] = [{ entryPath: 'posts/your_posts_1.json', content }];

      const { records, skips } = await run(ZIP, makeZipDeps(entries).deps);

      expect(skips).toEqual([]);
      expect(records.map((r) => r.body)).toEqual(['bom ok']);
    });

    it('formats a thrown non-Error value with String() when reporting E_READ', async () => {
      const { deps } = makeZipDeps(FULL_ENTRIES);
      const realReadFile = deps.fs.readFile;
      deps.fs.readFile = (path: string) =>
        ps(path).endsWith('your_posts_1.json')
          ? Promise.reject('EIO: raw string failure')
          : realReadFile(path);

      const { skips } = await run(ZIP, deps);

      expect(skips).toContainEqual(
        expect.objectContaining({
          code: 'E_READ',
          reason: expect.stringContaining('EIO: raw string failure'),
        }),
      );
    });
  });

  describe('timestamps missing entirely (asFiniteNumber/secondsDate null path)', () => {
    it('keeps a post with no timestamp field at all as date:null', async () => {
      const content = JSON.stringify([{ data: [{ post: 'undated post' }] }]);
      const entries: ArchiveEntry[] = [{ entryPath: 'posts/your_posts_1.json', content }];

      const { records, skips } = await run(ZIP, makeZipDeps(entries).deps);

      expect(skips).toEqual([]);
      expect(records.find((r) => r.body === 'undated post')?.date).toBeNull();
    });
  });

  describe('video/audio media probing (probeSafe)', () => {
    it('probes a video attachment and prefers the probed mimeType/durationSec over the extension fallback', async () => {
      const content = JSON.stringify({
        participants: [{ name: 'Ana' }],
        messages: [
          {
            sender_name: 'Ana',
            timestamp_ms: 1,
            videos: [{ uri: 'messages/inbox/ana_xyz/videos/clip.mp4' }],
          },
        ],
      });
      const entries: ArchiveEntry[] = [
        { entryPath: 'messages/inbox/ana_xyz/message_1.json', content },
        { entryPath: 'messages/inbox/ana_xyz/videos/clip.mp4', content: 'video-bytes' },
      ];
      const { deps } = makeZipDeps(entries);
      deps.probeMedia = async () => ({
        durationSec: 12.5,
        width: 640,
        height: 480,
        mimeType: 'video/mp4; codecs=avc1',
      });

      const { records, skips } = await run(ZIP, deps);

      expect(skips).toEqual([]);
      const video = records.find((r) => r.mediaType === 'video');
      expect(video?.mimeType).toBe('video/mp4; codecs=avc1');
      expect(video?.durationSec).toBe(12.5);
    });

    it('falls back to the extension-derived mime/null duration when probing throws', async () => {
      const content = JSON.stringify({
        participants: [{ name: 'Ana' }],
        messages: [
          {
            sender_name: 'Ana',
            timestamp_ms: 1,
            audio_files: [{ uri: 'messages/inbox/ana_xyz/audio/voice.m4a' }],
          },
        ],
      });
      const entries: ArchiveEntry[] = [
        { entryPath: 'messages/inbox/ana_xyz/message_1.json', content },
        { entryPath: 'messages/inbox/ana_xyz/audio/voice.m4a', content: 'audio-bytes' },
      ];
      const { deps } = makeZipDeps(entries);
      deps.probeMedia = async () => {
        throw new Error('ffprobe not found');
      };

      const { records, skips } = await run(ZIP, deps);

      expect(skips).toEqual([]);
      const audio = records.find((r) => r.mediaType === 'audio');
      expect(audio?.mimeType).toBe('audio/mp4');
      expect(audio?.durationSec).toBeNull();
    });
  });

  describe('media path resolution — suffix matching and ambiguity', () => {
    it('resolves a uri via a unique path suffix that is not a direct or basename match', async () => {
      const content = JSON.stringify([
        {
          timestamp: 1,
          attachments: [
            {
              data: [
                {
                  media: {
                    // References a shorter suffix of the real entry path — not
                    // the full entryPath and not just the basename.
                    uri: 'media/nested/deep.jpg',
                    description: 'suffix match',
                  },
                },
              ],
            },
          ],
        },
      ]);
      const entries: ArchiveEntry[] = [
        { entryPath: 'posts/your_posts_1.json', content },
        { entryPath: 'posts/media/nested/deep.jpg', content: 'jpeg-bytes' },
      ];

      const { records, skips } = await run(ZIP, makeZipDeps(entries).deps);

      expect(skips).toEqual([]);
      const photo = records.find((r) => r.body === 'suffix match');
      expect(ps(photo?.originalPath)).toContain('posts/media/nested/deep.jpg');
    });

    it('reports E_MISSING_MEDIA for an ambiguous suffix shared by two different files', async () => {
      const content = JSON.stringify([
        {
          timestamp: 1,
          attachments: [
            { data: [{ media: { uri: 'nested/dup.jpg', description: 'ambiguous' } }] },
          ],
        },
      ]);
      const entries: ArchiveEntry[] = [
        { entryPath: 'posts/your_posts_1.json', content },
        { entryPath: 'posts/a/nested/dup.jpg', content: 'jpeg-bytes-a' },
        { entryPath: 'posts/b/nested/dup.jpg', content: 'jpeg-bytes-b' },
      ];

      const { records, skips } = await run(ZIP, makeZipDeps(entries).deps);

      expect(records.find((r) => r.body === 'ambiguous')).toBeUndefined();
      expect(skips).toContainEqual(
        expect.objectContaining({ ref: 'nested/dup.jpg', code: 'E_MISSING_MEDIA' }),
      );
    });
  });

  describe('folder discovery failures (walkFolder)', () => {
    it('reports E_READDIR for an unreadable subdirectory but keeps importing the rest', async () => {
      const root = '/export/fb-readdir';
      const deps = makeFolderDeps(root, {
        'posts/your_posts_1.json': POSTS_1,
        'messages/inbox/jose_abc/message_1.json': '{}',
      });
      const badDir = join(root, 'messages', 'inbox');
      const realReadDir = deps.fs.readDir;
      deps.fs.readDir = async (path: string) => {
        if (path === badDir) throw new Error('EACCES: permission denied');
        return await realReadDir(path);
      };

      const { records, skips } = await run(root, deps);

      expect(skips).toContainEqual(expect.objectContaining({ ref: badDir, code: 'E_READDIR' }));
      expect(records.find((r) => r.body === POST0_TEXT)).toBeDefined();
    });

    it('reports E_STAT for an entry that cannot be statted during folder discovery', async () => {
      const root = '/export/fb-stat';
      const deps = makeFolderDeps(root, { 'posts/your_posts_1.json': POSTS_1 });
      const ghost = join(root, 'posts', 'ghost.json');
      const realReadDir = deps.fs.readDir;
      const realStat = deps.fs.stat;
      deps.fs.readDir = async (path: string) => {
        const names = await realReadDir(path);
        return path === join(root, 'posts') ? [...names, 'ghost.json'] : names;
      };
      deps.fs.stat = async (path: string) => {
        if (path === ghost) throw new Error('ENOENT: vanished mid-scan');
        return await realStat(path);
      };

      const { records, skips } = await run(root, deps);

      expect(skips).toContainEqual(expect.objectContaining({ ref: ghost, code: 'E_STAT' }));
      expect(records.find((r) => r.body === POST0_TEXT)).toBeDefined();
    });

    it('stops folder discovery without crashing when the signal aborts mid-walk', async () => {
      const root = '/export/fb-walkabort';
      const deps = makeFolderDeps(root, {
        'posts/your_posts_1.json': POSTS_1,
        'photos_and_videos/album/0.json': ALBUM_0,
      });
      const controller = new AbortController();
      const realReadDir = deps.fs.readDir;
      deps.fs.readDir = async (path: string) => {
        const names = await realReadDir(path);
        if (path === root) controller.abort();
        return names;
      };

      const { records, result } = await run(root, deps, controller.signal);

      expect(result.recordCount).toBe(records.length);
    });
  });

  describe('canHandle over a folder — non-directory path and stat failure', () => {
    it('rejects a plain file path (not a directory)', async () => {
      const root = '/export/fb-file';
      const deps = makeFolderDeps(root, { 'a.txt': 'x' });
      expect(await facebookImporter.canHandle(join(root, 'a.txt'), deps)).toBe(false);
    });

    it('returns false when the path cannot be statted at all', async () => {
      const deps = makeFolderDeps('/export/fb-missing', {});
      expect(await facebookImporter.canHandle('/export/fb-missing/does-not-exist', deps)).toBe(
        false,
      );
    });
  });

  describe('posts file wrapped under a single object key (asPostArray fallback)', () => {
    it('finds the posts array nested under an arbitrary top-level key', async () => {
      const content = JSON.stringify({
        some_export_key: [{ timestamp: 1, data: [{ post: 'wrapped post' }] }],
      });
      const entries: ArchiveEntry[] = [{ entryPath: 'posts/your_posts_1.json', content }];

      const { records, skips } = await run(ZIP, makeZipDeps(entries).deps);

      expect(skips).toEqual([]);
      expect(records.map((r) => r.body)).toEqual(['wrapped post']);
    });

    it('yields nothing (without crashing) when the posts file has no array anywhere', async () => {
      const content = JSON.stringify({ nothing_useful: 'just a string' });
      const entries: ArchiveEntry[] = [{ entryPath: 'posts/your_posts_1.json', content }];

      const { records, skips } = await run(ZIP, makeZipDeps(entries).deps);

      expect(records).toEqual([]);
      expect(skips).toEqual([]);
    });
  });

  describe('malformed array entries filtered by isObject guards', () => {
    it('skips a non-object attachment and still collects media from the top-level data[].media shape', async () => {
      const content = JSON.stringify([
        {
          timestamp: 1,
          attachments: ['not-an-object'],
          data: [{ media: { uri: 'posts/media/direct.jpg', description: 'direct data media' } }],
        },
      ]);
      const entries: ArchiveEntry[] = [
        { entryPath: 'posts/your_posts_1.json', content },
        { entryPath: 'posts/media/direct.jpg', content: 'jpeg-bytes' },
      ];

      const { records, skips } = await run(ZIP, makeZipDeps(entries).deps);

      expect(skips).toEqual([]);
      expect(records.find((r) => r.body === 'direct data media')).toBeDefined();
    });

    it('filters out a non-object participant entry from a message thread', async () => {
      const content = JSON.stringify({
        participants: ['stray-string', { name: 'Ana' }],
        messages: [{ sender_name: 'Ana', timestamp_ms: 1, content: 'hi' }],
      });
      const entries: ArchiveEntry[] = [
        { entryPath: 'messages/inbox/ana_xyz/message_1.json', content },
      ];

      const { records, skips } = await run(ZIP, makeZipDeps(entries).deps);

      expect(skips).toEqual([]);
      expect(records[0]?.sourceMeta).toMatchObject({ participants: ['Ana'] });
    });

    it('links a message sticker as its own media record', async () => {
      const content = JSON.stringify({
        participants: [{ name: 'Ana' }],
        messages: [
          {
            sender_name: 'Ana',
            timestamp_ms: 1,
            sticker: { uri: 'messages/inbox/ana_xyz/stickers/wave.png' },
          },
        ],
      });
      const entries: ArchiveEntry[] = [
        { entryPath: 'messages/inbox/ana_xyz/message_1.json', content },
        { entryPath: 'messages/inbox/ana_xyz/stickers/wave.png', content: 'png-bytes' },
      ];

      const { records, skips } = await run(ZIP, makeZipDeps(entries).deps);

      expect(skips).toEqual([]);
      const sticker = records.find((r) => r.sourceMeta.attachment === 'sticker');
      expect(sticker?.mediaType).toBe('photo');
    });

    it('skips a non-object entry within a message media array', async () => {
      const content = JSON.stringify({
        participants: [{ name: 'Ana' }],
        messages: [
          { sender_name: 'Ana', timestamp_ms: 1, content: 'ok', photos: [null, 'not-an-object'] },
        ],
      });
      const entries: ArchiveEntry[] = [
        { entryPath: 'messages/inbox/ana_xyz/message_1.json', content },
      ];

      const { records, skips } = await run(ZIP, makeZipDeps(entries).deps);

      expect(skips).toEqual([]);
      expect(records.map((r) => r.body)).toEqual(['ok']);
    });

    it('skips a non-object album entry but keeps the rest of the album', async () => {
      const content = JSON.stringify({
        name: 'Mixed album',
        photos: ['not-an-object', { uri: 'photos_and_videos/album/media/ok.jpg' }],
      });
      const entries: ArchiveEntry[] = [
        { entryPath: 'photos_and_videos/album/0.json', content },
        { entryPath: 'photos_and_videos/album/media/ok.jpg', content: 'jpeg-bytes' },
      ];

      const { records, skips } = await run(ZIP, makeZipDeps(entries).deps);

      expect(skips).toContainEqual(
        expect.objectContaining({ ref: 'photos_and_videos/album/0.json#0', code: 'E_PARSE' }),
      );
      expect(records.find((r) => ps(r.originalPath).endsWith('album/media/ok.jpg'))).toBeDefined();
    });

    it('reads a bare-array album file (no wrapping object) directly', async () => {
      const content = JSON.stringify([{ uri: 'photos_and_videos/album/media/bare.jpg' }]);
      const entries: ArchiveEntry[] = [
        { entryPath: 'photos_and_videos/album/0.json', content },
        { entryPath: 'photos_and_videos/album/media/bare.jpg', content: 'jpeg-bytes' },
      ];

      const { records, skips } = await run(ZIP, makeZipDeps(entries).deps);

      expect(skips).toEqual([]);
      expect(records.find((r) => ps(r.originalPath).endsWith('album/media/bare.jpg'))).toBeDefined();
    });

    it('yields nothing (without crashing) for an album file whose top level is neither an array nor an object', async () => {
      const entries: ArchiveEntry[] = [
        { entryPath: 'photos_and_videos/album/0.json', content: JSON.stringify('just a string') },
      ];

      const { records, skips } = await run(ZIP, makeZipDeps(entries).deps);

      expect(records).toEqual([]);
      expect(skips).toEqual([]);
    });

    it('skips a non-object entry in post.data while still collecting text from the valid entries', async () => {
      const content = JSON.stringify([
        { timestamp: 1, data: ['not-an-object', { post: 'valid text' }] },
      ]);
      const entries: ArchiveEntry[] = [{ entryPath: 'posts/your_posts_1.json', content }];

      const { records, skips } = await run(ZIP, makeZipDeps(entries).deps);

      expect(skips).toEqual([]);
      expect(records.map((r) => r.body)).toEqual(['valid text']);
    });

    it('reports E_PARSE when the message thread top level is not an object', async () => {
      const entries: ArchiveEntry[] = [
        {
          entryPath: 'messages/inbox/ana_xyz/message_1.json',
          content: JSON.stringify(['not', 'an', 'object']),
        },
      ];

      const { records, skips } = await run(ZIP, makeZipDeps(entries).deps);

      expect(records).toEqual([]);
      expect(skips).toContainEqual(
        expect.objectContaining({
          ref: 'messages/inbox/ana_xyz/message_1.json',
          code: 'E_PARSE',
          reason: expect.stringContaining('not an object'),
        }),
      );
    });

    it('skips a non-object message entry but keeps the other messages in the thread', async () => {
      const content = JSON.stringify({
        participants: [{ name: 'Ana' }],
        messages: [42, { sender_name: 'Ana', timestamp_ms: 1, content: 'still fine' }],
      });
      const entries: ArchiveEntry[] = [
        { entryPath: 'messages/inbox/ana_xyz/message_1.json', content },
      ];

      const { records, skips } = await run(ZIP, makeZipDeps(entries).deps);

      expect(records.map((r) => r.body)).toEqual(['still fine']);
      expect(skips).toContainEqual(
        expect.objectContaining({
          ref: 'messages/inbox/ana_xyz/message_1.json#0',
          code: 'E_PARSE',
        }),
      );
    });

    it("propagates a message file's unreadable/malformed failure the same way as posts/albums", async () => {
      const { deps } = makeZipDeps(FULL_ENTRIES);
      const realReadFile = deps.fs.readFile;
      deps.fs.readFile = (path: string) =>
        ps(path).endsWith('jose_abc/message_1.json')
          ? Promise.reject(new Error('EACCES: permission denied'))
          : realReadFile(path);

      const { skips } = await run(ZIP, deps);

      expect(skips).toContainEqual(
        expect.objectContaining({
          ref: 'messages/inbox/jose_abc/message_1.json',
          code: 'E_READ',
        }),
      );
    });
  });

  describe('media entry edge cases', () => {
    it('reports E_PARSE for a media object with no uri and an empty/whitespace-only uri', async () => {
      const content = JSON.stringify({
        participants: [{ name: 'Ana' }],
        messages: [{ sender_name: 'Ana', timestamp_ms: 1, photos: [{}, { uri: '   ' }] }],
      });
      const entries: ArchiveEntry[] = [
        { entryPath: 'messages/inbox/ana_xyz/message_1.json', content },
      ];

      const { skips } = await run(ZIP, makeZipDeps(entries).deps);

      expect(skips.filter((s) => s.code === 'E_PARSE')).toHaveLength(2);
    });

    it('classifies an unrecognized media extension with the octet-stream fallback kind', async () => {
      const content = JSON.stringify([
        {
          timestamp: 1,
          attachments: [{ data: [{ media: { uri: 'posts/media/archive.xyz' } }] }],
        },
      ]);
      const entries: ArchiveEntry[] = [
        { entryPath: 'posts/your_posts_1.json', content },
        { entryPath: 'posts/media/archive.xyz', content: 'unknown-bytes' },
      ];

      const { records, skips } = await run(ZIP, makeZipDeps(entries).deps);

      expect(skips).toEqual([]);
      const record = records.find((r) => ps(r.originalPath).endsWith('archive.xyz'));
      expect(record).toMatchObject({ mediaType: 'document', mimeType: 'application/octet-stream' });
    });

    it('degrades an empty-string caption to a null body', async () => {
      const content = JSON.stringify([
        {
          timestamp: 1,
          attachments: [{ data: [{ media: { uri: 'posts/media/playa.jpg', description: '' } }] }],
        },
      ]);
      const entries: ArchiveEntry[] = [
        { entryPath: 'posts/your_posts_1.json', content },
        { entryPath: 'posts/media/playa.jpg', content: 'jpeg-bytes' },
      ];

      const { records, skips } = await run(ZIP, makeZipDeps(entries).deps);

      expect(skips).toEqual([]);
      expect(records.find((r) => r.mediaType === 'photo')?.body).toBeNull();
    });
  });

  describe('folder discovery: recursive sibling abort', () => {
    it('stops a sibling directory walk before it starts once aborted while statting an earlier entry', async () => {
      const root = '/export/fb-siblingabort';
      const deps = makeFolderDeps(root, {
        'messages/inbox/alpha_thread/message_1.json': JSON.stringify({
          participants: [{ name: 'A' }],
          messages: [{ sender_name: 'A', timestamp_ms: 1, content: 'alpha' }],
        }),
        'messages/inbox/zeta_thread/message_1.json': JSON.stringify({
          participants: [{ name: 'Z' }],
          messages: [{ sender_name: 'Z', timestamp_ms: 1, content: 'zeta' }],
        }),
      });
      const controller = new AbortController();
      const alphaDir = join(root, 'messages', 'inbox', 'alpha_thread');
      const realStat = deps.fs.stat;
      deps.fs.stat = async (path: string) => {
        const result = await realStat(path);
        if (path === alphaDir) controller.abort();
        return result;
      };

      const { records } = await run(root, deps, controller.signal);

      expect(records.some((r) => r.body === 'zeta')).toBe(false);
    });
  });
});
