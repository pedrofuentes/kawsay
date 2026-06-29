import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drainImporter } from '../../electron/main/importers/drain';
import {
  linkedinImporter,
  parseLinkedInDate,
} from '../../electron/main/importers/linkedin-importer';
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

// LinkedIn exports ship as a zip of CSV files. Real ones are messy: quoted
// fields with embedded commas and newlines, a UTF-8 BOM, a free-text "Notes:"
// preamble before Connections.csv's header, and non-ASCII names that are genuine
// UTF-8 (NOT the Facebook mojibake). These fixtures capture that shape so the
// importer is proven to recover faithful rows (AC-16) and never drop a memory.
function liFixture(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../fixtures/linkedin/${rel}`, import.meta.url)),
    'utf8',
  );
}
const MESSAGES = liFixture('messages.csv');
const CONNECTIONS = liFixture('Connections.csv');
const RICH_MEDIA = liFixture('Rich_Media.csv');

const WORK = '/work/linkedin';

interface ArchiveEntry {
  entryPath: string;
  content?: string;
}

// A zip-backed deps double mirroring the guarded SafeExtractFn: extractArchive
// returns each entry at an absPath under workDir and registers its bytes so the
// importer's fs.readFile resolves.
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

// A nested in-memory folder (a LinkedIn export the user already extracted). The
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
    sourceId: 'src-linkedin',
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
  const result = await drainImporter(linkedinImporter, inputPath, c.ctx, (r) => records.push(r));
  return { records, result, skips: c.skips, progress: c.progress };
}

// The full, real-shaped export: a message thread (with a quoted comma message and
// a quoted multi-line message), a connection list (BOM + "Notes:" preamble +
// quoted commas), and a rich-media link list — plus a single malformed message row.
const FULL_ENTRIES: ArchiveEntry[] = [
  { entryPath: 'messages.csv', content: MESSAGES },
  { entryPath: 'Connections.csv', content: CONNECTIONS },
  { entryPath: 'Rich_Media.csv', content: RICH_MEDIA },
];
const ZIP = '/drop/linkedin-jose.zip';

describe('linkedinImporter (card C5 — LinkedIn CSV export, AC-16)', () => {
  it('identifies itself as the linkedin source', () => {
    expect(linkedinImporter.id).toBe('linkedin');
    expect(linkedinImporter.displayName).toBeTypeOf('string');
    expect(linkedinImporter.displayName.length).toBeGreaterThan(0);
  });

  describe('canHandle discriminates LinkedIn from Facebook and unknown', () => {
    it('accepts a zip whose central directory carries LinkedIn markers', async () => {
      const dir = makeTmpDir('li-can-handle-');
      const archive = join(dir, 'li.zip');
      writeFileSync(archive, buildZip([{ name: 'Rich_Media.csv' }]));
      const deps = makeZipDeps([]).deps;
      deps.fs.readFile = async () => {
        throw new Error('canHandle must not materialize zip bytes');
      };
      try {
        expect(await linkedinImporter.canHandle(archive, deps)).toBe(true);
      } finally {
        removeTmpDir(dir);
      }
    });

    it('rejects a Facebook zip and an unrelated zip', async () => {
      const dir = makeTmpDir('li-negative-can-handle-');
      const facebookArchive = join(dir, 'facebook.zip');
      const unrelatedArchive = join(dir, 'unrelated.zip');
      writeFileSync(facebookArchive, buildZip([{ name: 'posts/your_posts_1.json' }]));
      writeFileSync(unrelatedArchive, buildZip([{ name: 'Takeout/index.html' }]));
      try {
        expect(await linkedinImporter.canHandle(facebookArchive, makeZipDeps([]).deps)).toBe(false);
        expect(await linkedinImporter.canHandle(unrelatedArchive, makeZipDeps([]).deps)).toBe(
          false,
        );
      } finally {
        removeTmpDir(dir);
      }
    });

    it('accepts a folder that contains the LinkedIn layout', async () => {
      const deps = makeFolderDeps('/export/li', { 'Connections.csv': CONNECTIONS });
      expect(await linkedinImporter.canHandle('/export/li', deps)).toBe(true);
      const plain = makeFolderDeps('/export/plain', { 'data.csv': 'a,b\n1,2\n' });
      expect(await linkedinImporter.canHandle('/export/plain', plain)).toBe(false);
    });
  });

  describe('full import over the export zip', () => {
    it('yields early CSV records before reporting malformed rows later in the file', async () => {
      const content = 'Content,From,Date\nhello,Ana,2024-03-15 09:30:00 UTC\n,,\n';
      const c = makeContext(makeZipDeps([{ entryPath: 'messages.csv', content }]).deps);
      const iterator = linkedinImporter.import(ZIP, c.ctx);

      const first = await iterator.next();

      expect(first.done).toBe(false);
      if (first.done) throw new Error('expected first LinkedIn record');
      expect(first.value.body).toBe('hello');
      expect(c.skips).toEqual([]);
      await iterator.return?.({ recordCount: 1, skipped: [] });
    });

    it('emits one record per memory and reports the malformed row (AC-15)', async () => {
      const { records, result, skips } = await run(ZIP, makeZipDeps(FULL_ENTRIES).deps);

      // 2 messages + 2 connections + 1 rich-media link = 5; the BADROW is reported.
      expect(records).toHaveLength(5);
      expect(result.recordCount).toBe(5);
      expect(records.every((r) => r.sourceType === 'linkedin')).toBe(true);
      expect(skips.filter((s) => s.code === 'E_PARSE')).toHaveLength(1);
      expect(result.skipped.filter((s) => s.code === 'E_PARSE')).toHaveLength(1);
    });

    it('parses a message, preserving an embedded comma and the UTC timestamp', async () => {
      const { records } = await run(ZIP, makeZipDeps(FULL_ENTRIES).deps);
      const msg = records.find((r) => r.author === 'Ana Lopez');

      expect(msg?.mediaType).toBe('message');
      expect(msg?.originalPath).toBeNull();
      expect(msg?.body).toBe("Hey Pedro, let's grab coffee, maybe Tuesday?");
      expect(msg?.date?.source).toBe('message');
      expect(msg?.date?.value.getTime()).toBe(Date.UTC(2024, 2, 15, 9, 30, 0));
      expect(msg?.sourceMeta.subject).toBe('Coffee?');
    });

    it('preserves a quoted multi-line message body verbatim (no row smearing)', async () => {
      const { records } = await run(ZIP, makeZipDeps(FULL_ENTRIES).deps);
      const msg = records.find(
        (r) => r.author === 'Pedro Fuentes' && r.sourceMeta.kind === 'message',
      );

      expect(msg?.body).toBe('Sounds great!\nTuesday at 3pm works.');
      expect(msg?.date?.value.getTime()).toBe(Date.UTC(2024, 2, 15, 10, 0, 0));
    });

    it('parses a connection past the BOM + "Notes:" preamble, keeping a quoted comma', async () => {
      const { records, skips } = await run(ZIP, makeZipDeps(FULL_ENTRIES).deps);
      const jose = records.find((r) => r.author === 'José García');

      // Genuine UTF-8 name survives (LinkedIn is NOT mojibake — never re-decode it).
      expect(jose).toBeDefined();
      expect(jose?.mediaType).toBe('message');
      expect(jose?.body).toBe('Senior Engineer at Acme, Inc.');
      expect(jose?.date?.value.getTime()).toBe(Date.UTC(2024, 0, 15));
      expect(jose?.sourceMeta.kind).toBe('connection');
      expect(jose?.sourceMeta.company).toBe('Acme, Inc.');
      expect(jose?.sourceMeta.position).toBe('Senior Engineer');
      // The preamble lines are expected scaffolding, not errors.
      expect(skips.some((s) => s.ref.includes('Connections.csv') && s.code === 'E_PARSE')).toBe(
        false,
      );
    });

    it('parses a second connection with a comma inside the position field', async () => {
      const { records } = await run(ZIP, makeZipDeps(FULL_ENTRIES).deps);
      const aesop = records.find((r) => r.author === 'Æsop Fontaine');

      expect(aesop?.body).toBe('Director, Operations at Globex');
      expect(aesop?.date?.value.getTime()).toBe(Date.UTC(2024, 1, 3));
    });

    it('maps a rich-media link with its capture time', async () => {
      const { records } = await run(ZIP, makeZipDeps(FULL_ENTRIES).deps);
      const media = records.find((r) => r.sourceMeta.kind === 'rich_media');

      expect(media).toBeDefined();
      expect(media?.body).toContain('urn:li:activity:7123');
      expect(media?.date?.value.getTime()).toBe(Date.UTC(2024, 1, 1, 12, 0, 0));
    });
  });

  describe('folder import (extracted in place)', () => {
    it('produces the same connection records reading the CSVs in place', async () => {
      const root = '/export/li';
      const deps = makeFolderDeps(root, { 'Connections.csv': CONNECTIONS });
      const { records } = await run(root, deps);

      expect(records.find((r) => r.author === 'José García')).toBeDefined();
      expect(records.find((r) => r.author === 'Æsop Fontaine')).toBeDefined();
    });
  });

  describe('robustness — reported, never thrown (AC-15)', () => {
    it('reports E_EXTRACT and completes when extractArchive throws (corrupt/locked zip)', async () => {
      const { deps } = makeZipDeps([]);
      deps.extractArchive = () => Promise.reject(new Error('EBUSY: archive is locked'));

      const { records, result, skips } = await run('/drop/corrupt.zip', deps);

      expect(records).toEqual([]);
      expect(result.recordCount).toBe(0);
      expect(result.skipped.some((s) => s.code === 'E_EXTRACT')).toBe(true);
      expect(skips.some((s) => s.code === 'E_EXTRACT')).toBe(true);
    });

    it('skips an unreadable CSV and keeps every other file intact', async () => {
      const { deps } = makeZipDeps(FULL_ENTRIES);
      const realReadFile = deps.fs.readFile;
      deps.fs.readFile = (path: string) =>
        path.endsWith('messages.csv')
          ? Promise.reject(new Error('EACCES: permission denied'))
          : realReadFile(path);

      const { records, skips } = await run(ZIP, deps);

      // The 2 message records are gone; 2 connections + 1 rich-media remain.
      expect(records).toHaveLength(3);
      expect(skips.some((s) => s.code === 'E_READ')).toBe(true);
    });

    it('reports E_PARSE for an unreadable malformed CSV and keeps going', async () => {
      const entries: ArchiveEntry[] = [
        { entryPath: 'messages.csv', content: 'Content,From\n"unterminated,Ana\n' },
        { entryPath: 'Connections.csv', content: CONNECTIONS },
      ];
      const { records, skips } = await run(ZIP, makeZipDeps(entries).deps);

      expect(skips).toContainEqual(
        expect.objectContaining({ ref: 'messages.csv', code: 'E_PARSE' }),
      );
      expect(records.find((r) => r.author === 'José García')).toBeDefined();
    });

    it('reports E_PARSE for a CSV with no recognizable header and keeps going', async () => {
      const entries: ArchiveEntry[] = [
        { entryPath: 'messages.csv', content: 'just,some\npreamble,lines\n' },
        { entryPath: 'Connections.csv', content: CONNECTIONS },
      ];
      const { records, skips } = await run(ZIP, makeZipDeps(entries).deps);

      expect(skips.some((s) => s.ref.includes('messages.csv') && s.code === 'E_PARSE')).toBe(true);
      // The good file still imports.
      expect(records.find((r) => r.author === 'José García')).toBeDefined();
    });

    it('KEEPS a message with unparseable date (date null) — never silently dropped', async () => {
      const odd = 'FROM,DATE,CONTENT\r\n' + 'Sam,not-a-date,"Hello there, friend"\r\n';
      const entries: ArchiveEntry[] = [{ entryPath: 'messages.csv', content: odd }];
      const { records, skips } = await run(ZIP, makeZipDeps(entries).deps);

      const msg = records.find((r) => r.author === 'Sam');
      expect(msg).toBeDefined();
      expect(msg?.body).toBe('Hello there, friend');
      expect(msg?.date).toBeNull();
      expect(skips.filter((s) => s.code === 'E_PARSE')).toHaveLength(0);
    });

    it('treats impossible date components as unparseable instead of normalising them', () => {
      expect(parseLinkedInDate('2024-13-01')).toBeNull();
      expect(parseLinkedInDate('2024-02-30')).toBeNull();
      expect(parseLinkedInDate('32 Jan 2024')).toBeNull();
      expect(parseLinkedInDate('Jan 32, 2024')).toBeNull();
      expect(parseLinkedInDate('13/32/2024')).toBeNull();
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
      const gen = linkedinImporter.import(ZIP, c.ctx);

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
        expect(next.value.recordCount).toBeGreaterThanOrEqual(1);
        expect(next.value.recordCount).toBeLessThan(5);
      }
    });

    it('emits a discover update and one emit update per record', async () => {
      const { progress, records } = await run(ZIP, makeZipDeps(FULL_ENTRIES).deps);
      expect(progress[0]?.phase).toBe('discover');
      expect(progress.filter((p) => p.phase === 'emit')).toHaveLength(records.length);
    });
  });
});
