import { describe, expect, it } from 'vitest';
import { importers, selectImporter } from '../../electron/main/importers/registry';
import { folderImporter } from '../../electron/main/importers/folder-importer';
import { whatsappImporter } from '../../electron/main/importers/whatsapp-importer';
import type { ImporterDeps } from '../../electron/main/importers/types';

// A deps double whose fs makes a path look like a directory and/or a zip that
// carries the WhatsApp `_chat.txt` central-directory marker — enough to drive
// each concrete importer's real `canHandle` predicate without touching disk.
function fakeDeps(options: { dirs?: Set<string>; zipMarkers?: Record<string, string> } = {}): ImporterDeps {
  const dirs = options.dirs ?? new Set<string>();
  const zipMarkers = options.zipMarkers ?? {};
  return {
    fs: {
      readFile: async (path: string) => Buffer.from(zipMarkers[path] ?? ''),
      readDir: async () => [],
      stat: async (path: string) => ({
        size: 0,
        mtimeMs: 0,
        isFile: () => !dirs.has(path),
        isDirectory: () => dirs.has(path),
      }),
      exists: async () => true,
    },
    extractArchive: async () => [],
    readExif: async () => null,
    probeMedia: async () => ({ durationSec: null, width: null, height: null, mimeType: null }),
    hashFile: async () => 'deadbeef',
  };
}

describe('importer registry (ARCHITECTURE §3.4)', () => {
  it('exposes the concrete importers currently on main, in order', () => {
    expect(importers).toEqual([folderImporter, whatsappImporter]);
  });

  it('is a frozen, ordered list (registration order is the resolution order)', () => {
    expect(importers[0]?.id).toBe('folder');
    expect(importers[1]?.id).toBe('whatsapp');
  });

  it('selectImporter picks the folder importer for a directory', async () => {
    const deps = fakeDeps({ dirs: new Set(['/memories/photos']) });
    const chosen = await selectImporter('/memories/photos', deps);
    expect(chosen).toBe(folderImporter);
  });

  it('selectImporter picks the WhatsApp importer for an export .zip carrying _chat.txt', async () => {
    const deps = fakeDeps({ zipMarkers: { '/dl/WhatsApp Chat - Mum.zip': 'PK\u0003\u0004_chat.txt' } });
    const chosen = await selectImporter('/dl/WhatsApp Chat - Mum.zip', deps);
    expect(chosen).toBe(whatsappImporter);
  });

  it('selectImporter returns undefined when no importer can handle the path', async () => {
    const deps = fakeDeps();
    const chosen = await selectImporter('/dl/mystery.bin', deps);
    expect(chosen).toBeUndefined();
  });

  it('selectImporter returns undefined for a .zip that is not a WhatsApp export', async () => {
    const deps = fakeDeps({ zipMarkers: { '/dl/random.zip': 'PK\u0003\u0004just-some-files' } });
    const chosen = await selectImporter('/dl/random.zip', deps);
    expect(chosen).toBeUndefined();
  });
});
