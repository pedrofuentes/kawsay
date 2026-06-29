import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type * as Yauzl from 'yauzl';
import type { ImporterDeps } from '../../electron/main/importers/types';
import { buildZip } from '../helpers/zip';
import { makeTmpDir, removeTmpDir } from '../helpers/tmp';

vi.mock('yauzl', async (importOriginal) => {
  const actual = await importOriginal<typeof Yauzl>();
  return {
    ...actual,
    openPromise: vi.fn(actual.openPromise),
  };
});

function deps(): ImporterDeps {
  return {
    fs: {
      readFile: async () => Buffer.alloc(0),
      readDir: async () => [],
      stat: async () => ({
        size: 0,
        mtimeMs: 0,
        isFile: () => true,
        isDirectory: () => false,
      }),
      exists: async () => true,
    },
    extractArchive: async () => [],
    readExif: async () => null,
    probeMedia: async () => ({ durationSec: null, width: null, height: null, mimeType: null }),
    hashFile: async () => 'deadbeef',
  };
}

describe('importer registry — zip auto-detect cache (#94)', () => {
  it('opens a dropped large .zip once across all importer probes and still routes by late markers', async () => {
    const yauzl = await import('yauzl');
    const { selectImporter } = await import('../../electron/main/importers/registry');
    const { takeoutImporter } = await import('../../electron/main/importers/takeout-importer');
    const openPromise = vi.mocked(yauzl.openPromise);
    openPromise.mockClear();
    const dir = makeTmpDir('registry-large-takeout-');
    const zip = join(dir, 'takeout-large.zip');
    writeFileSync(
      zip,
      buildZip([
        { name: 'misc/readme.txt' },
        { name: 'Takeout/archive_browser.html', declaredUncompressedSize: 0x80000000 },
      ]),
    );

    try {
      expect(await selectImporter(zip, deps())).toBe(takeoutImporter);
      expect(openPromise).toHaveBeenCalledTimes(1);
    } finally {
      removeTmpDir(dir);
    }
  });

  it('bounds the shared zip-entry cache by evicting the oldest opened archives', async () => {
    const yauzl = await import('yauzl');
    const { selectImporter } = await import('../../electron/main/importers/registry');
    const { takeoutImporter } = await import('../../electron/main/importers/takeout-importer');
    const openPromise = vi.mocked(yauzl.openPromise);
    openPromise.mockClear();
    const dir = makeTmpDir('registry-zip-cache-bound-');
    const zips = Array.from({ length: 33 }, (_, index) => join(dir, `takeout-${index}.zip`));

    try {
      for (const zip of zips) {
        writeFileSync(zip, buildZip([{ name: 'Takeout/archive_browser.html' }]));
        expect(await selectImporter(zip, deps())).toBe(takeoutImporter);
      }
      expect(openPromise).toHaveBeenCalledTimes(33);

      expect(await selectImporter(zips[0], deps())).toBe(takeoutImporter);
      expect(openPromise).toHaveBeenCalledTimes(34);
    } finally {
      removeTmpDir(dir);
    }
  });
});
