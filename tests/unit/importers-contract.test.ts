import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { drainImporter } from '../../electron/main/importers/drain';
import type {
  CatalogRecord,
  ImportContext,
  ImportProgress,
  Importer,
  ImporterDeps,
  SkippedItem,
} from '../../electron/main/importers/types';

function makeDeps(hashCalls: string[]): ImporterDeps {
  return {
    fs: {
      readFile: async () => Buffer.from(''),
      readDir: async () => [],
      stat: async () => ({ size: 0, mtimeMs: 0, isFile: () => true, isDirectory: () => false }),
      exists: async () => true,
    },
    extractArchive: async () => [],
    readExif: async () => null,
    probeMedia: async () => ({ durationSec: null, width: null, height: null, mimeType: null }),
    hashFile: async (path: string) => {
      hashCalls.push(path);
      return 'deadbeef';
    },
  };
}

function makeContext(signal?: AbortSignal): {
  ctx: ImportContext;
  skips: SkippedItem[];
  progress: Partial<ImportProgress>[];
  hashCalls: string[];
} {
  const skips: SkippedItem[] = [];
  const progress: Partial<ImportProgress>[] = [];
  const hashCalls: string[] = [];
  const ctx: ImportContext = {
    sourceId: 'src-1',
    workDir: '/work/src-1',
    signal: signal ?? new AbortController().signal,
    deps: makeDeps(hashCalls),
    onSkip: (skipped) => skips.push(skipped),
    onProgress: (update) => progress.push(update),
  };
  return { ctx, skips, progress, hashCalls };
}

// A connector-shaped fake (NO real connector — those are cards C1–C5). It emits
// two records, skips one unreadable entry without aborting (AC-15), exercises
// the injected hashFile (the DI seam), reports progress, and honors cancellation.
const fakeImporter: Importer = {
  id: 'folder',
  displayName: 'Folder',
  async canHandle(inputPath, deps) {
    return typeof inputPath === 'string' && typeof deps.hashFile === 'function';
  },
  async *import(inputPath, ctx) {
    const entries = [
      { ref: 'a.jpg', ok: true },
      { ref: 'broken.heic', ok: false },
      { ref: 'b.png', ok: true },
    ];
    let recordCount = 0;
    const skipped: SkippedItem[] = [];
    for (const [index, entry] of entries.entries()) {
      if (ctx.signal.aborted) break;
      ctx.onProgress({ phase: 'emit', processed: index, total: entries.length });
      if (!entry.ok) {
        const item: SkippedItem = { ref: entry.ref, reason: 'unreadable', code: 'E_DECODE' };
        ctx.onSkip(item);
        skipped.push(item);
        continue;
      }
      const absPath = join(inputPath, entry.ref);
      const hash = await ctx.deps.hashFile(absPath);
      recordCount += 1;
      const record: CatalogRecord = {
        sourceType: 'folder',
        mediaType: 'photo',
        originalPath: absPath,
        mimeType: 'image/jpeg',
        date: { value: new Date('2020-01-01T00:00:00.000Z'), source: 'exif' },
        author: null,
        body: null,
        gps: null,
        durationSec: null,
        sourceRef: entry.ref,
        sourceMeta: { hash },
      };
      yield record;
    }
    return { recordCount, skipped };
  },
};

describe('Importer contract (ARCHITECTURE §3.1)', () => {
  it('drains an importer to its ImportResult, collecting every emitted record', async () => {
    const { ctx, skips, progress, hashCalls } = makeContext();
    const records: CatalogRecord[] = [];

    const result = await drainImporter(fakeImporter, '/input', ctx, (record) => records.push(record));

    expect(records.map((r) => r.sourceRef)).toEqual(['a.jpg', 'b.png']);
    expect(records[0]?.date?.source).toBe('exif');
    expect(result.recordCount).toBe(2);
    // AC-15: a partial failure is reported as a skip, never thrown to abort the run.
    expect(result.skipped.map((s) => s.ref)).toEqual(['broken.heic']);
    expect(skips.map((s) => s.code)).toEqual(['E_DECODE']);
    // The DI seam: the importer used the injected hasher, not a hard-coded one.
    expect(hashCalls).toEqual([join('/input', 'a.jpg'), join('/input', 'b.png')]);
    expect(progress).toHaveLength(3);
  });

  it('exposes a canHandle predicate driven by the injected deps', async () => {
    const { ctx } = makeContext();
    expect(await fakeImporter.canHandle('/input', ctx.deps)).toBe(true);
  });

  it('honors an aborted signal — emits nothing and reports a zero-count result', async () => {
    const controller = new AbortController();
    controller.abort();
    const { ctx } = makeContext(controller.signal);
    const records: CatalogRecord[] = [];

    const result = await drainImporter(fakeImporter, '/input', ctx, (record) => records.push(record));

    expect(records).toEqual([]);
    expect(result.recordCount).toBe(0);
    expect(result.skipped).toEqual([]);
  });
});
