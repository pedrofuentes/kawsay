import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { createLibrary, openLibrary } from '../../electron/main/library/library-service';
import { openCatalog } from '../../electron/main/db/connection';
import { createCatalogRepo } from '../../electron/main/db/catalog-repo';
import { makeTmpDir, removeTmpDir } from '../helpers/tmp';

const LAYOUT_DIRS = [
  'originals',
  'derived/thumbnails',
  'derived/posters',
  'derived/waveforms',
  'extract',
  'logs',
];

describe('library lifecycle (ADR-0008 layout)', () => {
  let base: string;
  beforeEach(() => {
    base = makeTmpDir('library');
  });
  afterEach(() => removeTmpDir(base));

  it('createLibrary builds the self-contained ADR-0008 folder layout', () => {
    const root = join(base, "Mum's Library");
    const summary = createLibrary({ root, personName: 'Mum' });

    for (const dir of LAYOUT_DIRS) {
      expect(statSync(join(root, dir)).isDirectory()).toBe(true);
    }
    expect(existsSync(join(root, 'catalog.sqlite3'))).toBe(true);
    expect(existsSync(join(root, 'library.json'))).toBe(true);

    expect(summary.name).toBe('Mum');
    expect(summary.schemaVersion).toBe(2);
    expect(summary.catalogPath).toBe(join(root, 'catalog.sqlite3'));
    // createdAt is a canonical ISO-8601 UTC instant.
    expect(new Date(summary.createdAt).toISOString()).toBe(summary.createdAt);
  });

  it('writes a manifest that openLibrary reads back', () => {
    const root = join(base, 'lib-a');
    const created = createLibrary({ root, personName: 'Abuela' });
    const manifest = JSON.parse(readFileSync(join(root, 'library.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(manifest).toMatchObject({ app: 'kawsay', name: 'Abuela', schemaVersion: 2 });

    const opened = openLibrary({ root });
    expect(opened.name).toBe('Abuela');
    expect(opened.schemaVersion).toBe(2);
    expect(opened.createdAt).toBe(created.createdAt);
  });

  it('produces a migrated, writable catalog', () => {
    const root = join(base, 'lib-b');
    createLibrary({ root });
    const db = openCatalog(join(root, 'catalog.sqlite3'));
    try {
      const repo = createCatalogRepo(db);
      const id = repo.insertItem({ mediaType: 'photo', contentHash: 'h' });
      expect(typeof id).toBe('string');
      expect(Number(db.pragma('user_version', { simple: true }))).toBe(2);
    } finally {
      db.close();
    }
  });

  it('defaults the library name to the folder when no person name is given', () => {
    const root = join(base, 'Recuerdos');
    expect(createLibrary({ root }).name).toBe('Recuerdos');
  });

  it('refuses a relative root (never write outside an absolute library path)', () => {
    expect(isAbsolute('relative/lib')).toBe(false);
    expect(() => createLibrary({ root: 'relative/lib' })).toThrow();
    expect(() => openLibrary({ root: 'relative/lib' })).toThrow();
  });

  it('refuses to clobber an existing library', () => {
    const root = join(base, 'lib-c');
    createLibrary({ root });
    expect(() => createLibrary({ root })).toThrow();
  });

  it('refuses to open a folder that is not a Kawsay library', () => {
    const missing = join(base, 'does-not-exist');
    expect(() => openLibrary({ root: missing })).toThrow();

    const emptyDir = join(base, 'empty-dir');
    mkdirSync(emptyDir);
    expect(() => openLibrary({ root: emptyDir })).toThrow();
  });
});
