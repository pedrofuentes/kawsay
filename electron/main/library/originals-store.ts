import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import type { OriginalKind } from '@shared/catalog';
import type { CatalogDatabase } from '../db/connection';

/**
 * Stable error tag thrown when a hash, extension, or stored asset path — any of
 * which can derive from an UNTRUSTED archive filename — would escape the library
 * root or is malformed. The originals store is the AC-14 / ADR-0008 safety
 * boundary: every path that drives a copy or delete is validated and confined to
 * the root before any filesystem mutation.
 */
export const ERR_ORIGINAL_PATH_ESCAPE = 'ERR_ORIGINAL_PATH_ESCAPE';

/** A content address is exactly 64 lowercase hex characters (SHA-256). */
const HASH_RE = /^[0-9a-f]{64}$/;
/** A safe extension is a single dot followed by alphanumerics — no separators, no `..`. */
const EXT_RE = /^\.[A-Za-z0-9]+$/;
/** Generous ceiling; the longest real-world media extension is well under this. */
const MAX_EXT_LEN = 16;

function rejectPath(detail: string): never {
  throw new Error(`${ERR_ORIGINAL_PATH_ESCAPE}: ${detail}`);
}

/** Reject a content hash that is not a canonical lowercase SHA-256 hex string. */
function assertSafeHash(hash: string): string {
  if (typeof hash !== 'string' || !HASH_RE.test(hash)) rejectPath('invalid content hash');
  return hash;
}

/**
 * Reject a stored rendition path that is absolute, NUL-tainted, or walks out of
 * the library via a `..` segment. Interior separators are legitimate — derived
 * assets live at `derived/<kind>/<shard>/<hash>.<ext>`.
 */
function assertSafeAssetRelPath(p: string): string {
  if (typeof p !== 'string' || p === '' || p.includes('\0')) rejectPath('invalid asset path');
  if (isAbsolute(p)) rejectPath('absolute asset path');
  if (p.split(/[\\/]/).includes('..')) rejectPath('asset path traversal');
  return p;
}

/** Assert an absolute path resolves to a location strictly inside `root`. */
function assertWithinRoot(root: string, absPath: string): string {
  const resolvedRoot = resolve(root);
  const resolved = resolve(absPath);
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + sep)) {
    rejectPath('path escapes library root');
  }
  return absPath;
}

/**
 * Normalize an extension to a leading-dot suffix (`jpg` → `.jpg`, null → ``) and
 * reject anything that is not a plain dotted alphanumeric extension. A separator,
 * `..`, NUL, or over-long value could escape the shard directory, so it throws.
 */
function normalizeExt(ext?: string | null): string {
  if (ext === null || ext === undefined || ext === '') return '';
  if (typeof ext !== 'string' || ext.includes('\0')) rejectPath('invalid extension');
  const dotted = ext.startsWith('.') ? ext : `.${ext}`;
  if (dotted.length > MAX_EXT_LEN || !EXT_RE.test(dotted)) rejectPath('invalid extension');
  return dotted;
}

/**
 * Library-relative path of a content-addressed original:
 * `originals/<hash[0:2]>/<hash><ext>` (mirrors the thumbnail sharding, §4.4).
 */
export function blobRelPath(hash: string, ext?: string | null): string {
  return join('originals', hash.slice(0, 2), `${hash}${normalizeExt(ext)}`);
}

/** Absolute path of a content-addressed original within `root`. */
export function blobAbsPath(root: string, hash: string, ext?: string | null): string {
  return join(root, blobRelPath(hash, ext));
}

export interface PutOriginalInput {
  /** Absolute library root. */
  root: string;
  /** SHA-256 hex of the bytes (the content address). */
  hash: string;
  ext?: string | null;
  /** Absolute path of the validated source file to copy from. */
  sourcePath: string;
}

export interface PutOriginalResult {
  relPath: string;
  absPath: string;
  /** False when a blob with this hash already existed (deduped, not re-copied). */
  copied: boolean;
}

/**
 * Store a validated original once, content-addressed. If a blob with this hash
 * already exists (same bytes from an earlier occurrence/source), it is NOT
 * re-copied — the caller's new occurrence simply references it (§4.4).
 */
export function putOriginal(input: PutOriginalInput): PutOriginalResult {
  assertSafeHash(input.hash);
  const relPath = blobRelPath(input.hash, input.ext);
  const absPath = join(input.root, relPath);
  assertWithinRoot(input.root, absPath);
  if (existsSync(absPath)) return { relPath, absPath, copied: false };
  mkdirSync(dirname(absPath), { recursive: true });
  copyFileSync(input.sourcePath, absPath);
  return { relPath, absPath, copied: true };
}

interface OriginalRef {
  kind: OriginalKind;
  path: string | null;
  hash: string | null;
  ext: string | null;
}

/**
 * Resolve a memory's original through a SURVIVING occurrence (never a single
 * `items.stored_path`, which deliberately does not exist — §4.4). Prefers an
 * in-place folder original (the user's own file); otherwise serves the
 * content-addressed blob. Returns null for pure messages or removed items.
 */
export function resolveOriginal(
  db: CatalogDatabase,
  root: string,
  itemId: string,
): string | null {
  const row = db
    .prepare(
      `SELECT o.original_kind AS kind, o.original_path AS path,
              i.content_hash AS hash, i.original_ext AS ext
       FROM item_occurrences o
       JOIN items i ON i.id = o.item_id
       WHERE o.item_id = @itemId AND o.original_kind <> 'none'
       ORDER BY CASE o.original_kind WHEN 'in_place' THEN 0 ELSE 1 END, o.created_at, o.id
       LIMIT 1`,
    )
    .get<OriginalRef>({ itemId });
  if (!row) return null;
  if (row.kind === 'in_place') return row.path;
  if (row.kind === 'content_addressed' && row.hash) {
    assertSafeHash(row.hash);
    return assertWithinRoot(root, blobAbsPath(root, row.hash, row.ext));
  }
  return null;
}

export interface RemoveOccurrenceResult {
  /** The occurrence existed and was deleted. */
  removed: boolean;
  /** The content-addressed blob was the last reference and was deleted. */
  blobDeleted: boolean;
  /** The item had no occurrences left and was dropped (with its derived assets). */
  itemRemoved: boolean;
}

interface RemovalPlan {
  blobToDelete: string | null;
  derivedToDelete: string[];
  itemRemoved: boolean;
}

/**
 * Remove a single occurrence and reference-count its original (undo, §4.4 /
 * AC-14). The DB mutations run in one transaction; disk cleanup follows commit:
 *  - content_addressed → delete the blob ONLY when the last content_addressed
 *    occurrence for that hash is gone (so undoing one source never dangles a
 *    deduped memory that still lives in another source);
 *  - in_place → the user's file is NEVER touched;
 *  - when the item's LAST occurrence (of any kind) is gone, drop the item and
 *    delete its now-orphaned derived renditions.
 */
export function removeOccurrence(
  db: CatalogDatabase,
  root: string,
  occurrenceId: string,
): RemoveOccurrenceResult {
  const plan = db.transaction((id: string): RemovalPlan | null => {
    const occ = db
      .prepare(
        `SELECT o.item_id AS itemId, o.original_kind AS kind,
                i.content_hash AS hash, i.original_ext AS ext
         FROM item_occurrences o
         JOIN items i ON i.id = o.item_id
         WHERE o.id = @id`,
      )
      .get<{ itemId: string; kind: OriginalKind; hash: string | null; ext: string | null }>({ id });
    if (!occ) return null;

    db.prepare('DELETE FROM item_occurrences WHERE id = @id').run({ id });

    let blobToDelete: string | null = null;
    if (occ.kind === 'content_addressed' && occ.hash) {
      const remaining = Number(
        db
          .prepare(
            `SELECT COUNT(*) AS n
             FROM item_occurrences o
             JOIN items i ON i.id = o.item_id
             WHERE i.content_hash = @hash AND o.original_kind = 'content_addressed'`,
          )
          .get<{ n: number }>({ hash: occ.hash })?.n ?? 0,
      );
      if (remaining === 0) {
        assertSafeHash(occ.hash);
        blobToDelete = assertWithinRoot(root, blobAbsPath(root, occ.hash, occ.ext));
      }
    }

    const derivedToDelete: string[] = [];
    let itemRemoved = false;
    const itemOccCount = Number(
      db
        .prepare('SELECT COUNT(*) AS n FROM item_occurrences WHERE item_id = @itemId')
        .get<{ n: number }>({ itemId: occ.itemId })?.n ?? 0,
    );
    if (itemOccCount === 0) {
      const assets = db
        .prepare('SELECT path FROM item_assets WHERE item_id = @itemId')
        .all<{ path: string }>({ itemId: occ.itemId });
      for (const asset of assets) {
        assertSafeAssetRelPath(asset.path);
        derivedToDelete.push(assertWithinRoot(root, join(root, asset.path)));
      }
      db.prepare('DELETE FROM items WHERE id = @itemId').run({ itemId: occ.itemId });
      itemRemoved = true;
    }
    return { blobToDelete, derivedToDelete, itemRemoved };
  })(occurrenceId);

  if (!plan) return { removed: false, blobDeleted: false, itemRemoved: false };

  let blobDeleted = false;
  if (plan.blobToDelete && deleteFileIfExists(plan.blobToDelete)) blobDeleted = true;
  for (const derived of plan.derivedToDelete) deleteFileIfExists(derived);
  return { removed: true, blobDeleted, itemRemoved: plan.itemRemoved };
}

function deleteFileIfExists(absPath: string): boolean {
  if (!existsSync(absPath)) return false;
  rmSync(absPath, { force: true });
  return true;
}
