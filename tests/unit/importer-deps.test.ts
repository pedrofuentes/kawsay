import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTmpDir, removeTmpDir } from '../helpers/tmp';
import { hashFile } from '../../electron/main/importers/deps/hash';
import { nodeFs } from '../../electron/main/importers/deps/node-fs';
import { folderImporter } from '../../electron/main/importers/folder-importer';
import type { ImportContext } from '../../electron/main/importers/types';
import { normalizeExif, asUtcInstant, readExif } from '../../electron/main/importers/deps/exif';
import {
  parseFfprobe,
  createMediaProber,
  type ProbeDataLike,
} from '../../electron/main/importers/deps/ffprobe';
import {
  derivedRelPath,
  buildFrameArgs,
  createThumbnailGenerator,
  type RunFfmpeg,
} from '../../electron/main/importers/deps/thumbnail';
import {
  createImporterDeps,
  unavailableExtractArchive,
} from '../../electron/main/importers/deps/index';

const dirs: string[] = [];
function tmp(prefix: string): string {
  const dir = makeTmpDir(prefix);
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) removeTmpDir(dir);
});

describe('hashFile (streaming SHA-256 → lowercase hex)', () => {
  it('hashes file bytes to the canonical lowercase hex digest', async () => {
    const file = join(tmp('hash'), 'a.bin');
    writeFileSync(file, 'hello kawsay');
    const expected = createHash('sha256').update('hello kawsay').digest('hex');

    const digest = await hashFile(file);

    expect(digest).toBe(expected);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects when the file cannot be read', async () => {
    await expect(hashFile(join(tmp('hash'), 'missing.bin'))).rejects.toThrow();
  });
});

describe('nodeFs (the real FsLike)', () => {
  it('stats, lists, reads, and probes existence', async () => {
    const dir = tmp('fs');
    const file = join(dir, 'x.txt');
    writeFileSync(file, 'abc');

    const stat = await nodeFs.stat(file);
    expect(stat.size).toBe(3);
    expect(stat.isFile()).toBe(true);
    expect(stat.isDirectory()).toBe(false);

    expect(await nodeFs.exists(file)).toBe(true);
    expect(await nodeFs.exists(join(dir, 'nope'))).toBe(false);
    expect(await nodeFs.readDir(dir)).toContain('x.txt');
    expect((await nodeFs.readFile(file)).toString()).toBe('abc');
  });
});

describe('nodeFs symlink handling (lstat semantics — issue #51)', () => {
  // fsp.stat follows symlinks, so a symlinked DIRECTORY would report
  // isDirectory()===true and the folder walker would descend it — enabling a
  // symlink cycle (unbounded recursion) or an escape outside the selected root
  // (e.g. into ~/.ssh). The concrete stat must use lstat semantics so a symlink
  // reports as NEITHER file nor directory and the walker simply ignores it.
  it('reports a symlinked directory as neither file nor directory', async () => {
    const dir = tmp('symdir');
    const realDir = join(dir, 'real-dir');
    mkdirSync(realDir);
    const link = join(dir, 'link-to-dir');
    symlinkSync(realDir, link, 'dir');

    const stat = await nodeFs.stat(link);

    expect(stat.isDirectory()).toBe(false);
    expect(stat.isFile()).toBe(false);
  });

  it('reports a symlinked file as neither file nor directory', async () => {
    const dir = tmp('symfile');
    const realFile = join(dir, 'real.txt');
    writeFileSync(realFile, 'bytes');
    const link = join(dir, 'link-to-file');
    symlinkSync(realFile, link, 'file');

    const stat = await nodeFs.stat(link);

    expect(stat.isFile()).toBe(false);
    expect(stat.isDirectory()).toBe(false);
  });

  it('still reports real files and directories correctly (behavior intact)', async () => {
    const dir = tmp('symreal');
    const file = join(dir, 'a.txt');
    writeFileSync(file, 'abc');

    const fileStat = await nodeFs.stat(file);
    expect(fileStat.isFile()).toBe(true);
    expect(fileStat.isDirectory()).toBe(false);
    expect(fileStat.size).toBe(3);

    const dirStat = await nodeFs.stat(dir);
    expect(dirStat.isDirectory()).toBe(true);
    expect(dirStat.isFile()).toBe(false);
  });
});

describe('nodeFs streaming read + scratch write (Takeout seam — AC-11)', () => {
  it('openReadStream yields the file bytes without a whole-file readFile', async () => {
    const dir = tmp('stream');
    const file = join(dir, 'big.mbox');
    writeFileSync(file, 'From a@b\r\nSubject: hi\r\n\r\nbody\r\n');

    const stream = nodeFs.openReadStream?.(file);
    expect(stream).toBeDefined();
    const chunks: Buffer[] = [];
    for await (const chunk of stream as NodeJS.ReadableStream) {
      chunks.push(Buffer.from(chunk));
    }
    expect(Buffer.concat(chunks).toString('utf8')).toBe('From a@b\r\nSubject: hi\r\n\r\nbody\r\n');
  });

  it('writeFile persists bytes into a nested scratch path (creating parents)', async () => {
    const dir = tmp('scratchwrite');
    const target = join(dir, 'nested', 'deep', 'att.bin');

    await nodeFs.writeFile?.(target, Buffer.from('attachment-bytes'));

    expect((await nodeFs.readFile(target)).toString('utf8')).toBe('attachment-bytes');
  });
});

describe('folder walker ignores directory symlinks (defense-in-depth — issue #51)', () => {
  it('does not recurse into a directory symlink that points to an ancestor (no cycle)', async () => {
    const root = tmp('symwalk');
    writeFileSync(join(root, 'real.txt'), 'hello');
    // A directory symlink pointing back to its own ancestor: if the walker
    // followed it, real.txt would be re-discovered at every depth and the walk
    // would never terminate.
    symlinkSync(root, join(root, 'loop'), 'dir');

    const deps = createImporterDeps({ extractArchive: unavailableExtractArchive });
    const ctx: ImportContext = {
      sourceId: 'src',
      workDir: join(root, '.work'),
      signal: new AbortController().signal,
      deps,
      onSkip: () => undefined,
      onProgress: () => undefined,
    };

    // Drive the importer with both a hard pull cap (catches infinite re-yielding,
    // whatever order readDir returns the entries in) and an overall timeout
    // (catches a no-yield infinite recursion) so a buggy, symlink-following
    // walker fails fast instead of hanging the suite.
    const drain = (async (): Promise<string[]> => {
      const refs: string[] = [];
      const gen = folderImporter.import(root, ctx);
      for (let i = 0; i < 500; i++) {
        const next = await gen.next();
        if (next.done) return refs;
        refs.push(next.value.sourceRef);
      }
      throw new Error('walker exceeded the record cap — it descended into the symlink');
    })();
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('walker did not terminate — it followed the symlink')), 3000);
    });

    const refs = await Promise.race([drain, timeout]);

    expect(refs).toEqual(['real.txt']);
  }, 10_000);
});

describe('exif (exifr wrapper, ARCHITECTURE §3.2/§7.2)', () => {
  it('reinterprets a tz-less EXIF wall-clock as a UTC instant', () => {
    // EXIF DateTimeOriginal carries no timezone → read as UTC (§3.2). The Date
    // exifr hands back has the wall-clock in LOCAL components; asUtcInstant pins
    // those same components to UTC, so the result is TZ-independent.
    const local = new Date(2019, 5, 14, 13, 45, 30);
    expect(asUtcInstant(local).toISOString()).toBe('2019-06-14T13:45:30.000Z');
  });

  it('normalizes the recognized EXIF fields', () => {
    const out = normalizeExif({
      DateTimeOriginal: new Date(2019, 5, 14, 13, 45, 30),
      latitude: 40.4168,
      longitude: -3.7038,
      GPSAltitude: 667,
      Make: 'Apple',
      Model: 'iPhone 11',
      ExifImageWidth: 4032,
      ExifImageHeight: 3024,
      Orientation: 6,
    });

    expect(out?.takenAt?.toISOString()).toBe('2019-06-14T13:45:30.000Z');
    expect(out?.gps).toEqual({ lat: 40.4168, lon: -3.7038, alt: 667 });
    expect(out?.cameraMake).toBe('Apple');
    expect(out?.cameraModel).toBe('iPhone 11');
    expect(out?.width).toBe(4032);
    expect(out?.height).toBe(3024);
    expect(out?.orientation).toBe(6);
  });

  it('returns null for empty or absent metadata', () => {
    expect(normalizeExif(null)).toBeNull();
    expect(normalizeExif(undefined)).toBeNull();
    expect(normalizeExif({})).toBeNull();
  });

  it('omits GPS when only one coordinate is present', () => {
    const out = normalizeExif({ latitude: 40.4, Orientation: 1 });
    expect(out?.gps).toBeUndefined();
    expect(out?.orientation).toBe(1);
  });

  it('readExif returns null (never throws) on a non-image / missing file', async () => {
    const dir = tmp('exif');
    expect(await readExif(join(dir, 'missing.jpg'))).toBeNull();
    const notImage = join(dir, 'notimage.bin');
    writeFileSync(notImage, 'this is plainly not an image');
    expect(await readExif(notImage)).toBeNull();
  });
});

describe('ffprobe (MediaProber wrapper, subprocess seam)', () => {
  it('parses duration and video dimensions', () => {
    const data: ProbeDataLike = {
      format: { duration: '12.5', format_name: 'mov,mp4,m4a' },
      streams: [{ codec_type: 'video', width: 1920, height: 1080 }, { codec_type: 'audio' }],
    };
    expect(parseFfprobe(data)).toEqual({
      durationSec: 12.5,
      width: 1920,
      height: 1080,
      mimeType: null,
    });
  });

  it('falls back to all-null for unparsable / audio-only data', () => {
    expect(parseFfprobe({})).toEqual({
      durationSec: null,
      width: null,
      height: null,
      mimeType: null,
    });
    expect(
      parseFfprobe({ format: { duration: '3.0' }, streams: [{ codec_type: 'audio' }] }),
    ).toEqual({ durationSec: 3, width: null, height: null, mimeType: null });
  });

  it('passes the local path to the injected runner and parses its output', async () => {
    let probed = '';
    const prober = createMediaProber(async (path) => {
      probed = path;
      return {
        format: { duration: '5' },
        streams: [{ codec_type: 'video', width: 640, height: 480 }],
      };
    });

    const info = await prober('/media/clip.mp4');

    expect(probed).toBe('/media/clip.mp4');
    expect(info).toEqual({ durationSec: 5, width: 640, height: 480, mimeType: null });
  });

  it('never throws — a probe failure yields all-null', async () => {
    const prober = createMediaProber(async () => {
      throw new Error('ffprobe failed');
    });
    expect(await prober('/media/clip.mp4')).toEqual({
      durationSec: null,
      width: null,
      height: null,
      mimeType: null,
    });
  });

  it('bounds a runner that hangs and degrades to all-null (timeout/kill)', async () => {
    // A crafted/truncated media file can make ffprobe hang indefinitely. The
    // prober must enforce an upper bound; a runner that never settles still
    // resolves to all-null rather than stalling the whole import.
    const prober = createMediaProber(() => new Promise<ProbeDataLike>(() => undefined), {
      timeoutMs: 50,
    });
    expect(await prober('/media/hang.mp4')).toEqual({
      durationSec: null,
      width: null,
      height: null,
      mimeType: null,
    });
  }, 2000);
});

describe('thumbnail (ffmpeg generator, ARCHITECTURE §5.1/§7.2)', () => {
  it('shards renditions by content hash under derived/', () => {
    const hash = 'ab'.repeat(32);
    expect(derivedRelPath('thumbnails', hash)).toBe(
      join('derived', 'thumbnails', 'ab', `${hash}.webp`),
    );
    expect(derivedRelPath('posters', hash)).toBe(join('derived', 'posters', 'ab', `${hash}.webp`));
  });

  it('builds an array argv (no shell string) with input and output as discrete elements', () => {
    const args = buildFrameArgs('/in/a.jpg', '/out/a.webp');
    expect(Array.isArray(args)).toBe(true);
    expect(args).toContain('-y');
    expect(args).toContain('/in/a.jpg');
    expect(args.at(-1)).toBe('/out/a.webp');
    // The source path is a standalone element, never concatenated into a flag.
    expect(args.every((a) => a === '/in/a.jpg' || !a.includes('/in/a.jpg'))).toBe(true);
  });

  it('renders a photo to a content-addressed thumbnail via the injected runner', async () => {
    const hash = 'cd'.repeat(32);
    const libraryRoot = tmp('thumb');
    const calls: { command: string; args: readonly string[] }[] = [];
    const run: RunFfmpeg = async (command, args) => {
      calls.push({ command, args });
    };
    const generate = createThumbnailGenerator({ ffmpegPath: '/bin/ffmpeg', run });

    const assets = await generate({
      libraryRoot,
      itemId: 'i1',
      contentHash: hash,
      mediaType: 'photo',
      sourcePath: '/src/a.jpg',
      mimeType: 'image/jpeg',
    });

    const rel = join('derived', 'thumbnails', 'cd', `${hash}.webp`);
    expect(assets).toEqual([{ kind: 'thumbnail', path: rel }]);
    expect(calls[0]?.command).toBe('/bin/ffmpeg');
    expect(calls[0]?.args).toContain('/src/a.jpg');
    expect(calls[0]?.args).toContain(join(libraryRoot, rel));
  });

  it('renders a video to a poster rendition', async () => {
    const hash = 'ef'.repeat(32);
    const libraryRoot = tmp('thumb');
    const run: RunFfmpeg = async () => undefined;
    const generate = createThumbnailGenerator({ ffmpegPath: '/bin/ffmpeg', run });

    const assets = await generate({
      libraryRoot,
      itemId: 'i2',
      contentHash: hash,
      mediaType: 'video',
      sourcePath: '/src/v.mp4',
      mimeType: 'video/mp4',
    });

    expect(assets).toEqual([
      { kind: 'poster', path: join('derived', 'posters', 'ef', `${hash}.webp`) },
    ]);
  });

  it('propagates an ffmpeg failure to the caller', async () => {
    const generate = createThumbnailGenerator({
      ffmpegPath: '/bin/ffmpeg',
      run: async () => {
        throw new Error('ffmpeg exited 1');
      },
    });
    await expect(
      generate({
        libraryRoot: tmp('thumb'),
        itemId: 'i3',
        contentHash: 'ab'.repeat(32),
        mediaType: 'photo',
        sourcePath: '/src/a.jpg',
        mimeType: 'image/jpeg',
      }),
    ).rejects.toThrow('ffmpeg exited 1');
  });
});

describe('createImporterDeps (composition root for the sandboxed deps)', () => {
  it('assembles the real wrappers and threads the injected archive extractor', () => {
    const deps = createImporterDeps({ extractArchive: unavailableExtractArchive });
    expect(typeof deps.hashFile).toBe('function');
    expect(typeof deps.readExif).toBe('function');
    expect(typeof deps.probeMedia).toBe('function');
    expect(deps.fs).toBe(nodeFs);
    expect(deps.extractArchive).toBe(unavailableExtractArchive);
  });

  it('the placeholder extractor throws until card C2 provides the real one', async () => {
    await expect(unavailableExtractArchive('/a.zip', '/dest')).rejects.toThrow(/C2|extraction/i);
  });
});
