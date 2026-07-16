import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  createReadStream,
  existsSync,
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { dirname, extname, isAbsolute, join, resolve, sep } from 'node:path';
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
export const ERR_ORIGINAL_INTEGRITY = 'ERR_ORIGINAL_INTEGRITY';

/** A content address is exactly 64 lowercase hex characters (SHA-256). */
const HASH_RE = /^[0-9a-f]{64}$/;
/** A safe extension is a single dot followed by alphanumerics — no separators, no `..`. */
const EXT_RE = /^\.[A-Za-z0-9]+$/;
/** Generous ceiling; the longest real-world media extension is well under this. */
const MAX_EXT_LEN = 16;

function rejectPath(detail: string): never {
  throw new Error(`${ERR_ORIGINAL_PATH_ESCAPE}: ${detail}`);
}

function rejectIntegrity(detail: string): never {
  throw new Error(`${ERR_ORIGINAL_INTEGRITY}: ${detail}`);
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

export interface VerifyOriginalBlobInput {
  root: string;
  hash: string;
  ext?: string | null;
}

export interface VerifyOriginalBlobResult {
  ok: boolean;
  absPath: string;
}

export async function hashOriginalFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk: string | Buffer) => {
      hash.update(chunk);
    });
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

function sha256File(path: string): string {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const fd = openSync(path, 'r');
  try {
    for (;;) {
      const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

export function verifyOriginalBlob(input: VerifyOriginalBlobInput): VerifyOriginalBlobResult {
  assertSafeHash(input.hash);
  const absPath = assertWithinRoot(input.root, blobAbsPath(input.root, input.hash, input.ext));
  if (!existsSync(absPath)) return { ok: false, absPath };
  return { ok: sha256File(absPath) === input.hash, absPath };
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
  if (existsSync(absPath)) {
    const verified = verifyOriginalBlob({ root: input.root, hash: input.hash, ext: input.ext });
    if (!verified.ok) rejectIntegrity('stored blob bytes do not match content hash');
    return { relPath, absPath, copied: false };
  }
  mkdirSync(dirname(absPath), { recursive: true });
  const tempPath = `${absPath}.part-${randomUUID()}`;
  try {
    copyFileSync(input.sourcePath, tempPath);
    if (sha256File(tempPath) !== input.hash) {
      rejectIntegrity('copied bytes do not match content hash');
    }
    renameSync(tempPath, absPath);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
  return { relPath, absPath, copied: true };
}

export interface OriginalGcOptions {
  limit?: number;
  afterHash?: string | null;
}

export interface OriginalGcResult {
  scanned: number;
  deleted: number;
  nextCursor: string | null;
}

interface BlobCandidate {
  hash: string;
  ext: string | null;
  absPath: string;
  cursor: string;
}

function gcCursor(hash: string, ext: string | null): string {
  return `${hash}\t${ext ?? ''}`;
}

function candidateAfter(cursor: string, after: string | null): boolean {
  if (after === null) return true;
  if (!after.includes('\t')) return cursor.split('\t')[0] > after;
  return cursor > after;
}

function listOriginalCandidates(root: string, afterHash: string | null, limit: number): BlobCandidate[] {
  const originals = join(root, 'originals');
  if (!existsSync(originals)) return [];
  const candidates: BlobCandidate[] = [];
  for (const shard of readdirSync(originals, { withFileTypes: true })) {
    if (!shard.isDirectory()) continue;
    const shardPath = join(originals, shard.name);
    for (const entry of readdirSync(shardPath, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const file = entry.name;
      const dot = file.indexOf('.');
      const hash = dot === -1 ? file : file.slice(0, dot);
      const ext = extname(file) || null;
      const cursor = gcCursor(hash, ext);
      if (!HASH_RE.test(hash) || !candidateAfter(cursor, afterHash)) continue;
      candidates.push({ hash, ext, absPath: join(shardPath, file), cursor });
    }
  }
  return candidates.sort((a, b) => a.cursor.localeCompare(b.cursor)).slice(0, limit);
}

function hasContentAddressedReference(db: CatalogDatabase, hash: string, ext: string | null): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS found
       FROM item_occurrences o
       JOIN items i ON i.id = o.item_id
       WHERE i.content_hash = @hash AND o.original_kind = 'content_addressed'
         AND COALESCE(i.original_ext, '') = @ext
       LIMIT 1`,
    )
    .get<{ found: number }>({ hash, ext: normalizeExt(ext) });
  return row !== undefined;
}

export function garbageCollectOrphanedOriginals(
  db: CatalogDatabase,
  root: string,
  options: OriginalGcOptions = {},
): OriginalGcResult {
  const limit = Math.max(1, options.limit ?? 500);
  const afterHash = options.afterHash ?? null;
  const candidates = listOriginalCandidates(root, afterHash, limit);
  let deleted = 0;
  for (const candidate of candidates) {
    assertSafeHash(candidate.hash);
    assertWithinRoot(root, candidate.absPath);
    if (!hasContentAddressedReference(db, candidate.hash, candidate.ext)) {
      rmSync(candidate.absPath, { force: true });
      deleted += 1;
    }
  }
  return {
    scanned: candidates.length,
    deleted,
    nextCursor: candidates.length === limit ? candidates.at(-1)?.cursor ?? null : null,
  };
}

interface OriginalRef {
  kind: OriginalKind;
  path: string | null;
  hash: string | null;
  ext: string | null;
}

/** Same, plus the SOURCE roots a surviving `in_place` occurrence belongs to — the
 *  allowlist a serve-time confinement check confines the file to (§2.4). */
interface ServableOriginalRef extends OriginalRef {
  sourceRoot: string | null;
  sourceOrigin: string | null;
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

/** Realpath a path (symlinks resolved), or null if it cannot be resolved (missing,
 *  broken symlink, permission). */
function safeRealpath(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

/**
 * Is `realTarget` (an ALREADY realpath-resolved path) contained within — equal to,
 * or under — one of the servable roots? Each root is realpath-resolved here; an
 * EMPTY or NON-ABSOLUTE root entry is refused by the primitive itself (never
 * relying on the caller to pre-filter), so a `''`/`'.'` entry can never degrade to
 * "allow anything under cwd".
 */
function realPathContainedIn(realTarget: string, servableRoots: readonly string[]): boolean {
  for (const rootCandidate of servableRoots) {
    if (typeof rootCandidate !== 'string' || rootCandidate.length === 0) continue;
    if (!isAbsolute(rootCandidate)) continue;
    const realRoot = safeRealpath(rootCandidate);
    if (realRoot === null) continue;
    if (realTarget === realRoot || realTarget.startsWith(realRoot + sep)) return true;
  }
  return false;
}

/**
 * SERVE-TIME allowlist check (ARCHITECTURE §2.4). The file's REAL path (symlinks
 * resolved) must be contained within one of the servable roots (each also
 * realpath-resolved; empty/non-absolute entries refused). Returns false when the
 * path cannot be resolved, or the real path escapes every root. This is the check
 * that closes the import-time→serve-time TOCTOU for in-place originals: a later
 * symlink swap at a recorded path resolves OUTSIDE the source root and is refused.
 */
export function isServablePath(absPath: string, servableRoots: readonly string[]): boolean {
  const real = safeRealpath(absPath);
  if (real === null) return false;
  return realPathContainedIn(real, servableRoots);
}

/**
 * A resolved original that is SAFE to stream to the renderer, PINNED by an open file
 * descriptor. The `fd` is the authority — the caller streams FROM the fd and never
 * re-opens by path, so a swap of the path after validation cannot redirect the read
 * (TOCTOU). The caller OWNS the fd and MUST close it on every path.
 */
export interface ServableOriginal {
  /** An open, read-only fd on the validated regular file. Caller must close it. */
  fd: number;
  /** The file size from `fstat` on the SAME fd (drives Content-Length / Range). */
  size: number;
  kind: OriginalKind;
}

/**
 * Open a validated CANONICAL (realpath-resolved, symlink-free) path to a read-only
 * fd, fstat it, and verify it is a regular file — the atomic "pin the file we just
 * validated" step (§2.4). Exported as a testable seam. Closes the fd and THROWS if it
 * is not a regular file; returns null if the file vanished — or a symlink was planted
 * in the realpath→open window (refused by `O_NOFOLLOW` → `ELOOP`) — before the open.
 */
export function pinRegularFile(canonicalPath: string, kind: OriginalKind): ServableOriginal | null {
  let fd: number;
  try {
    // The canonical path contains no symlinks, so this open cannot follow a newly
    // planted symlink; and because we stream from THIS fd, no later re-open occurs.
    fd = openSync(canonicalPath, 'r');
  } catch {
    return null;
  }
  let stats: ReturnType<typeof fstatSync>;
  try {
    stats = fstatSync(fd);
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  if (!stats.isFile()) {
    closeSync(fd);
    rejectPath('resolved media is not a regular file');
  }
  return { fd, size: stats.size, kind };
}

/**
 * Resolve a memory's original, enforce SERVE-TIME path confinement (§2.4), and PIN
 * it by an open fd — the boundary the `kawsay-media:` protocol streams through.
 *
 * The realpath + containment check runs exactly ONCE, then the CANONICAL path is
 * opened to an fd and fstat-verified; the fd (not a path) is returned, so the file
 * that was validated is the exact file that is streamed. Content-addressed originals
 * are confined to the library root; in-place originals (the user's OWN files outside
 * the library) must realpath INSIDE a registered SOURCE root the user chose — so a
 * later symlink/inode swap at a recorded path can never redirect the read. Returns
 * null for a missing/unresolvable/absent file (a plain not-found); THROWS
 * `ERR_ORIGINAL_PATH_ESCAPE` when a real path escapes its servable roots or is not a
 * regular file. The caller OWNS and MUST close the returned fd.
 */
export function resolveServableOriginal(
  db: CatalogDatabase,
  root: string,
  itemId: string,
): ServableOriginal | null {
  const row = db
    .prepare(
      `SELECT o.original_kind AS kind, o.original_path AS path,
              i.content_hash AS hash, i.original_ext AS ext,
              s.root_path AS sourceRoot, s.origin_path AS sourceOrigin
       FROM item_occurrences o
       JOIN items i ON i.id = o.item_id
       JOIN sources s ON s.id = o.source_id
       WHERE o.item_id = @itemId AND o.original_kind <> 'none'
       ORDER BY CASE o.original_kind WHEN 'in_place' THEN 0 ELSE 1 END, o.created_at, o.id
       LIMIT 1`,
    )
    .get<ServableOriginalRef>({ itemId });
  if (!row) return null;

  if (row.kind === 'content_addressed' && row.hash) {
    assertSafeHash(row.hash);
    // Confined to the library root by construction. Realpath ONCE, confine, then pin.
    const target = assertWithinRoot(root, blobAbsPath(root, row.hash, row.ext));
    const real = safeRealpath(target);
    if (real === null) return null; // blob not on disk → nothing to serve
    if (!realPathContainedIn(real, [root])) {
      rejectPath('content-addressed original escapes the library root');
    }
    return pinRegularFile(real, 'content_addressed');
  }

  if (row.kind === 'in_place') {
    if (row.path === null) return null;
    // The allowlist for an in-place original: the SOURCE root(s) the user chose.
    // (An in-place file legitimately lives outside the library, so the library root
    // does NOT apply here.) A single realpath of the untrusted path, then containment.
    const servableRoots = [row.sourceRoot, row.sourceOrigin].filter(
      (candidate): candidate is string => typeof candidate === 'string',
    );
    const real = safeRealpath(row.path);
    if (real === null) return null; // missing/unresolvable → a plain not-found
    if (!realPathContainedIn(real, servableRoots)) {
      rejectPath('in-place original escapes its source root(s)');
    }
    // Pin the CANONICAL, symlink-free path — the exact file we just validated.
    return pinRegularFile(real, 'in_place');
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
