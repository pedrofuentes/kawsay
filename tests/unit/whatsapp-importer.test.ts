import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drainImporter } from '../../electron/main/importers/drain';
import { whatsappImporter } from '../../electron/main/importers/whatsapp-importer';
import type {
  CatalogRecord,
  FileStat,
  FsLike,
  ImportContext,
  ImporterDeps,
  ImportProgress,
  ImportResult,
  MediaInfo,
  SkippedItem,
} from '../../electron/main/importers/types';

// Realistic export logs live as reviewable fixtures; the mock deps feed their
// text through the importer exactly as the guarded extractor / fs would in prod.
function fixture(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../fixtures/whatsapp/${name}`, import.meta.url)),
    'utf8',
  );
}
const IOS_CHAT = fixture('ios_chat.txt');
const ANDROID_CHAT = fixture('android_chat.txt');

const WORK = '/work/whatsapp';

interface ArchiveEntry {
  entryPath: string;
  content?: string;
}
interface ProbeSpec {
  durationSec?: number | null;
  width?: number | null;
  height?: number | null;
  mimeType?: string | null;
}

// A zip-backed deps double: `extractArchive` returns the fixture entries (absPath
// under the scratch workDir) and registers their bytes so the importer's
// `fs.readFile` of `_chat.txt` resolves — mirroring the real C2 SafeExtractFn.
function makeZipDeps(
  entries: readonly ArchiveEntry[],
  probes: Record<string, ProbeSpec> = {},
): { deps: ImporterDeps; probeCalls: string[]; extractCalls: string[] } {
  const contentByAbs = new Map<string, string>();
  const probeByBase = new Map(Object.entries(probes));
  const probeCalls: string[] = [];
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
    async probeMedia(path: string): Promise<MediaInfo> {
      probeCalls.push(path);
      const spec = probeByBase.get(basename(path));
      return {
        durationSec: spec?.durationSec ?? null,
        width: spec?.width ?? null,
        height: spec?.height ?? null,
        mimeType: spec?.mimeType ?? null,
      };
    },
    hashFile: async () => 'deadbeef',
  };
  return { deps, probeCalls, extractCalls };
}

// A flat in-memory folder (a WhatsApp export extracted in place by the user).
function makeFolderDeps(root: string, files: Record<string, string>): ImporterDeps {
  const fileMap = new Map<string, string>();
  for (const [name, content] of Object.entries(files)) {
    fileMap.set(join(root, name), content);
  }
  const fs: FsLike = {
    async readFile(path: string): Promise<Buffer> {
      const text = fileMap.get(path);
      if (text === undefined) throw new Error(`ENOENT readFile ${path}`);
      return Buffer.from(text, 'utf8');
    },
    async readDir(path: string): Promise<readonly string[]> {
      if (path !== root) throw new Error(`ENOENT readDir ${path}`);
      return Object.keys(files);
    },
    async stat(path: string): Promise<FileStat> {
      if (path === root) {
        return { size: 0, mtimeMs: 0, isFile: () => false, isDirectory: () => true };
      }
      if (fileMap.has(path)) {
        return { size: 0, mtimeMs: 0, isFile: () => true, isDirectory: () => false };
      }
      throw new Error(`ENOENT stat ${path}`);
    },
    async exists(path: string): Promise<boolean> {
      return path === root || fileMap.has(path);
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
    sourceId: 'src-whatsapp',
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
  byRef: Map<string, CatalogRecord>;
  result: ImportResult;
  skips: SkippedItem[];
  progress: Partial<ImportProgress>[];
}> {
  const c = makeContext(deps, signal);
  const records: CatalogRecord[] = [];
  const result = await drainImporter(whatsappImporter, inputPath, c.ctx, (r) => records.push(r));
  return {
    records,
    byRef: new Map(records.map((r) => [r.sourceRef, r])),
    result,
    skips: c.skips,
    progress: c.progress,
  };
}

function utc(y: number, mo: number, d: number, h: number, mi: number, s = 0): number {
  return Date.UTC(y, mo, d, h, mi, s);
}

describe('whatsappImporter (card C3 — WhatsApp "Export Chat" importer, AC-1)', () => {
  it('identifies itself as the whatsapp source', () => {
    expect(whatsappImporter.id).toBe('whatsapp');
    expect(whatsappImporter.displayName).toBeTypeOf('string');
    expect(whatsappImporter.displayName.length).toBeGreaterThan(0);
  });

  describe('canHandle', () => {
    it('accepts a .zip whose bytes carry the _chat.txt marker', async () => {
      const deps = makeZipDeps([]).deps;
      // The zip central directory stores entry names verbatim — the marker check
      // reads the dropped file's bytes (no extraction needed).
      (deps.fs as unknown as { readFile: (p: string) => Promise<Buffer> }).readFile = async () =>
        Buffer.from('PK\u0003\u0004........_chat.txt........IMG_1.jpg');
      expect(await whatsappImporter.canHandle('/drop/WhatsApp Chat - Family.zip', deps)).toBe(true);
    });

    it('rejects a .zip without the _chat.txt marker', async () => {
      const deps = makeZipDeps([]).deps;
      (deps.fs as unknown as { readFile: (p: string) => Promise<Buffer> }).readFile = async () =>
        Buffer.from('PK\u0003\u0004 some other archive Takeout/index.html');
      expect(await whatsappImporter.canHandle('/drop/Takeout.zip', deps)).toBe(false);
    });

    it('accepts a folder that contains _chat.txt and rejects one that does not', async () => {
      const withChat = makeFolderDeps('/export/wa', { '_chat.txt': IOS_CHAT, 'IMG_1234.jpg': '' });
      expect(await whatsappImporter.canHandle('/export/wa', withChat)).toBe(true);

      const withoutChat = makeFolderDeps('/export/plain', { 'a.jpg': '', 'b.png': '' });
      expect(await whatsappImporter.canHandle('/export/plain', withoutChat)).toBe(false);
    });
  });

  describe('iOS export (bracketed timestamps, <attached: …>)', () => {
    const ENTRIES: ArchiveEntry[] = [
      { entryPath: '_chat.txt', content: IOS_CHAT },
      { entryPath: 'IMG_1234.jpg', content: 'jpeg-bytes' },
      { entryPath: 'PTT-20231230-WA0001.opus', content: 'opus-bytes' },
      { entryPath: 'VID_5678.mp4', content: 'mp4-bytes' },
      { entryPath: 'report.pdf', content: 'pdf-bytes' },
      // NOTE: MISSING_9999.jpg is referenced by the chat but absent from the zip.
    ];
    const PROBES: Record<string, ProbeSpec> = {
      'PTT-20231230-WA0001.opus': { durationSec: 5 },
      'VID_5678.mp4': { durationSec: 12, width: 1920, height: 1080, mimeType: 'video/mp4' },
    };
    const ZIP = '/drop/WhatsApp Chat - Family.zip';

    it('emits a record per message/attachment and skips the one missing attachment (AC-15)', async () => {
      const { records, byRef, result, skips } = await run(ZIP, makeZipDeps(ENTRIES, PROBES).deps);

      expect(records).toHaveLength(7);
      expect(result.recordCount).toBe(7);
      expect(records.every((r) => r.sourceType === 'whatsapp')).toBe(true);
      expect([...byRef.keys()]).toEqual([
        'msg:0',
        'msg:1',
        'att:IMG_1234.jpg',
        'msg:3',
        'att:PTT-20231230-WA0001.opus',
        'att:VID_5678.mp4',
        'att:report.pdf',
      ]);

      expect(result.skipped).toHaveLength(1);
      expect(result.skipped[0]?.ref).toBe('MISSING_9999.jpg');
      expect(result.skipped[0]?.code).toBe('E_MISSING_ATTACHMENT');
      expect(skips.map((s) => s.ref)).toEqual(['MISSING_9999.jpg']);
    });

    it('maps sender, message timestamp (source: message) and body for a text message', async () => {
      const { byRef } = await run(ZIP, makeZipDeps(ENTRIES, PROBES).deps);
      const text = byRef.get('msg:1');

      expect(text?.mediaType).toBe('message');
      expect(text?.author).toBe('John');
      expect(text?.body).toBe('Hello there!');
      expect(text?.originalPath).toBeNull();
      expect(text?.mimeType).toBeNull();
      expect(text?.date?.source).toBe('message');
      expect(text?.date?.value.getTime()).toBe(utc(2023, 11, 30, 14, 30, 0));
      expect(text?.sourceMeta).toMatchObject({
        chatName: 'Family',
        platform: 'ios',
        system: false,
      });
      expect(text?.sourceMeta.rawTimestamp).toBeTypeOf('string');
    });

    it('classifies a photo attachment and points originalPath at the extracted file', async () => {
      const { byRef } = await run(ZIP, makeZipDeps(ENTRIES, PROBES).deps);
      const photo = byRef.get('att:IMG_1234.jpg');

      expect(photo?.mediaType).toBe('photo');
      expect(photo?.author).toBe('Jane');
      expect(photo?.originalPath).toBe(join(WORK, 'IMG_1234.jpg'));
      expect(photo?.mimeType).toBe('image/jpeg');
      expect(photo?.durationSec).toBeNull();
      expect(photo?.date?.value.getTime()).toBe(utc(2023, 11, 30, 14, 30, 12));
      expect(photo?.sourceMeta).toMatchObject({ attachmentFileName: 'IMG_1234.jpg' });
    });

    it('classifies a .opus voice note as audio and reads its duration via probeMedia', async () => {
      const { deps, probeCalls } = makeZipDeps(ENTRIES, PROBES);
      const { byRef } = await run(ZIP, deps);
      const voice = byRef.get('att:PTT-20231230-WA0001.opus');

      expect(voice?.mediaType).toBe('audio');
      expect(voice?.durationSec).toBe(5);
      expect(voice?.author).toBe('Jane');
      expect(probeCalls).toContain(join(WORK, 'PTT-20231230-WA0001.opus'));
    });

    it('classifies video (with probed duration) and document attachments', async () => {
      const { byRef } = await run(ZIP, makeZipDeps(ENTRIES, PROBES).deps);

      const video = byRef.get('att:VID_5678.mp4');
      expect(video?.mediaType).toBe('video');
      expect(video?.durationSec).toBe(12);
      expect(video?.mimeType).toBe('video/mp4');

      const doc = byRef.get('att:report.pdf');
      expect(doc?.mediaType).toBe('document');
      expect(doc?.mimeType).toBe('application/pdf');
      expect(doc?.durationSec).toBeNull();
    });

    it('joins multi-line message continuations into one body', async () => {
      const { byRef } = await run(ZIP, makeZipDeps(ENTRIES, PROBES).deps);
      expect(byRef.get('msg:3')?.body).toBe('This is line one\nthat wraps to line two');
    });

    it('marks the end-to-end-encryption system notice (author null, system flag)', async () => {
      const { byRef } = await run(ZIP, makeZipDeps(ENTRIES, PROBES).deps);
      const sys = byRef.get('msg:0');

      expect(sys?.mediaType).toBe('message');
      expect(sys?.author).toBeNull();
      expect(sys?.body).toContain('end-to-end encrypted');
      expect(sys?.sourceMeta).toMatchObject({ system: true });
    });

    it('strips a leading direction mark (LRM) before the attachment marker', async () => {
      const chat = '[30/12/2023, 14:30:12] Jane: \u200E<attached: IMG_1234.jpg>\n';
      const deps = makeZipDeps([
        { entryPath: '_chat.txt', content: chat },
        { entryPath: 'IMG_1234.jpg', content: 'jpeg' },
      ]).deps;
      const { byRef } = await run('/drop/chat.zip', deps);

      expect(byRef.get('att:IMG_1234.jpg')?.mediaType).toBe('photo');
      expect(byRef.get('att:IMG_1234.jpg')?.author).toBe('Jane');
    });
  });

  describe('Android export (bare timestamps, "(file attached)", <Media omitted>)', () => {
    const ENTRIES: ArchiveEntry[] = [
      { entryPath: '_chat.txt', content: ANDROID_CHAT },
      { entryPath: 'IMG-20231230-WA0003.jpg', content: 'jpeg-bytes' },
    ];
    const ZIP = '/drop/WhatsApp Chat - Familia.zip';

    it('parses the "(file attached)" attachment form and the bare timestamp', async () => {
      const { byRef, result, skips } = await run(ZIP, makeZipDeps(ENTRIES).deps);
      const photo = byRef.get('att:IMG-20231230-WA0003.jpg');

      expect(photo?.mediaType).toBe('photo');
      expect(photo?.author).toBe('Jane');
      expect(photo?.originalPath).toBe(join(WORK, 'IMG-20231230-WA0003.jpg'));
      expect(photo?.date?.value.getTime()).toBe(utc(2023, 11, 30, 14, 31, 0));
      expect(photo?.sourceMeta).toMatchObject({ platform: 'android' });
      expect(result.skipped).toHaveLength(0);
      expect(skips).toHaveLength(0);
    });

    it('keeps a <Media omitted> note as a text message (not a skip)', async () => {
      const { byRef, skips } = await run(ZIP, makeZipDeps(ENTRIES).deps);
      const omitted = byRef.get('msg:2');

      expect(omitted?.mediaType).toBe('message');
      expect(omitted?.originalPath).toBeNull();
      expect(omitted?.body).toContain('Media omitted');
      expect(omitted?.sourceMeta).toMatchObject({ mediaOmitted: true });
      expect(skips).toHaveLength(0);
    });

    it('marks the group-creation system event (author null)', async () => {
      const { byRef } = await run(ZIP, makeZipDeps(ENTRIES).deps);
      const sys = byRef.get('msg:3');

      expect(sys?.author).toBeNull();
      expect(sys?.body).toContain('created group');
      expect(sys?.sourceMeta).toMatchObject({ system: true });
    });

    it('maps the first text message', async () => {
      const { byRef } = await run(ZIP, makeZipDeps(ENTRIES).deps);
      expect(byRef.get('msg:0')?.author).toBe('John');
      expect(byRef.get('msg:0')?.body).toBe('Hey from Android');
    });
  });

  describe('timestamp parsing', () => {
    function zipWith(chat: string): ImporterDeps {
      return makeZipDeps([{ entryPath: '_chat.txt', content: chat }]).deps;
    }

    it('handles 12-hour AM/PM times', async () => {
      const chat = '01/06/2022, 2:05 PM - John: afternoon\n01/06/2022, 12:30 AM - John: midnight\n';
      const { byRef } = await run('/drop/c.zip', zipWith(chat));

      expect(byRef.get('msg:0')?.date?.value.getTime()).toBe(utc(2022, 5, 1, 14, 5, 0));
      expect(byRef.get('msg:1')?.date?.value.getTime()).toBe(utc(2022, 5, 1, 0, 30, 0));
    });

    it('infers day-first order from a day value greater than 12', async () => {
      const chat = '25/12/2023, 10:00 - A: x\n05/01/2023, 11:00 - A: y\n';
      const { byRef } = await run('/drop/c.zip', zipWith(chat));
      expect(byRef.get('msg:1')?.date?.value.getTime()).toBe(utc(2023, 0, 5, 11, 0, 0));
    });

    it('infers month-first order from a second value greater than 12', async () => {
      const chat = '12/25/2023, 10:00 - A: x\n01/05/2023, 11:00 - A: y\n';
      const { byRef } = await run('/drop/c.zip', zipWith(chat));
      expect(byRef.get('msg:1')?.date?.value.getTime()).toBe(utc(2023, 0, 5, 11, 0, 0));
    });
  });

  describe('folder import (extracted in place)', () => {
    it('reads _chat.txt in place and references the attachment by its folder path', async () => {
      const root = '/export/wa';
      const deps = makeFolderDeps(root, {
        '_chat.txt': ANDROID_CHAT,
        'IMG-20231230-WA0003.jpg': 'jpeg-bytes',
      });
      const { byRef, result } = await run(root, deps);

      expect(byRef.get('att:IMG-20231230-WA0003.jpg')?.originalPath).toBe(
        join(root, 'IMG-20231230-WA0003.jpg'),
      );
      expect(byRef.get('att:IMG-20231230-WA0003.jpg')?.mediaType).toBe('photo');
      expect(result.skipped).toHaveLength(0);
    });
  });

  describe('cancellation & progress', () => {
    const ENTRIES: ArchiveEntry[] = [
      { entryPath: '_chat.txt', content: ANDROID_CHAT },
      { entryPath: 'IMG-20231230-WA0003.jpg', content: 'jpeg' },
    ];

    it('honors a pre-aborted signal — emits nothing, never extracts', async () => {
      const controller = new AbortController();
      controller.abort();
      const { deps, extractCalls } = makeZipDeps(ENTRIES);
      const { records, result } = await run('/drop/c.zip', deps, controller.signal);

      expect(records).toEqual([]);
      expect(result.recordCount).toBe(0);
      expect(extractCalls).toEqual([]);
    });

    it('stops emitting once the signal aborts mid-stream', async () => {
      const controller = new AbortController();
      const c = makeContext(makeZipDeps(ENTRIES).deps, controller.signal);
      const gen = whatsappImporter.import('/drop/c.zip', c.ctx);

      const first = await gen.next();
      expect(first.done).toBe(false);
      controller.abort();
      const next = await gen.next();

      expect(next.done).toBe(true);
      if (next.done) {
        expect(next.value.recordCount).toBe(1);
      }
    });

    it('emits a discover update and one emit update per record', async () => {
      const { progress } = await run('/drop/c.zip', makeZipDeps(ENTRIES).deps);

      expect(progress[0]?.phase).toBe('discover');
      const emits = progress.filter((p) => p.phase === 'emit');
      expect(emits.length).toBe(4);
      expect(emits.at(-1)?.processed).toBe(4);
    });
  });
});
