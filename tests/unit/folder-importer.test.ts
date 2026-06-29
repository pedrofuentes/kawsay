import { describe, expect, it } from 'vitest';
import { mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { drainImporter } from '../../electron/main/importers/drain';
import {
  createImporterDeps,
  unavailableExtractArchive,
} from '../../electron/main/importers/deps/index';
import { folderImporter } from '../../electron/main/importers/folder-importer';
import { makeTmpDir, removeTmpDir } from '../helpers/tmp';
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

// A fixed, platform-portable root. Every fixture path and assertion is built via
// `node:path` join/relative against this root, so the suite is identical on the
// POSIX and Windows CI runners (sourceRef is normalized to forward slashes).
const ROOT = '/import-root';

interface FileSpec {
  mtimeMs?: number;
  size?: number;
}

interface FsOptions {
  statErrors?: string[];
  readDirErrors?: string[];
}

function abs(rel: string): string {
  return rel === '.' ? ROOT : join(ROOT, ...rel.split('/'));
}

function normalizePathSeparators(value: string): string {
  return value.replaceAll('\\', '/');
}

function normalizeSkipReasons(skips: readonly SkippedItem[]): SkippedItem[] {
  return skips.map((skip) => ({
    ...skip,
    reason: normalizePathSeparators(skip.reason),
  }));
}

function fileStat(spec: FileSpec): FileStat {
  return {
    size: spec.size ?? 0,
    mtimeMs: spec.mtimeMs ?? 0,
    isFile: () => true,
    isDirectory: () => false,
  };
}

function dirStat(): FileStat {
  return { size: 0, mtimeMs: 0, isFile: () => false, isDirectory: () => true };
}

// An in-memory FsLike over a fixture tree declared as POSIX-relative paths.
function buildFs(files: Record<string, FileSpec>, options: FsOptions = {}): FsLike {
  const fileMap = new Map<string, FileSpec>();
  const dirChildren = new Map<string, Set<string>>();

  const childrenOf = (dir: string): Set<string> => {
    const existing = dirChildren.get(dir);
    if (existing) return existing;
    const created = new Set<string>();
    dirChildren.set(dir, created);
    return created;
  };

  childrenOf(ROOT);
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

  return {
    async readFile(path: string): Promise<Buffer> {
      if (!fileMap.has(path)) throw new Error(`ENOENT readFile ${path}`);
      return Buffer.from('');
    },
    async readDir(path: string): Promise<readonly string[]> {
      if (readDirErrors.has(path)) throw new Error(`EACCES readDir ${path}`);
      const children = dirChildren.get(path);
      if (!children) throw new Error(`ENOENT readDir ${path}`);
      return [...children];
    },
    async stat(path: string): Promise<FileStat> {
      if (statErrors.has(path)) throw new Error(`EACCES stat ${path}`);
      const file = fileMap.get(path);
      if (file) return fileStat(file);
      if (dirChildren.has(path)) return dirStat();
      throw new Error(`ENOENT stat ${path}`);
    },
    async exists(path: string): Promise<boolean> {
      return fileMap.has(path) || dirChildren.has(path);
    },
  };
}

interface ExifOptions {
  byPath?: Record<string, ExifData>;
  throwsFor?: string[];
}

interface ProbeOptions {
  byPath?: Record<string, MediaInfo>;
  throwsFor?: string[];
}

function makeDeps(
  fs: FsLike,
  exifOpts: ExifOptions = {},
  probeOpts: ProbeOptions = {},
): { deps: ImporterDeps; exifCalls: string[]; probeCalls: string[] } {
  const exifByPath = new Map(
    Object.entries(exifOpts.byPath ?? {}).map(([k, v]) => [abs(k), v] as const),
  );
  const exifThrows = new Set((exifOpts.throwsFor ?? []).map(abs));
  const probeByPath = new Map(
    Object.entries(probeOpts.byPath ?? {}).map(([k, v]) => [abs(k), v] as const),
  );
  const probeThrows = new Set((probeOpts.throwsFor ?? []).map(abs));
  const exifCalls: string[] = [];
  const probeCalls: string[] = [];

  const deps: ImporterDeps = {
    fs,
    extractArchive: async () => [],
    readExif: async (path: string): Promise<ExifData | null> => {
      exifCalls.push(path);
      if (exifThrows.has(path)) throw new Error(`exif fail ${path}`);
      return exifByPath.get(path) ?? null;
    },
    probeMedia: async (path: string): Promise<MediaInfo> => {
      probeCalls.push(path);
      if (probeThrows.has(path)) throw new Error(`probe fail ${path}`);
      return (
        probeByPath.get(path) ?? { durationSec: null, width: null, height: null, mimeType: null }
      );
    },
    hashFile: async () => 'deadbeef',
  };
  return { deps, exifCalls, probeCalls };
}

function makeContext(
  deps: ImporterDeps,
  signal?: AbortSignal,
): { ctx: ImportContext; skips: SkippedItem[]; progress: Partial<ImportProgress>[] } {
  const skips: SkippedItem[] = [];
  const progress: Partial<ImportProgress>[] = [];
  const ctx: ImportContext = {
    sourceId: 'src-folder',
    workDir: join(ROOT, '.work'),
    signal: signal ?? new AbortController().signal,
    deps,
    onSkip: (item) => skips.push(item),
    onProgress: (update) => progress.push(update),
  };
  return { ctx, skips, progress };
}

async function collect(
  ctx: ImportContext,
): Promise<{ records: CatalogRecord[]; result: ImportResult }> {
  const records: CatalogRecord[] = [];
  const result = await drainImporter(folderImporter, ROOT, ctx, (r) => records.push(r));
  return { records, result };
}

describe('folderImporter (card C1 — generic folder / cloud-download importer, AC-2)', () => {
  it('identifies itself as the folder source', () => {
    expect(folderImporter.id).toBe('folder');
    expect(folderImporter.displayName).toBeTypeOf('string');
    expect(folderImporter.displayName.length).toBeGreaterThan(0);
  });

  it('canHandle is true only for a directory (false for a file or a missing path)', async () => {
    const { deps } = makeDeps(buildFs({ 'a.jpg': {}, 'sub/b.png': {} }));
    expect(await folderImporter.canHandle(ROOT, deps)).toBe(true);
    expect(await folderImporter.canHandle(abs('sub'), deps)).toBe(true);
    expect(await folderImporter.canHandle(abs('a.jpg'), deps)).toBe(false);
    expect(await folderImporter.canHandle(abs('missing.jpg'), deps)).toBe(false);
  });

  it('canHandle accepts a symlinked directory when it is the selected import root', async () => {
    const root = makeTmpDir('folder-root-link');
    const realDir = join(root, 'real-dir');
    mkdirSync(realDir);
    const link = join(root, 'picked-root');
    symlinkSync(realDir, link, 'dir');
    try {
      const deps = createImporterDeps({
        extractArchive: unavailableExtractArchive,
        ffprobePath: '/bin/ffprobe',
      });

      await expect(folderImporter.canHandle(link, deps)).resolves.toBe(true);
    } finally {
      removeTmpDir(root);
    }
  });

  it('classifies media by extension, recurses, and references originals in place', async () => {
    const fs = buildFs({
      'photo.JPG': {},
      'clip.mp4': {},
      'voice.opus': {},
      'docs/report.pdf': {},
      'docs/nested/scan.tiff': {},
      'notes.txt': {},
      'edit.aae': {}, // iOS sidecar — not media
      '.DS_Store': {}, // no extension — not media
    });
    const c = makeContext(makeDeps(fs).deps);
    const { records, result } = await collect(c.ctx);
    const byRef = new Map(records.map((r) => [r.sourceRef, r]));

    expect([...byRef.keys()].sort()).toEqual([
      'clip.mp4',
      'docs/nested/scan.tiff',
      'docs/report.pdf',
      'notes.txt',
      'photo.JPG',
      'voice.opus',
    ]);
    expect(byRef.get('photo.JPG')?.mediaType).toBe('photo');
    expect(byRef.get('clip.mp4')?.mediaType).toBe('video');
    expect(byRef.get('voice.opus')?.mediaType).toBe('audio');
    expect(byRef.get('docs/report.pdf')?.mediaType).toBe('document');
    expect(byRef.get('notes.txt')?.mediaType).toBe('document');

    // In place: originalPath is the absolute file path (the orchestrator references it).
    expect(byRef.get('photo.JPG')?.originalPath).toBe(abs('photo.JPG'));
    expect(byRef.get('docs/nested/scan.tiff')?.originalPath).toBe(abs('docs/nested/scan.tiff'));
    expect(records.every((r) => r.sourceType === 'folder')).toBe(true);
    expect(byRef.get('photo.JPG')?.mimeType).toBe('image/jpeg');
    expect(byRef.get('docs/report.pdf')?.mimeType).toBe('application/pdf');

    // Non-media entries are skipped quietly — neither records nor reported failures.
    expect(result.recordCount).toBe(6);
    expect(result.skipped).toEqual([]);
    expect(c.skips).toEqual([]);
  });

  it('prefers the EXIF capture date and passes GPS + camera metadata through for photos', async () => {
    const takenAt = new Date('2019-06-15T10:20:30.000Z');
    const fs = buildFs({ 'trip/beach.jpg': { mtimeMs: Date.UTC(2023, 0, 1) } });
    const { deps, exifCalls } = makeDeps(fs, {
      byPath: {
        'trip/beach.jpg': {
          takenAt,
          gps: { lat: 12.5, lon: -70.1, alt: 3 },
          cameraMake: 'Apple',
          cameraModel: 'iPhone 12',
          width: 4032,
          height: 3024,
          orientation: 6,
        },
      },
    });

    const { records } = await collect(makeContext(deps).ctx);
    const rec = records[0];

    expect(rec?.date).toEqual({ value: takenAt, source: 'exif' });
    expect(rec?.gps).toEqual({ lat: 12.5, lon: -70.1, alt: 3 });
    expect(rec?.sourceRef).toBe('trip/beach.jpg');
    expect(rec?.author).toBeNull();
    expect(rec?.body).toBeNull();
    expect(rec?.sourceMeta).toMatchObject({
      cameraMake: 'Apple',
      cameraModel: 'iPhone 12',
      width: 4032,
      height: 3024,
      orientation: 6,
    });
    expect(exifCalls).toEqual([abs('trip/beach.jpg')]);
  });

  it('reports a partial-metadata skip when EXIF fails but still catalogs the photo', async () => {
    const fs = buildFs({ 'broken-exif.jpg': { mtimeMs: Date.UTC(2024, 0, 2) } });
    const { deps } = makeDeps(fs, { throwsFor: ['broken-exif.jpg'] });
    const c = makeContext(deps);

    const { records, result } = await collect(c.ctx);

    expect(records).toHaveLength(1);
    expect(records[0]?.sourceRef).toBe('broken-exif.jpg');
    expect(records[0]?.date?.source).toBe('mtime');
    expect(normalizeSkipReasons(result.skipped)).toContainEqual({
      ref: 'broken-exif.jpg',
      reason: 'partial metadata unavailable: exif fail /import-root/broken-exif.jpg',
      code: 'E_EXIF',
    });
    expect(c.skips).toEqual(result.skipped);
  });

  it('reports a partial-metadata skip when probing fails but still catalogs the video', async () => {
    const fs = buildFs({ 'broken-probe.mp4': { mtimeMs: Date.UTC(2024, 0, 2) } });
    const { deps } = makeDeps(fs, {}, { throwsFor: ['broken-probe.mp4'] });
    const c = makeContext(deps);

    const { records, result } = await collect(c.ctx);

    expect(records).toHaveLength(1);
    expect(records[0]?.sourceRef).toBe('broken-probe.mp4');
    expect(records[0]?.durationSec).toBeNull();
    expect(normalizeSkipReasons(result.skipped)).toContainEqual({
      ref: 'broken-probe.mp4',
      reason: 'partial metadata unavailable: probe fail /import-root/broken-probe.mp4',
      code: 'E_PROBE',
    });
    expect(c.skips).toEqual(result.skipped);
  });

  it('honors a pre-aborted signal without emitting a discover progress tick', async () => {
    const fs = buildFs({ 'photo.jpg': {} });
    const controller = new AbortController();
    controller.abort();
    const c = makeContext(makeDeps(fs).deps, controller.signal);

    const { records, result } = await collect(c.ctx);

    expect(records).toEqual([]);
    expect(result.recordCount).toBe(0);
    expect(c.progress).toEqual([]);
  });

  it('falls back to file mtime (mtime provenance) when EXIF carries no date', async () => {
    const mtimeMs = Date.UTC(2022, 2, 14, 8, 30);
    const fs = buildFs({ 'no-date.png': { mtimeMs } });
    const { deps } = makeDeps(fs, { byPath: { 'no-date.png': { cameraMake: 'Canon' } } });
    const { records } = await collect(makeContext(deps).ctx);

    expect(records[0]?.date).toEqual({ value: new Date(mtimeMs), source: 'mtime' });
    expect(records[0]?.gps).toBeNull();
  });

  it('treats EXIF GPS 0/0 as a no-location sentinel, not a real coordinate', async () => {
    const fs = buildFs({ 'sentinel.jpg': { mtimeMs: 1 } });
    const { deps } = makeDeps(fs, {
      byPath: {
        'sentinel.jpg': { gps: { lat: 0, lon: 0 } },
      },
    });

    const { records } = await collect(makeContext(deps).ctx);

    expect(records[0]?.gps).toBeNull();
  });

  it('treats an EXIF read failure as no-EXIF (mtime fallback), reports it, and never drops the photo', async () => {
    const mtimeMs = Date.UTC(2020, 10, 5);
    const fs = buildFs({ 'corrupt.heic': { mtimeMs } });
    const { deps } = makeDeps(fs, { throwsFor: ['corrupt.heic'] });
    const c = makeContext(deps);
    const { records, result } = await collect(c.ctx);

    expect(records).toHaveLength(1);
    expect(records[0]?.mediaType).toBe('photo');
    expect(records[0]?.date).toEqual({ value: new Date(mtimeMs), source: 'mtime' });
    expect(normalizeSkipReasons(result.skipped)).toContainEqual({
      ref: 'corrupt.heic',
      reason: 'partial metadata unavailable: exif fail /import-root/corrupt.heic',
      code: 'E_EXIF',
    });
    expect(c.skips).toEqual(result.skipped);
  });

  it('reads duration via probeMedia for audio/video and prefers the probed mime', async () => {
    const fs = buildFs({ 'clip.mov': {}, 'note.m4a': {} });
    const { deps, probeCalls, exifCalls } = makeDeps(
      fs,
      {},
      {
        byPath: {
          'clip.mov': { durationSec: 42.5, width: 1920, height: 1080, mimeType: 'video/quicktime' },
          'note.m4a': { durationSec: 12, width: null, height: null, mimeType: 'audio/mp4' },
        },
      },
    );
    const { records } = await collect(makeContext(deps).ctx);
    const byRef = new Map(records.map((r) => [r.sourceRef, r]));

    expect(byRef.get('clip.mov')?.durationSec).toBe(42.5);
    expect(byRef.get('clip.mov')?.mimeType).toBe('video/quicktime');
    expect(byRef.get('clip.mov')?.sourceMeta).toMatchObject({ width: 1920, height: 1080 });
    expect(byRef.get('note.m4a')?.durationSec).toBe(12);
    expect(byRef.get('note.m4a')?.mediaType).toBe('audio');
    // EXIF is image-only — timed media is probed, never exif-read.
    expect(probeCalls.sort()).toEqual([abs('clip.mov'), abs('note.m4a')]);
    expect(exifCalls).toEqual([]);
  });

  it('keeps a video record with null duration and reports the partial metadata when probeMedia fails', async () => {
    const fs = buildFs({ 'broken.mp4': { mtimeMs: 7 } });
    const { deps } = makeDeps(fs, {}, { throwsFor: ['broken.mp4'] });
    const c = makeContext(deps);
    const { records, result } = await collect(c.ctx);

    expect(records).toHaveLength(1);
    expect(records[0]?.durationSec).toBeNull();
    expect(records[0]?.mimeType).toBe('video/mp4'); // falls back to the extension mime
    expect(normalizeSkipReasons(result.skipped)).toContainEqual({
      ref: 'broken.mp4',
      reason: 'partial metadata unavailable: probe fail /import-root/broken.mp4',
      code: 'E_PROBE',
    });
  });

  it('honors a pre-aborted signal — emits nothing and returns a zero-count result', async () => {
    const controller = new AbortController();
    controller.abort();
    const { deps } = makeDeps(buildFs({ 'a.jpg': {}, 'b.jpg': {}, 'c.jpg': {} }));
    const { records, result } = await collect(makeContext(deps, controller.signal).ctx);

    expect(records).toEqual([]);
    expect(result.recordCount).toBe(0);
    expect(result.skipped).toEqual([]);
  });

  it('stops discovery once the signal aborts mid-stream', async () => {
    const controller = new AbortController();
    const { deps } = makeDeps(buildFs({ 'a.jpg': {}, 'b.jpg': {}, 'c.jpg': {} }));
    const gen = folderImporter.import(ROOT, makeContext(deps, controller.signal).ctx);

    const first = await gen.next();
    expect(first.done).toBe(false);
    controller.abort();
    const next = await gen.next();

    expect(next.done).toBe(true);
    if (next.done) {
      expect(next.value.recordCount).toBe(1);
    }
  });

  it('reports an unreadable file via onSkip without aborting the run (AC-15)', async () => {
    const fs = buildFs(
      { 'good.jpg': { mtimeMs: 1 }, 'locked.jpg': {}, 'after.png': { mtimeMs: 2 } },
      { statErrors: ['locked.jpg'] },
    );
    const c = makeContext(makeDeps(fs).deps);
    const { records, result } = await collect(c.ctx);

    expect(records.map((r) => r.sourceRef).sort()).toEqual(['after.png', 'good.jpg']);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.ref).toBe('locked.jpg');
    expect(result.skipped[0]?.code).toBe('E_STAT');
    expect(c.skips.map((s) => s.ref)).toEqual(['locked.jpg']);
  });

  it('reports an unreadable subdirectory and still imports the rest of the tree', async () => {
    const fs = buildFs(
      { 'top.jpg': { mtimeMs: 1 }, 'locked/secret.jpg': {} },
      { readDirErrors: ['locked'] },
    );
    const c = makeContext(makeDeps(fs).deps);
    const { records, result } = await collect(c.ctx);

    expect(records.map((r) => r.sourceRef)).toEqual(['top.jpg']);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.ref).toBe('locked');
    expect(result.skipped[0]?.code).toBe('E_READDIR');
  });

  it('emits a discovery update and one emit update per record', async () => {
    const c = makeContext(makeDeps(buildFs({ 'a.jpg': {}, 'b.jpg': {} })).deps);
    await collect(c.ctx);

    expect(c.progress[0]?.phase).toBe('discover');
    const emits = c.progress.filter((p) => p.phase === 'emit');
    expect(emits).toHaveLength(2);
    expect(emits.at(-1)?.processed).toBe(2);
  });
});
