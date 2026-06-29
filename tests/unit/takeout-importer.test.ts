import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { join } from 'node:path';
import { drainImporter } from '../../electron/main/importers/drain';
import { ARCHIVE_ERROR_CODES, ArchiveError } from '../../electron/main/importers/safe-extract';
import {
  findSidecarName,
  sanitizeSegment,
  takeoutImporter,
} from '../../electron/main/importers/takeout-importer';
import type {
  CatalogRecord,
  ExifData,
  FileStat,
  FsLike,
  ImportContext,
  ImporterDeps,
  ImportProgress,
  ImportResult,
  MediaInfo,
  SkippedItem,
} from '../../electron/main/importers/types';
import { buildZip } from '../helpers/zip';
import { makeTmpDir, removeTmpDir } from '../helpers/tmp';

// A fixed, platform-portable root — every fixture path and assertion is built
// with node:path join against it, so the suite is identical on POSIX and Windows
// CI (sourceRef is normalized to forward slashes by the importer).
const ROOT = '/takeout-root';
const WORK = '/work/takeout';

function abs(rel: string): string {
  return rel === '.' ? ROOT : join(ROOT, ...rel.split('/'));
}

interface FileSpec {
  content?: string | Buffer;
  mtimeMs?: number;
}

interface FsOptions {
  statErrors?: string[];
  readDirErrors?: string[];
  readFileErrors?: string[];
  streamErrors?: string[];
}

function fileStat(spec: FileSpec): FileStat {
  const content = spec.content;
  const size =
    content === undefined
      ? 0
      : Buffer.isBuffer(content)
        ? content.length
        : Buffer.byteLength(content);
  return {
    size,
    mtimeMs: spec.mtimeMs ?? 0,
    isFile: () => true,
    isDirectory: () => false,
  };
}

function dirStat(): FileStat {
  return { size: 0, mtimeMs: 0, isFile: () => false, isDirectory: () => true };
}

interface FakeFs {
  fs: FsLike;
  writes: Map<string, Buffer>;
  streamReads: string[];
  readFileReads: string[];
}

// An in-memory FsLike over a fixture tree declared as POSIX-relative paths, with
// the two streaming/write seam methods the Takeout importer needs: openReadStream
// (memory-bounded mbox read, AC-11) and writeFile (materializing an embedded mbox
// attachment into scratch so the worker can hash + content-address it).
function buildFs(files: Record<string, FileSpec>, options: FsOptions = {}): FakeFs {
  const fileMap = new Map<string, FileSpec>();
  const dirChildren = new Map<string, Set<string>>();
  const writes = new Map<string, Buffer>();
  const streamReads: string[] = [];
  const readFileReads: string[] = [];

  const childrenOf = (dir: string): Set<string> => {
    const existing = dirChildren.get(dir);
    if (existing) return existing;
    const created = new Set<string>();
    dirChildren.set(dir, created);
    return created;
  };

  childrenOf(ROOT);
  childrenOf(WORK);
  for (const [rel, spec] of Object.entries(files)) {
    const parts = rel.split('/');
    let cur = ROOT;
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i];
      childrenOf(cur).add(name);
      const child = join(cur, name);
      if (i === parts.length - 1) {
        fileMap.set(child, spec);
      } else {
        childrenOf(child);
        cur = child;
      }
    }
  }

  const statErrors = new Set((options.statErrors ?? []).map(abs));
  const readDirErrors = new Set((options.readDirErrors ?? []).map(abs));
  const readFileErrors = new Set((options.readFileErrors ?? []).map(abs));
  const streamErrors = new Set((options.streamErrors ?? []).map(abs));

  const bytesOf = (spec: FileSpec): Buffer => {
    const c = spec.content;
    if (c === undefined) return Buffer.alloc(0);
    return Buffer.isBuffer(c) ? c : Buffer.from(c, 'utf8');
  };

  const fs: FsLike = {
    async readFile(path: string): Promise<Buffer> {
      readFileReads.push(path);
      if (readFileErrors.has(path)) throw new Error(`EACCES readFile ${path}`);
      if (writes.has(path)) return writes.get(path) as Buffer;
      const spec = fileMap.get(path);
      if (!spec) throw new Error(`ENOENT readFile ${path}`);
      return bytesOf(spec);
    },
    async readDir(path: string): Promise<readonly string[]> {
      if (readDirErrors.has(path)) throw new Error(`EACCES readDir ${path}`);
      const children = dirChildren.get(path);
      if (!children) throw new Error(`ENOENT readDir ${path}`);
      return [...children];
    },
    async stat(path: string): Promise<FileStat> {
      if (statErrors.has(path)) throw new Error(`EACCES stat ${path}`);
      const spec = fileMap.get(path);
      if (spec) return fileStat(spec);
      if (dirChildren.has(path)) return dirStat();
      throw new Error(`ENOENT stat ${path}`);
    },
    async exists(path: string): Promise<boolean> {
      return fileMap.has(path) || dirChildren.has(path) || writes.has(path);
    },
    openReadStream(path: string): Readable {
      streamReads.push(path);
      if (streamErrors.has(path)) throw new Error(`EACCES openReadStream ${path}`);
      // A scratch file the importer materialized (a zip-extracted mbox or an
      // attachment) streams back from the write log, mirroring the real fs where
      // openReadStream (createReadStream) streams ANY on-disk file (AC-11).
      if (writes.has(path)) return Readable.from(writes.get(path) as Buffer);
      const spec = fileMap.get(path);
      if (!spec) throw new Error(`ENOENT openReadStream ${path}`);
      return Readable.from(bytesOf(spec));
    },
    async writeFile(path: string, data: Buffer): Promise<void> {
      writes.set(path, Buffer.isBuffer(data) ? data : Buffer.from(data));
    },
  };

  return { fs, writes, streamReads, readFileReads };
}

interface ExifOptions {
  byPath?: Record<string, ExifData>;
  throwsFor?: string[];
}

interface ProbeOptions {
  byPath?: Record<string, MediaInfo>;
}

function makeDeps(
  fakeFs: FakeFs,
  opts: {
    exif?: ExifOptions;
    probe?: ProbeOptions;
    extract?: ImporterDeps['extractArchive'];
  } = {},
): ImporterDeps {
  const exifByPath = opts.exif?.byPath ?? {};
  const exifThrows = new Set(opts.exif?.throwsFor ?? []);
  const probeByPath = opts.probe?.byPath ?? {};
  return {
    fs: fakeFs.fs,
    extractArchive:
      opts.extract ??
      (async () => {
        throw new Error('extractArchive not used in this test');
      }),
    async readExif(path: string): Promise<ExifData | null> {
      if (exifThrows.has(path)) throw new Error(`exif boom ${path}`);
      return exifByPath[path] ?? null;
    },
    async probeMedia(path: string): Promise<MediaInfo> {
      return probeByPath[path] ?? { durationSec: null, width: null, height: null, mimeType: null };
    },
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
    sourceId: 'src-takeout',
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
  const result = await drainImporter(takeoutImporter, inputPath, c.ctx, (r) => records.push(r));
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

// ── mbox fixture builders ───────────────────────────────────────────────────

/** Join RFC-822 message blocks into an mboxrd stream with `From ` separators. */
function mbox(...messages: string[]): string {
  return messages
    .map((m) => `From 1779999999999999999@xmail Mon Jan 01 00:00:00 2024\r\n${m}\r\n`)
    .join('');
}

function plainEmail(opts: {
  from: string;
  subject?: string;
  date?: string;
  body?: string;
}): string {
  const headers = [`From: ${opts.from}`];
  if (opts.subject !== undefined) headers.push(`Subject: ${opts.subject}`);
  if (opts.date !== undefined) headers.push(`Date: ${opts.date}`);
  headers.push('Content-Type: text/plain; charset=utf-8');
  return `${headers.join('\r\n')}\r\n\r\n${opts.body ?? ''}`;
}

function emailWithJpeg(opts: {
  from: string;
  subject: string;
  date: string;
  body: string;
  filename: string;
  bytes: string;
}): string {
  return [
    `From: ${opts.from}`,
    `Subject: ${opts.subject}`,
    `Date: ${opts.date}`,
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="b1"',
    '',
    '--b1',
    'Content-Type: text/plain; charset=utf-8',
    '',
    opts.body,
    '--b1',
    'Content-Type: image/jpeg',
    `Content-Disposition: attachment; filename="${opts.filename}"`,
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(opts.bytes, 'utf8').toString('base64'),
    '--b1--',
  ].join('\r\n');
}

function sidecar(obj: Record<string, unknown>): string {
  return JSON.stringify(obj);
}

const EMAIL_0 = plainEmail({
  from: 'Alice <alice@example.com>',
  subject: 'Hello there',
  date: 'Sat, 30 Dec 2023 14:30:00 +0000',
  body: 'This is the body.\r\nLine two.',
});

// Body contains an mboxrd-escaped ">From " line that MUST be unescaped and MUST
// NOT be treated as a new message separator.
const EMAIL_1 = plainEmail({
  from: 'Bob <bob@example.com>',
  subject: 'Quote',
  date: 'Sun, 31 Dec 2023 09:00:00 +0000',
  body: '>From the desk of Bob\r\nregards',
});

const EMAIL_2 = emailWithJpeg({
  from: 'Carol <carol@example.com>',
  subject: 'Photo attached',
  date: 'Mon, 01 Jan 2024 00:00:00 +0000',
  body: 'See the attached picture.',
  filename: 'beach.jpg',
  bytes: 'jpeg-attachment-bytes',
});

// A block between two valid messages with no parseable headers/body/attachments
// — the adversarial "malformed/truncated" case (must skip, never abort).
const GARBAGE_BLOCK = '@@@@ not a real message @@@@\r\n\x00\x01\x02 binary noise';

describe('takeoutImporter (card C4 — Google Takeout importer, AC-11)', () => {
  it('identifies itself as the google_takeout source', () => {
    expect(takeoutImporter.id).toBe('google_takeout');
    expect(takeoutImporter.displayName).toBeTypeOf('string');
    expect(takeoutImporter.displayName.length).toBeGreaterThan(0);
  });

  describe('canHandle', () => {
    it('accepts a standalone .mbox file', async () => {
      const f = buildFs({ 'All mail.mbox': { content: mbox(EMAIL_0) } });
      expect(await takeoutImporter.canHandle(abs('All mail.mbox'), makeDeps(f))).toBe(true);
    });

    it('accepts a .zip whose entry names carry a Takeout marker without whole-archive reads', async () => {
      const dir = makeTmpDir('takeout-can-handle-');
      const archive = join(dir, 'takeout.zip');
      writeFileSync(archive, buildZip([{ name: 'Takeout/Mail/All.mbox' }]));
      const f = buildFs({});
      f.fs.readFile = async () => {
        throw new Error('canHandle must not materialize zip bytes');
      };
      try {
        expect(await takeoutImporter.canHandle(archive, makeDeps(f))).toBe(true);
      } finally {
        removeTmpDir(dir);
      }
    });

    it('rejects a present .zip whose entry names carry no Takeout markers', async () => {
      const dir = makeTmpDir('takeout-negative-can-handle-');
      const archive = join(dir, 'plain.zip');
      writeFileSync(archive, buildZip([{ name: 'exports/plain/data.json' }]));
      try {
        expect(await takeoutImporter.canHandle(archive, makeDeps(buildFs({})))).toBe(false);
      } finally {
        removeTmpDir(dir);
      }
    });

    it('accepts a Takeout directory (Mail/ + Google Photos/) and rejects a plain folder', async () => {
      const takeout = buildFs({
        'archive_browser.html': { content: '<html></html>' },
        'Mail/All mail.mbox': { content: mbox(EMAIL_0) },
        'Google Photos/Album/IMG.jpg': { content: 'jpeg' },
      });
      expect(await takeoutImporter.canHandle(ROOT, makeDeps(takeout))).toBe(true);

      const plain = buildFs({ 'a.txt': { content: 'x' }, 'b.md': { content: 'y' } });
      expect(await takeoutImporter.canHandle(ROOT, makeDeps(plain))).toBe(false);
    });

    it('accepts a bare Google Photos album folder (media + .json sidecars)', async () => {
      const album = buildFs({
        'IMG_1234.jpg': { content: 'jpeg' },
        'IMG_1234.jpg.json': { content: sidecar({ title: 'IMG_1234.jpg' }) },
      });
      expect(await takeoutImporter.canHandle(ROOT, makeDeps(album))).toBe(true);
    });

    it('returns false for a path that does not exist', async () => {
      const f = buildFs({});
      expect(await takeoutImporter.canHandle('/nope/missing', makeDeps(f))).toBe(false);
    });
  });

  describe('Gmail .mbox streaming (AC-11)', () => {
    const FILES: Record<string, FileSpec> = {
      'Mail/All mail.mbox': { content: mbox(EMAIL_0, EMAIL_1, GARBAGE_BLOCK, EMAIL_2) },
    };

    it('streams message-by-message via openReadStream — never readFile on the .mbox', async () => {
      // readFile on the .mbox throws; a whole-file load would abort. Streaming
      // works, proving the importer honors the multi-GB memory-bound (AC-11).
      const f = buildFs(FILES, { readFileErrors: ['Mail/All mail.mbox'] });
      const { records, skips } = await run(ROOT, makeDeps(f));

      const subjects = records.map((r) => r.sourceMeta.subject);
      expect(subjects).toContain('Hello there');
      expect(subjects).toContain('Quote');
      expect(subjects).toContain('Photo attached');
      expect(f.streamReads).toContain(abs('Mail/All mail.mbox'));
      // The garbage block was skipped, the run continued, nothing else dropped.
      expect(skips.some((s) => s.code === 'E_PARSE_MSG')).toBe(true);
    });

    it('skips a giant no-separator mbox message instead of accumulating it unbounded', async () => {
      const f = buildFs({
        'Mail/All mail.mbox': {
          content: `Subject: adversarial\r\n\r\n${'x'.repeat(5 * 1024 * 1024)}`,
        },
      });

      const { records, result, skips } = await run(ROOT, makeDeps(f));

      expect(records).toHaveLength(0);
      expect(result.recordCount).toBe(0);
      expect(skips).toContainEqual(
        expect.objectContaining({
          ref: 'Mail/All mail.mbox#0',
          code: 'E_MBOX_MESSAGE_TOO_LARGE',
        }),
      );
    });

    it('maps sender, header date (source: message) and subject+body text for an email', async () => {
      const f = buildFs(FILES);
      const { records } = await run(ROOT, makeDeps(f));
      const email = records.find((r) => r.sourceMeta.subject === 'Hello there');

      expect(email).toBeDefined();
      expect(email?.sourceType).toBe('google_takeout');
      expect(email?.mediaType).toBe('message');
      expect(email?.originalPath).toBeNull();
      expect(email?.author).toContain('alice@example.com');
      expect(email?.date?.source).toBe('message');
      expect(email?.date?.value.getTime()).toBe(utc(2023, 11, 30, 14, 30, 0));
      expect(email?.body).toContain('Hello there'); // subject is searchable text
      expect(email?.body).toContain('This is the body.');
    });

    it('unescapes a >From body line and does NOT split it into a new message', async () => {
      const f = buildFs(FILES);
      const { records } = await run(ROOT, makeDeps(f));
      const email = records.find((r) => r.sourceMeta.subject === 'Quote');

      expect(email).toBeDefined();
      expect(email?.body).toContain('From the desk of Bob');
      expect(email?.body).not.toContain('>From the desk of Bob');
      // Exactly one email carries this body — the escaped line did not split it.
      expect(records.filter((r) => (r.body ?? '').includes('From the desk of Bob'))).toHaveLength(
        1,
      );
    });

    it('emits an attachment as a media record, materialized into scratch for hashing', async () => {
      const f = buildFs(FILES);
      const { records } = await run(ROOT, makeDeps(f));
      const att = records.find((r) => r.mediaType === 'photo');

      expect(att).toBeDefined();
      expect(att?.sourceType).toBe('google_takeout');
      expect(att?.mimeType).toBe('image/jpeg');
      expect(att?.originalPath).not.toBeNull();
      expect(att?.originalPath?.startsWith(WORK)).toBe(true);
      // The decoded attachment bytes were written to that scratch path.
      const written = f.writes.get(att?.originalPath as string);
      expect(written?.toString('utf8')).toBe('jpeg-attachment-bytes');
      // Provenance ties it back to the email it arrived in.
      expect(att?.sourceMeta).toMatchObject({ attachmentFileName: 'beach.jpg' });
    });

    it('dates an attachment from its EXIF capture time when present, else the email date', async () => {
      // First: no EXIF → inherits the email header date (provenance message).
      const f1 = buildFs(FILES);
      const r1 = await run(ROOT, makeDeps(f1));
      const att1 = r1.records.find((r) => r.mediaType === 'photo');
      expect(att1?.date?.source).toBe('message');
      expect(att1?.date?.value.getTime()).toBe(utc(2024, 0, 1, 0, 0, 0));

      // Then: EXIF on the materialized file wins (the real capture date).
      const f2 = buildFs(FILES);
      const scratchPaths: string[] = [];
      const exifByPath: Record<string, ExifData> = {};
      // The importer writes the attachment before reading its EXIF; capture the
      // path by wrapping writeFile so we can attach an EXIF date to it.
      const realWrite = f2.fs.writeFile?.bind(f2.fs);
      f2.fs.writeFile = async (path: string, data: Buffer) => {
        scratchPaths.push(path);
        exifByPath[path] = { takenAt: new Date(utc(2022, 5, 15, 8, 0, 0)) };
        await realWrite?.(path, data);
      };
      const r2 = await run(ROOT, makeDeps(f2, { exif: { byPath: exifByPath } }));
      const att2 = r2.records.find((r) => r.mediaType === 'photo');
      expect(scratchPaths.length).toBeGreaterThan(0);
      expect(att2?.date?.source).toBe('exif');
      expect(att2?.date?.value.getTime()).toBe(utc(2022, 5, 15, 8, 0, 0));
    });

    it('reports E_WRITE_ATTACH and keeps the email when attachment materialization fails', async () => {
      const f = buildFs(FILES);
      f.fs.writeFile = async () => {
        throw new Error('disk full');
      };

      const { records, result, skips } = await run(ROOT, makeDeps(f));

      expect(records.some((r) => r.mediaType === 'message')).toBe(true);
      expect(records.some((r) => r.sourceRef.includes('/att/'))).toBe(false);
      expect(skips).toContainEqual({
        ref: 'Mail/All mail.mbox#3/att/0',
        reason: 'could not write attachment: disk full',
        code: 'E_WRITE_ATTACH',
      });
      expect(result.skipped.some((s) => s.code === 'E_WRITE_ATTACH')).toBe(true);
    });

    it('skips a malformed message (E_PARSE_MSG) and preserves the others (AC-15)', async () => {
      const f = buildFs(FILES);
      const { records, result, skips } = await run(ROOT, makeDeps(f));

      const emailCount = records.filter((r) => r.mediaType === 'message').length;
      expect(emailCount).toBe(3); // EMAIL_0, EMAIL_1, EMAIL_2 — garbage excluded
      expect(skips.some((s) => s.code === 'E_PARSE_MSG')).toBe(true);
      expect(result.skipped.some((s) => s.code === 'E_PARSE_MSG')).toBe(true);
    });

    it('reports E_READ_MBOX and keeps going when the mbox stream cannot be opened (AC-15)', async () => {
      const f = buildFs(
        {
          'Mail/All mail.mbox': { content: mbox(EMAIL_0) },
          'Google Photos/Album/keep.jpg': { content: 'jpeg', mtimeMs: utc(2020, 0, 1, 0, 0, 0) },
        },
        { streamErrors: ['Mail/All mail.mbox'] },
      );
      const { records, result, skips } = await run(ROOT, makeDeps(f));

      // The photo is still imported even though the mbox could not be read.
      expect(records.some((r) => r.sourceRef.endsWith('keep.jpg'))).toBe(true);
      expect(skips.some((s) => s.code === 'E_READ_MBOX')).toBe(true);
      expect(result.skipped.some((s) => s.code === 'E_READ_MBOX')).toBe(true);
    });

    it('reports E_READ_MBOX, preserves prior emails and never leaks the stream when createInterface throws (AC-15)', async () => {
      // Defensive AC-15 path (#76): the read-stream seam is acquired fine, but
      // `createInterface` itself throws while wiring up the readline interface.
      // Such a throw must be REPORTED as a skip — never escape the import
      // generator and abort the whole run, losing every other email/photo —
      // and the acquired stream must still be destroyed (no leak).
      const f = buildFs({
        'Mail/good.mbox': { content: mbox(EMAIL_0, EMAIL_1) },
        'Mail/bad.mbox': { content: mbox(EMAIL_2) },
        'Google Photos/Album/keep.jpg': { content: 'jpeg', mtimeMs: utc(2020, 0, 1, 0, 0, 0) },
      });
      let destroyed = false;
      const realOpen = f.fs.openReadStream?.bind(f.fs);
      // A value the readline interface rejects at construction (no `.on`), so
      // `createInterface({ input })` throws — yet `destroy()` must still run.
      const poisoned = {
        destroy: () => {
          destroyed = true;
        },
      } as unknown as Readable;
      f.fs.openReadStream = (path: string) =>
        path === abs('Mail/bad.mbox') ? poisoned : (realOpen?.(path) as Readable);

      const { records, result, skips } = await run(ROOT, makeDeps(f));

      // The createInterface failure was reported, not thrown (we reached here).
      expect(skips.some((s) => s.code === 'E_READ_MBOX')).toBe(true);
      expect(result.skipped.some((s) => s.code === 'E_READ_MBOX')).toBe(true);
      // Partial preserved: the healthy mailbox's emails AND the photo survived.
      const subjects = records
        .filter((r) => r.mediaType === 'message')
        .map((r) => r.sourceMeta.subject);
      expect(subjects).toContain('Hello there');
      expect(subjects).toContain('Quote');
      expect(records.some((r) => r.sourceRef.endsWith('keep.jpg'))).toBe(true);
      // No leak: the acquired stream was destroyed even though createInterface threw.
      expect(destroyed).toBe(true);
    });

    it('keeps a benign email with no subject and no body (never silently dropped)', async () => {
      const onlyHeaders = plainEmail({
        from: 'Dora <dora@example.com>',
        date: 'Tue, 02 Jan 2024 12:00:00 +0000',
      });
      const f = buildFs({ 'Mail/All mail.mbox': { content: mbox(onlyHeaders) } });
      const { records, skips } = await run(ROOT, makeDeps(f));

      const email = records.find((r) => r.author?.includes('dora@example.com'));
      expect(email).toBeDefined();
      expect(email?.mediaType).toBe('message');
      expect(email?.date?.value.getTime()).toBe(utc(2024, 0, 2, 12, 0, 0));
      expect(skips).toHaveLength(0); // a sparse-but-real email is not "malformed"
    });
  });

  describe('Google Photos media + JSON sidecars', () => {
    it('uses the sidecar photoTakenTime (source: sidecar), geoData, and description', async () => {
      const f = buildFs({
        'Google Photos/Lake/IMG_1234.jpg': { content: 'jpeg', mtimeMs: utc(2019, 0, 1, 0, 0, 0) },
        'Google Photos/Lake/IMG_1234.jpg.json': {
          content: sidecar({
            title: 'IMG_1234.jpg',
            description: 'Sunset at the lake',
            photoTakenTime: { timestamp: '1609459200', formatted: 'Jan 1, 2021' },
            creationTime: { timestamp: '1609470000', formatted: 'Jan 1, 2021' },
            geoData: { latitude: 37.42, longitude: -122.08, altitude: 12.5 },
          }),
        },
      });
      const { records, byRef } = await run(ROOT, makeDeps(f));
      const photo = byRef.get('Google Photos/Lake/IMG_1234.jpg');

      expect(records).toHaveLength(1);
      expect(photo?.sourceType).toBe('google_takeout');
      expect(photo?.mediaType).toBe('photo');
      expect(photo?.originalPath).toBe(abs('Google Photos/Lake/IMG_1234.jpg'));
      expect(photo?.date?.source).toBe('sidecar');
      expect(photo?.date?.value.getTime()).toBe(1609459200 * 1000);
      expect(photo?.gps).toEqual({ lat: 37.42, lon: -122.08, alt: 12.5 });
      expect(photo?.body).toBe('Sunset at the lake');
      expect(photo?.sourceMeta).toMatchObject({ album: 'Lake' });
    });

    it('falls back to EXIF when no sidecar is present', async () => {
      const photoPath = abs('Google Photos/Trip/photo2.jpg');
      const f = buildFs({ 'Google Photos/Trip/photo2.jpg': { content: 'jpeg' } });
      const exif: ExifData = {
        takenAt: new Date(utc(2018, 6, 4, 10, 30, 0)),
        gps: { lat: 1.5, lon: 2.5 },
      };
      const { byRef } = await run(ROOT, makeDeps(f, { exif: { byPath: { [photoPath]: exif } } }));
      const photo = byRef.get('Google Photos/Trip/photo2.jpg');

      expect(photo?.date?.source).toBe('exif');
      expect(photo?.date?.value.getTime()).toBe(utc(2018, 6, 4, 10, 30, 0));
      expect(photo?.gps).toEqual({ lat: 1.5, lon: 2.5 });
    });

    it('treats EXIF GPS 0/0 as a no-location sentinel when no sidecar is present', async () => {
      const photoPath = abs('Google Photos/Trip/no-location.jpg');
      const f = buildFs({ 'Google Photos/Trip/no-location.jpg': { content: 'jpeg' } });
      const exif: ExifData = { gps: { lat: 0, lon: 0 } };

      const { byRef } = await run(ROOT, makeDeps(f, { exif: { byPath: { [photoPath]: exif } } }));

      expect(byRef.get('Google Photos/Trip/no-location.jpg')?.gps).toBeNull();
    });

    it('treats sidecar geoData 0/0 as a no-location sentinel', async () => {
      const f = buildFs({
        'Google Photos/Trip/sidecar-no-location.jpg': { content: 'jpeg' },
        'Google Photos/Trip/sidecar-no-location.jpg.json': {
          content: sidecar({ geoData: { latitude: 0, longitude: 0, altitude: 10 } }),
        },
      });

      const { byRef } = await run(ROOT, makeDeps(f));

      expect(byRef.get('Google Photos/Trip/sidecar-no-location.jpg')?.gps).toBeNull();
    });

    it('falls back to file mtime when neither sidecar nor EXIF has a date', async () => {
      const f = buildFs({
        'Google Photos/Trip/photo3.jpg': { content: 'jpeg', mtimeMs: utc(2017, 2, 3, 4, 5, 6) },
      });
      const { byRef } = await run(ROOT, makeDeps(f));
      const photo = byRef.get('Google Photos/Trip/photo3.jpg');

      expect(photo?.date?.source).toBe('mtime');
      expect(photo?.date?.value.getTime()).toBe(utc(2017, 2, 3, 4, 5, 6));
    });

    it('reports E_SIDECAR for corrupt sidecar JSON but still imports the media via fallback', async () => {
      const photoPath = abs('Google Photos/Bad/photo4.jpg');
      const f = buildFs({
        'Google Photos/Bad/photo4.jpg': { content: 'jpeg' },
        'Google Photos/Bad/photo4.jpg.json': { content: '{ not valid json ,,,' },
      });
      const exif: ExifData = { takenAt: new Date(utc(2016, 0, 2, 0, 0, 0)) };
      const { byRef, skips } = await run(
        ROOT,
        makeDeps(f, { exif: { byPath: { [photoPath]: exif } } }),
      );
      const photo = byRef.get('Google Photos/Bad/photo4.jpg');

      expect(photo).toBeDefined(); // NOT dropped
      expect(photo?.date?.source).toBe('exif'); // fell back past the corrupt sidecar
      expect(skips.some((s) => s.code === 'E_SIDECAR')).toBe(true);
    });

    it('matches the name(1).jpg ↔ name.jpg(1).json duplicate-counter quirk', async () => {
      const f = buildFs({
        'Google Photos/Dup/IMG_0001(1).jpg': { content: 'jpeg' },
        'Google Photos/Dup/IMG_0001.jpg(1).json': {
          content: sidecar({ photoTakenTime: { timestamp: '1612137600' } }),
        },
      });
      const { byRef } = await run(ROOT, makeDeps(f));
      const photo = byRef.get('Google Photos/Dup/IMG_0001(1).jpg');

      expect(photo?.date?.source).toBe('sidecar');
      expect(photo?.date?.value.getTime()).toBe(1612137600 * 1000);
    });

    it('matches a truncated/mangled sidecar name via prefix fallback', async () => {
      const f = buildFs({
        'Google Photos/Long/averyveryverylongphotonamethatgetstruncated.jpg': { content: 'jpeg' },
        'Google Photos/Long/averyveryverylongphotonamethatgetstrunc.json': {
          content: sidecar({ photoTakenTime: { timestamp: '1614556800' } }),
        },
      });
      const { byRef } = await run(ROOT, makeDeps(f));
      const photo = byRef.get('Google Photos/Long/averyveryverylongphotonamethatgetstruncated.jpg');

      expect(photo?.date?.source).toBe('sidecar');
      expect(photo?.date?.value.getTime()).toBe(1614556800 * 1000);
    });

    it('does not drop media when no sidecar matches — falls back cleanly', async () => {
      const photoPath = abs('Google Photos/None/random.jpg');
      const f = buildFs({
        'Google Photos/None/random.jpg': { content: 'jpeg' },
        // an orphan sidecar that must NOT be force-matched to random.jpg
        'Google Photos/None/unrelatedphoto.jpg.json': {
          content: sidecar({ photoTakenTime: { timestamp: '1234567890' } }),
        },
      });
      const exif: ExifData = { takenAt: new Date(utc(2015, 5, 6, 7, 8, 9)) };
      const { byRef, skips } = await run(
        ROOT,
        makeDeps(f, { exif: { byPath: { [photoPath]: exif } } }),
      );
      const photo = byRef.get('Google Photos/None/random.jpg');

      expect(photo).toBeDefined();
      expect(photo?.date?.source).toBe('exif');
      expect(photo?.date?.value.getTime()).toBe(utc(2015, 5, 6, 7, 8, 9));
      expect(skips.some((s) => s.code === 'E_SIDECAR')).toBe(false);
    });

    it('classifies a video and reads its duration via probeMedia', async () => {
      const vidPath = abs('Google Photos/Clips/clip.mp4');
      const f = buildFs({
        'Google Photos/Clips/clip.mp4': { content: 'mp4', mtimeMs: utc(2021, 3, 4, 0, 0, 0) },
      });
      const probe: MediaInfo = { durationSec: 8, width: 1920, height: 1080, mimeType: 'video/mp4' };
      const { byRef } = await run(ROOT, makeDeps(f, { probe: { byPath: { [vidPath]: probe } } }));
      const clip = byRef.get('Google Photos/Clips/clip.mp4');

      expect(clip?.mediaType).toBe('video');
      expect(clip?.durationSec).toBe(8);
      expect(clip?.mimeType).toBe('video/mp4');
    });
  });

  describe('zip Takeout (extracted via the injected guarded extractor)', () => {
    function zipDeps(entries: Record<string, string>): {
      deps: ImporterDeps;
      extractCalls: string[];
      extractSignals: (AbortSignal | undefined)[];
      f: FakeFs;
    } {
      const f = buildFs({});
      const extractCalls: string[] = [];
      const extractSignals: (AbortSignal | undefined)[] = [];
      const deps = makeDeps(f, {
        extract: async (archivePath, destDir, options) => {
          extractCalls.push(archivePath);
          extractSignals.push(options?.signal);
          return Object.entries(entries).map(([entryPath, content]) => {
            const absPath = join(destDir, ...entryPath.split('/'));
            // Register the extracted bytes so the importer can stat/stream/read them.
            void (
              f.fs as unknown as { writeFile: (p: string, d: Buffer) => Promise<void> }
            ).writeFile(absPath, Buffer.from(content, 'utf8'));
            return { entryPath, absPath };
          });
        },
      });
      return { deps, extractCalls, extractSignals, f };
    }

    it('streams a zip-extracted mbox via openReadStream — never a whole-file readFile (AC-11 regression)', async () => {
      // Google Takeout ships as a .zip, so the extracted mailbox is the PRIMARY,
      // tested import path. The extracted file is a real on-disk scratch file and
      // MUST stream like the user's own standalone .mbox: a whole-file readFile
      // throws ERR_FS_FILE_TOO_LARGE on a >2 GiB mailbox (and blows the heap) →
      // one E_READ_MBOX → every email in that mailbox is silently dropped (AC-11).
      const { deps, f } = zipDeps({ 'Takeout/Mail/All mail.mbox': mbox(EMAIL_0) });
      const mboxAbs = join(WORK, 'Takeout', 'Mail', 'All mail.mbox');

      const { records } = await run('/drop/takeout.zip', deps);

      // Read through the streaming seam, not buffered whole-file into memory.
      expect(f.streamReads).toContain(mboxAbs);
      expect(f.readFileReads).not.toContain(mboxAbs);
      // …and the email survived (no bulk loss on the primary .zip path).
      expect(records.some((r) => r.sourceMeta.subject === 'Hello there')).toBe(true);
    });

    it('imports an mbox email and a photo+sidecar from a Takeout .zip', async () => {
      const { deps, extractCalls } = zipDeps({
        'Takeout/Mail/All mail.mbox': mbox(EMAIL_0),
        'Takeout/Google Photos/Zip/IMG_9.jpg': 'jpeg',
        'Takeout/Google Photos/Zip/IMG_9.jpg.json': sidecar({
          photoTakenTime: { timestamp: '1620000000' },
        }),
      });
      const { records } = await run('/drop/takeout.zip', deps);

      expect(extractCalls).toEqual(['/drop/takeout.zip']);
      expect(records.some((r) => r.sourceMeta.subject === 'Hello there')).toBe(true);
      const photo = records.find((r) => r.sourceRef.endsWith('IMG_9.jpg'));
      expect(photo?.date?.source).toBe('sidecar');
      expect(photo?.date?.value.getTime()).toBe(1620000000 * 1000);
    });

    it('reports E_EXTRACT and returns a partial result when the archive is corrupt (AC-15)', async () => {
      const f = buildFs({});
      const deps = makeDeps(f, {
        extract: () => Promise.reject(new Error('ERR_ARCHIVE_CORRUPT: bad central directory')),
      });
      const { records, result, skips } = await run('/drop/corrupt.zip', deps);

      expect(records).toEqual([]);
      expect(result.recordCount).toBe(0);
      expect(result.skipped.some((s) => s.code === 'E_EXTRACT')).toBe(true);
      expect(skips.some((s) => s.code === 'E_EXTRACT')).toBe(true);
    });

    it('passes the import AbortSignal into archive extraction so mid-extraction cancellation stops writes', async () => {
      const controller = new AbortController();
      const f = buildFs({});
      let observedSignal: AbortSignal | undefined;
      const deps = makeDeps(f, {
        extract: async (_archivePath, _destDir, options) => {
          observedSignal = options?.signal;
          controller.abort();
          if (options?.signal?.aborted) {
            throw new ArchiveError(ARCHIVE_ERROR_CODES.ABORTED, 'archive extraction aborted');
          }
          return [
            { entryPath: 'Takeout/Google Photos/Large/big.jpg', absPath: join(WORK, 'big.jpg') },
          ];
        },
      });

      const { records, result, skips } = await run('/drop/takeout.zip', deps, controller.signal);

      expect(observedSignal).toBe(controller.signal);
      expect(records).toEqual([]);
      expect(skips).toHaveLength(1);
      expect(skips[0].reason).toContain(ARCHIVE_ERROR_CODES.ABORTED);
      expect(result.skipped[0].reason).toContain(ARCHIVE_ERROR_CODES.ABORTED);
    });
  });

  describe('resilient discovery (AC-15)', () => {
    it('skips an unreadable file (E_STAT) and imports the rest, never throwing', async () => {
      const f = buildFs(
        {
          'Google Photos/A/good.jpg': { content: 'jpeg', mtimeMs: utc(2020, 0, 1, 0, 0, 0) },
          'Google Photos/A/locked.jpg': { content: 'jpeg' },
        },
        { statErrors: ['Google Photos/A/locked.jpg'] },
      );
      const { records, skips } = await run(ROOT, makeDeps(f));

      expect(records.some((r) => r.sourceRef.endsWith('good.jpg'))).toBe(true);
      expect(records.some((r) => r.sourceRef.endsWith('locked.jpg'))).toBe(false);
      expect(skips.some((s) => s.code === 'E_STAT')).toBe(true);
    });
  });

  describe('cancellation', () => {
    const FILES: Record<string, FileSpec> = {
      'Mail/All mail.mbox': { content: mbox(EMAIL_0, EMAIL_1, EMAIL_2) },
    };

    it('honors a pre-aborted signal — emits nothing, never extracts', async () => {
      const controller = new AbortController();
      controller.abort();
      const f = buildFs({});
      const extractCalls: string[] = [];
      const deps = makeDeps(f, {
        extract: async (archivePath) => {
          extractCalls.push(archivePath);
          return [];
        },
      });
      const { records, result } = await run('/drop/takeout.zip', deps, controller.signal);

      expect(records).toEqual([]);
      expect(result.recordCount).toBe(0);
      expect(extractCalls).toEqual([]);
    });

    it('stops emitting once the signal aborts mid-import', async () => {
      const controller = new AbortController();
      const f = buildFs(FILES);
      const c = makeContext(makeDeps(f), controller.signal);
      const gen = takeoutImporter.import(ROOT, c.ctx);

      const first = await gen.next();
      expect(first.done).toBe(false);
      controller.abort();
      const next = await gen.next();

      expect(next.done).toBe(true);
      if (next.done) {
        expect(next.value.recordCount).toBeGreaterThanOrEqual(1);
      }
    });
  });
});

// A Map that records how its lookup primitives are exercised, so a test can prove
// the sidecar matcher reuses the per-directory JSON Map directly (O(1) `has`, a
// single lazy `keys` pass only for the truncation fallback) rather than the old
// per-media-file `[...keys()]` spread + `new Set(...)` rebuild that made album
// matching O(n²) on user-controlled input size.
class CountingMap extends Map<string, string> {
  hasCalls = 0;
  keysCalls = 0;
  override has(key: string): boolean {
    this.hasCalls += 1;
    return super.has(key);
  }
  override keys() {
    this.keysCalls += 1;
    return super.keys();
  }
}

describe('findSidecarName (reuses the per-directory JSON Map — O(n²) sidecar-match fix)', () => {
  it('resolves a canonical media.ext.json through Map.has, never scanning the whole album', () => {
    const jsons = new CountingMap();
    for (let i = 0; i < 500; i++) jsons.set(`filler-${i}.jpg.json`, `/abs/filler-${i}.jpg.json`);
    jsons.set('IMG_1234.jpg.json', '/abs/IMG_1234.jpg.json');

    const match = findSidecarName('IMG_1234.jpg', jsons);

    expect(match).toBe('IMG_1234.jpg.json');
    // A direct hit is an O(1) Map.has — it must NOT spread/scan every key per file.
    expect(jsons.hasCalls).toBeGreaterThanOrEqual(1);
    expect(jsons.keysCalls).toBe(0);
  });

  describe('sanitizeSegment (scratch path hardening)', () => {
    it('normalizes dot-dot segments so attachment scratch paths cannot climb one level', () => {
      expect(sanitizeSegment('..')).toBe('unnamed');
      expect(sanitizeSegment('../..')).not.toContain('..');
      expect(sanitizeSegment('family photos')).toBe('family_photos');
    });
  });

  it('matches the name(1).jpg ↔ name.jpg(1).json duplicate-counter quirk through Map.has', () => {
    const jsons = new CountingMap();
    jsons.set('IMG_0001.jpg(1).json', '/abs/IMG_0001.jpg(1).json');

    const match = findSidecarName('IMG_0001(1).jpg', jsons);

    expect(match).toBe('IMG_0001.jpg(1).json');
    expect(jsons.keysCalls).toBe(0); // resolved by has(), no full-album scan
  });

  it('falls back to a single longest-prefix pass over Map.keys only when no direct match exists', () => {
    const jsons = new CountingMap();
    jsons.set('averyverylongphotonamethatgottrunc.json', '/abs/trunc.json');

    const match = findSidecarName('averyverylongphotonamethatgottruncated.jpg', jsons);

    expect(match).toBe('averyverylongphotonamethatgottrunc.json');
    expect(jsons.keysCalls).toBe(1); // one lazy scan, not a per-key Set rebuild
  });

  it('returns null when nothing matches so the caller falls back to EXIF/mtime (never drops)', () => {
    const jsons = new CountingMap();
    jsons.set('unrelatedphoto.jpg.json', '/abs/unrelatedphoto.jpg.json');

    expect(findSidecarName('orphan.jpg', jsons)).toBeNull();
  });
});
