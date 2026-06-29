import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { access, readdir, stat } from 'node:fs/promises';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { importers, selectImporter } from '../../electron/main/importers/registry';
import { folderImporter } from '../../electron/main/importers/folder-importer';
import { whatsappImporter } from '../../electron/main/importers/whatsapp-importer';
import { takeoutImporter } from '../../electron/main/importers/takeout-importer';
import { facebookImporter } from '../../electron/main/importers/facebook-importer';
import { linkedinImporter } from '../../electron/main/importers/linkedin-importer';
import { imessageImporter } from '../../electron/main/importers/imessage-importer';
import type { ImporterDeps } from '../../electron/main/importers/types';
import { buildZip } from '../helpers/zip';
import { makeTmpDir, removeTmpDir } from '../helpers/tmp';

interface FakeFsOptions {
  /** Paths whose `stat().isDirectory()` reports a directory. */
  dirs?: Iterable<string>;
  /** Paths `exists()` reports present — marker files/subdirs and standalone `.mbox`. */
  files?: Iterable<string>;
  /** Top-level entry names returned by `readDir(dirPath)`. */
  entries?: Record<string, readonly string[]>;
  /** Verbatim bytes returned by `readFile(path)` — the zip central-directory scan seam. */
  zipMarkers?: Record<string, string>;
}

function realDirDeps(): ImporterDeps {
  return {
    fs: {
      readFile: async () => Buffer.from(''),
      readDir: readdir,
      stat,
      exists: async (path: string) =>
        access(path).then(
          () => true,
          () => false,
        ),
    },
    extractArchive: async () => [],
    readExif: async () => null,
    probeMedia: async () => ({ durationSec: null, width: null, height: null, mimeType: null }),
    hashFile: async () => 'deadbeef',
  };
}

function createMinimalMessagesDb(root: string): void {
  mkdirSync(join(root, 'Attachments'), { recursive: true });
  const db = new Database(join(root, 'chat.db'));
  try {
    db.exec(`
      CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
      CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, display_name TEXT);
      CREATE TABLE message (ROWID INTEGER PRIMARY KEY, text TEXT, date INTEGER, is_from_me INTEGER, handle_id INTEGER, service TEXT);
      CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
    `);
  } finally {
    db.close();
  }
}

/**
 * A deps double that drives each concrete importer's REAL `canHandle` predicate
 * from in-memory fixtures: directory-ness (`stat`), discriminating marker
 * presence (`exists`), the top-level listing (`readDir`), and a zip's
 * central-directory bytes (`readFile`).
 *
 * `exists` defaults to ABSENT, so a directory only resolves to a *specific*
 * connector when its discriminating marker is explicitly present — otherwise the
 * generic folder importer (which claims any directory) is the catch-all. This is
 * what makes the precedence assertions below meaningful rather than accidental.
 */
function fakeDeps(options: FakeFsOptions = {}): ImporterDeps {
  const dirs = new Set(options.dirs ?? []);
  const files = new Set(options.files ?? []);
  const entries = options.entries ?? {};
  const zipMarkers = options.zipMarkers ?? {};
  return {
    fs: {
      readFile: async (path: string) => Buffer.from(zipMarkers[path] ?? ''),
      readDir: async (path: string) => entries[path] ?? [],
      stat: async (path: string) => ({
        size: 0,
        mtimeMs: 0,
        isFile: () => !dirs.has(path),
        isDirectory: () => dirs.has(path),
      }),
      exists: async (path: string) => files.has(path) || dirs.has(path),
    },
    extractArchive: async () => [],
    readExif: async () => null,
    probeMedia: async () => ({ durationSec: null, width: null, height: null, mimeType: null }),
    hashFile: async () => 'deadbeef',
  };
}

describe('importer registry — composition & resolution order (ARCHITECTURE §3.4)', () => {
  it('wires every concrete connector in, specific-first with folder as the catch-all', () => {
    expect(importers).toEqual([
      whatsappImporter,
      facebookImporter,
      linkedinImporter,
      imessageImporter,
      takeoutImporter,
      folderImporter,
    ]);
  });

  it('lists the generic folder importer LAST so it never shadows a specific connector', () => {
    expect(importers.map((importer) => importer.id)).toEqual([
      'whatsapp',
      'facebook',
      'linkedin',
      'imessage',
      'google_takeout',
      'folder',
    ]);
    expect(importers[importers.length - 1]).toBe(folderImporter);
  });

  it('routes a macOS Messages chat.db folder to the iMessage/SMS importer (not folder)', async () => {
    const dir = makeTmpDir('registry-imessage-');
    try {
      createMinimalMessagesDb(dir);
      const chosen = await selectImporter(dir, realDirDeps());
      expect(chosen).toBe(imessageImporter);
      expect(chosen).not.toBe(folderImporter);
    } finally {
      removeTmpDir(dir);
    }
  });

  it('routes an unpacked WhatsApp export folder to the WhatsApp importer (not folder)', async () => {
    const dir = '/imp/whatsapp-export';
    const deps = fakeDeps({
      dirs: [dir],
      files: [join(dir, '_chat.txt')],
      entries: { [dir]: ['_chat.txt', 'IMG-001.jpg'] },
    });
    const chosen = await selectImporter(dir, deps);
    expect(chosen).toBe(whatsappImporter);
    expect(chosen).not.toBe(folderImporter);
  });

  it('routes a WhatsApp export .zip carrying _chat.txt to the WhatsApp importer', async () => {
    const dir = makeTmpDir('registry-wa-');
    const zip = join(dir, 'WhatsApp Chat - Mum.zip');
    writeFileSync(zip, buildZip([{ name: '_chat.txt' }]));
    try {
      expect(await selectImporter(zip, fakeDeps())).toBe(whatsappImporter);
    } finally {
      removeTmpDir(dir);
    }
  });

  it('routes a Google Takeout export folder to the Takeout importer (not folder)', async () => {
    const dir = '/imp/Takeout';
    const deps = fakeDeps({
      dirs: [dir],
      entries: { [dir]: ['archive_browser.html', 'Mail', 'Google Photos'] },
    });
    const chosen = await selectImporter(dir, deps);
    expect(chosen).toBe(takeoutImporter);
    expect(chosen).not.toBe(folderImporter);
  });

  it('routes a Google Takeout .zip to the Takeout importer', async () => {
    const dir = makeTmpDir('registry-takeout-');
    const zip = join(dir, 'takeout-20240101.zip');
    writeFileSync(zip, buildZip([{ name: 'Takeout/archive_browser.html' }]));
    try {
      expect(await selectImporter(zip, fakeDeps())).toBe(takeoutImporter);
    } finally {
      removeTmpDir(dir);
    }
  });

  it('routes a Facebook DYI export folder to the Facebook importer (not folder)', async () => {
    const dir = '/imp/facebook-export';
    const deps = fakeDeps({
      dirs: [dir],
      files: [join(dir, 'your_activity_across_facebook')],
      entries: { [dir]: ['your_activity_across_facebook'] },
    });
    const chosen = await selectImporter(dir, deps);
    expect(chosen).toBe(facebookImporter);
    expect(chosen).not.toBe(folderImporter);
  });

  it('routes a LinkedIn CSV export folder to the LinkedIn importer (not folder)', async () => {
    const dir = '/imp/linkedin-export';
    const deps = fakeDeps({
      dirs: [dir],
      files: [join(dir, 'Connections.csv')],
      entries: { [dir]: ['Connections.csv', 'messages.csv', 'Rich_Media.csv'] },
    });
    const chosen = await selectImporter(dir, deps);
    expect(chosen).toBe(linkedinImporter);
    expect(chosen).not.toBe(folderImporter);
  });

  it('routes a LinkedIn export .zip of CSVs to the LinkedIn importer', async () => {
    const dir = makeTmpDir('registry-linkedin-');
    const zip = join(dir, 'Basic_LinkedInDataExport.zip');
    writeFileSync(zip, buildZip([{ name: 'Connections.csv' }, { name: 'messages.csv' }]));
    try {
      expect(await selectImporter(zip, fakeDeps())).toBe(linkedinImporter);
    } finally {
      removeTmpDir(dir);
    }
  });

  it('falls back to the folder importer for a plain photo folder (no connector markers)', async () => {
    const dir = '/imp/holiday-photos';
    const deps = fakeDeps({
      dirs: [dir],
      entries: { [dir]: ['IMG_001.jpg', 'IMG_002.jpg', 'clip.mp4'] },
    });
    expect(await selectImporter(dir, deps)).toBe(folderImporter);
  });

  it('keeps the generic folder importer from shadowing ANY specific connector', async () => {
    // Every fixture is a *directory* — the input shape folderImporter always
    // claims — so this is THE regression guard: each specific export must
    // out-resolve folder, which is only true while folder is registered last.
    const whatsappDir = '/d/whatsapp';
    const takeoutDir = '/d/Takeout';
    const facebookDir = '/d/facebook';
    const linkedinDir = '/d/linkedin';
    const deps = fakeDeps({
      dirs: [whatsappDir, takeoutDir, facebookDir, linkedinDir],
      files: [
        join(whatsappDir, '_chat.txt'),
        join(facebookDir, 'your_activity_across_facebook'),
        join(linkedinDir, 'Connections.csv'),
      ],
      entries: {
        [takeoutDir]: ['archive_browser.html'],
        [facebookDir]: ['your_activity_across_facebook'],
        [linkedinDir]: ['Connections.csv'],
      },
    });
    expect(await selectImporter(whatsappDir, deps)).toBe(whatsappImporter);
    expect(await selectImporter(takeoutDir, deps)).toBe(takeoutImporter);
    expect(await selectImporter(facebookDir, deps)).toBe(facebookImporter);
    expect(await selectImporter(linkedinDir, deps)).toBe(linkedinImporter);
    for (const dir of [whatsappDir, takeoutDir, facebookDir, linkedinDir]) {
      expect(await selectImporter(dir, deps)).not.toBe(folderImporter);
    }
  });

  it('prefers the marker-specific Facebook importer over the broad Takeout album heuristic', async () => {
    // A Facebook export root that ALSO carries a top-level JSON + media file —
    // exactly what Takeout's `hasJson && hasMedia` Google-Photos-album fallback
    // would claim. Distinctive markers must win, so Facebook precedes Takeout.
    const dir = '/imp/fb-with-media';
    const deps = fakeDeps({
      dirs: [dir],
      files: [join(dir, 'your_activity_across_facebook')],
      entries: {
        [dir]: ['profile_information.json', 'avatar.jpg', 'your_activity_across_facebook'],
      },
    });
    // Takeout's predicate really would accept this folder…
    expect(await takeoutImporter.canHandle(dir, deps)).toBe(true);
    // …but resolution returns Facebook because it is registered ahead of Takeout.
    expect(await selectImporter(dir, deps)).toBe(facebookImporter);
  });

  it('returns undefined when no importer recognises the path', async () => {
    expect(await selectImporter('/dl/mystery.bin', fakeDeps())).toBeUndefined();
  });

  it('returns undefined for a .zip that matches no connector', async () => {
    const deps = fakeDeps({ zipMarkers: { '/dl/random.zip': 'PK\u0003\u0004just-some-files' } });
    expect(await selectImporter('/dl/random.zip', deps)).toBeUndefined();
  });
});
