import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { openCatalog } from '../db/connection';
import { runMigrations } from '../db/migrate';

// The ADR-0008 §1 layout: a self-contained, portable library folder holding the
// catalog, content-addressed originals, rebuildable derived renditions, the
// transient extraction scratch, and logs — and nothing else.
const LIBRARY_DIRS = [
  'originals',
  join('derived', 'thumbnails'),
  join('derived', 'posters'),
  join('derived', 'waveforms'),
  'extract',
  'logs',
] as const;

const CATALOG_FILE = 'catalog.sqlite3';
const MANIFEST_FILE = 'library.json';

const libraryManifestSchema = z.object({
  app: z.literal('kawsay'),
  name: z.string(),
  /** Canonical ISO-8601 UTC instant. */
  createdAt: z.string(),
  schemaVersion: z.number().int().nonnegative(),
});

/** The on-disk `library.json` — convenience metadata; the catalog is authoritative. */
export type LibraryManifest = z.infer<typeof libraryManifestSchema>;

export interface CreateLibraryInput {
  root: string;
  /** The remembered person; defaults to the folder name. */
  personName?: string;
}

export interface OpenLibraryInput {
  root: string;
}

export interface LibrarySummary {
  root: string;
  name: string;
  createdAt: string;
  schemaVersion: number;
  catalogPath: string;
}

function catalogPath(root: string): string {
  return join(root, CATALOG_FILE);
}

function manifestPath(root: string): string {
  return join(root, MANIFEST_FILE);
}

/** Reject anything but an absolute path so every write stays inside the library. */
function assertAbsoluteRoot(root: string): void {
  if (root === '' || !isAbsolute(root)) {
    throw new Error(`library root must be an absolute path: ${JSON.stringify(root)}`);
  }
}

function assertNoSymlinkRoot(root: string): void {
  const resolvedRoot = resolve(root);
  if (existsSync(resolvedRoot)) {
    if (lstatSync(resolvedRoot).isSymbolicLink()) {
      throw new Error(`library root must not be a symlink: ${root}`);
    }
    if (realpathSync.native(resolvedRoot) !== resolvedRoot) {
      throw new Error(`library root must not resolve through a symlink: ${root}`);
    }
    return;
  }

  let parent = dirname(resolvedRoot);
  while (!existsSync(parent)) {
    const next = dirname(parent);
    if (next === parent) break;
    parent = next;
  }
  if (realpathSync.native(parent) !== parent) {
    throw new Error(`library root parent must not resolve through a symlink: ${root}`);
  }
}

function libraryName(root: string, personName?: string): string {
  const trimmed = personName?.trim();
  if (trimmed) return trimmed;
  return basename(root) || 'Kawsay Library';
}

function ensureLayout(root: string): void {
  for (const dir of LIBRARY_DIRS) mkdirSync(join(root, dir), { recursive: true });
}

/** Open the catalog, apply pending migrations, and return its schema version. */
function migrateCatalog(root: string): number {
  const db = openCatalog(catalogPath(root));
  try {
    runMigrations(db);
    return Number(db.pragma('user_version', { simple: true }));
  } finally {
    db.close();
  }
}

function readManifest(root: string): LibraryManifest | null {
  const file = manifestPath(root);
  if (!existsSync(file)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    const result = libraryManifestSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/**
 * Create a new Kawsay library at `root` (ADR-0008 §1): build the folder layout,
 * migrate a fresh catalog to the current schema, and write the manifest. Refuses
 * to overwrite an existing library or a non-directory path.
 */
export function createLibrary({ root, personName }: CreateLibraryInput): LibrarySummary {
  assertAbsoluteRoot(root);
  assertNoSymlinkRoot(root);
  if (existsSync(catalogPath(root))) {
    throw new Error(`a Kawsay library already exists at ${root}`);
  }
  if (existsSync(root) && !statSync(root).isDirectory()) {
    throw new Error(`library root is not a directory: ${root}`);
  }

  ensureLayout(root);
  const schemaVersion = migrateCatalog(root);
  const name = libraryName(root, personName);
  const createdAt = new Date().toISOString();
  const manifest: LibraryManifest = { app: 'kawsay', name, createdAt, schemaVersion };
  writeFileSync(manifestPath(root), `${JSON.stringify(manifest, null, 2)}\n`);

  return { root, name, createdAt, schemaVersion, catalogPath: catalogPath(root) };
}

/**
 * Open an existing Kawsay library at `root`: validate it, forward-migrate the
 * catalog (idempotent), and return its summary. The catalog is authoritative; a
 * missing or invalid manifest falls back to the folder name and catalog mtime.
 */
export function openLibrary({ root }: OpenLibraryInput): LibrarySummary {
  assertAbsoluteRoot(root);
  assertNoSymlinkRoot(root);
  if (!existsSync(catalogPath(root))) {
    throw new Error(`no Kawsay library at ${root}`);
  }

  const schemaVersion = migrateCatalog(root);
  ensureLayout(root); // self-heal a partial/older layout (idempotent)
  const manifest = readManifest(root);
  const name = manifest?.name ?? libraryName(root);
  const createdAt = manifest?.createdAt ?? statSync(catalogPath(root)).mtime.toISOString();

  return { root, name, createdAt, schemaVersion, catalogPath: catalogPath(root) };
}
