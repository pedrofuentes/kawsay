import { createWriteStream } from 'node:fs';
import { mkdir, unlink } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import * as yauzl from 'yauzl';
import type { Entry } from 'yauzl';
import type { ExtractedEntry, SafeExtractFn } from './types';

/**
 * Guarded, zip-slip-safe archive extractor (ARCHITECTURE §7.1; ADR-0006).
 *
 * Every v1 source except folders arrives as an untrusted `.zip` (WhatsApp,
 * Google Takeout, Facebook, LinkedIn). This module is the ONLY sanctioned way
 * to open one — never a raw `adm-zip`/`unzipper`. It is deny-by-default: every
 * entry is validated against the full research checklist (`security.md` Topic 1)
 * BEFORE a single byte is written, and entries are streamed one at a time so the
 * whole archive is never buffered in memory.
 */

/** Stable, assertable error codes — bound by AC-3 / AC-10 tests and surfaced to
 *  the UI as non-technical copy via {@link ArchiveError.messageKey}. */
export const ARCHIVE_ERROR_CODES = {
  /** AC-3: zip-slip, absolute path, drive letter, backslash, or NUL traversal. */
  UNSAFE_PATH: 'ERR_ARCHIVE_UNSAFE_PATH',
  /** AC-10: per-entry / total / ratio / entry-count cap or declared-size mismatch. */
  BOMB: 'ERR_ARCHIVE_BOMB',
  /** AC-10: a symlink entry (never materialized). */
  SYMLINK: 'ERR_ARCHIVE_SYMLINK',
  /** Unreadable / invalid archive. */
  CORRUPT: 'ERR_ARCHIVE_CORRUPT',
  /** Cooperative cancellation via AbortSignal. */
  ABORTED: 'ERR_ARCHIVE_ABORTED',
} as const;

export type ArchiveErrorCode = (typeof ARCHIVE_ERROR_CODES)[keyof typeof ARCHIVE_ERROR_CODES];

/** Non-technical i18n message keys (USER_FLOWS `ErrorBanner` — never a raw code). */
const ARCHIVE_MESSAGE_KEYS: Record<ArchiveErrorCode, string> = {
  ERR_ARCHIVE_UNSAFE_PATH: 'import.error.unsafeArchive',
  ERR_ARCHIVE_BOMB: 'import.error.archiveTooLarge',
  ERR_ARCHIVE_SYMLINK: 'import.error.unsafeArchive',
  ERR_ARCHIVE_CORRUPT: 'import.error.corruptArchive',
  ERR_ARCHIVE_ABORTED: 'import.error.cancelled',
};

const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f-\u009f]/gu;

function cleanDetail(detail: string): string {
  return detail.replace(CONTROL_CHARS_RE, '');
}

/** Typed failure carrying a stable {@link ArchiveErrorCode} and a UI message key. */
export class ArchiveError extends Error {
  readonly code: ArchiveErrorCode;
  readonly messageKey: string;
  readonly detail: string;

  constructor(code: ArchiveErrorCode, detail: string) {
    const safeDetail = cleanDetail(detail);
    super(`${code}: ${safeDetail}`);
    this.name = 'ArchiveError';
    this.code = code;
    this.detail = safeDetail;
    this.messageKey = ARCHIVE_MESSAGE_KEYS[code];
  }
}

/** Decompression-bomb policy caps (ADR-0006). Tuned in ONE place, never disabled. */
export interface ArchiveLimits {
  /** Max uncompressed bytes for a single entry. */
  maxEntryBytes: number;
  /** Max uncompressed bytes for the whole archive. */
  maxTotalBytes: number;
  /** Max number of entries. */
  maxEntries: number;
  /** Max uncompressed/compressed ratio for a single entry. */
  maxCompressionRatio: number;
}

export const DEFAULT_ARCHIVE_LIMITS: ArchiveLimits = {
  maxEntryBytes: 500 * 1024 * 1024, // 500 MB
  maxTotalBytes: 2 * 1024 * 1024 * 1024, // 2 GB
  maxEntries: 100_000,
  maxCompressionRatio: 100,
};

// Unix file-type bits carried in the high word of the zip external attributes.
const S_IFMT = 0xf000;
const S_IFLNK = 0xa000;

function isSymlinkEntry(entry: Entry): boolean {
  const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
  return (unixMode & S_IFMT) === S_IFLNK;
}

/**
 * Map a raw `yauzl` failure onto a stable code. `yauzl` runs `validateFileName`
 * automatically (`decodeStrings: true`), so unsafe names surface as recognisable
 * messages before the entry is ever handed to us; declared-vs-actual size
 * mismatches surface from `validateEntrySizes`. Anything else is a corrupt zip.
 */
function classifyYauzlError(err: unknown): ArchiveError {
  if (isAbortError(err)) {
    return new ArchiveError(ARCHIVE_ERROR_CODES.ABORTED, 'archive extraction aborted');
  }
  const message = err instanceof Error ? err.message : String(err);
  if (
    message.startsWith('invalid characters in fileName:') ||
    message.startsWith('absolute path:') ||
    message.startsWith('invalid relative path:')
  ) {
    return new ArchiveError(ARCHIVE_ERROR_CODES.UNSAFE_PATH, message);
  }
  if (message.includes('size mismatch') || message.includes('too many bytes')) {
    return new ArchiveError(ARCHIVE_ERROR_CODES.BOMB, message);
  }
  return new ArchiveError(ARCHIVE_ERROR_CODES.CORRUPT, message);
}

function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === 'AbortError' || err.message === 'archive extraction aborted')
  );
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new ArchiveError(ARCHIVE_ERROR_CODES.ABORTED, 'archive extraction aborted');
  }
}

/** Belt-and-suspenders name validation beyond yauzl's automatic check. */
function assertSafeName(entry: Entry): void {
  // yauzl.validateFileName does not look for NUL bytes; reject them explicitly.
  if (entry.fileNameRaw.includes(0)) {
    throw new ArchiveError(ARCHIVE_ERROR_CODES.UNSAFE_PATH, 'NUL byte in entry name');
  }
  const problem = yauzl.validateFileName(entry.fileName);
  if (problem != null) {
    throw new ArchiveError(ARCHIVE_ERROR_CODES.UNSAFE_PATH, problem);
  }
}

/** Resolve an entry against destDir and assert it cannot escape (zip-slip). */
function resolveWithin(absDest: string, name: string): string {
  const abs = resolve(absDest, name);
  if (abs !== absDest && !abs.startsWith(absDest + sep)) {
    throw new ArchiveError(ARCHIVE_ERROR_CODES.UNSAFE_PATH, `entry escapes destDir: ${name}`);
  }
  return abs;
}

function enforceSizeLimits(entry: Entry, limits: ArchiveLimits, totalSoFar: number): void {
  if (entry.uncompressedSize > limits.maxEntryBytes) {
    throw new ArchiveError(
      ARCHIVE_ERROR_CODES.BOMB,
      `entry exceeds per-entry cap: ${entry.fileName}`,
    );
  }
  if (
    entry.compressedSize > 0 &&
    entry.uncompressedSize / entry.compressedSize > limits.maxCompressionRatio
  ) {
    throw new ArchiveError(
      ARCHIVE_ERROR_CODES.BOMB,
      `compression ratio exceeds cap: ${entry.fileName}`,
    );
  }
  if (totalSoFar + entry.uncompressedSize > limits.maxTotalBytes) {
    throw new ArchiveError(ARCHIVE_ERROR_CODES.BOMB, 'archive exceeds total uncompressed cap');
  }
}

async function openArchive(archivePath: string): Promise<yauzl.ZipFile> {
  try {
    return await yauzl.openPromise(archivePath, {
      lazyEntries: true, // required by eachEntry(); stream entries one at a time
      decodeStrings: true, // auto-runs yauzl.validateFileName on every entry
      validateEntrySizes: true, // declared-vs-actual size-mismatch detection
      strictFileNames: true, // reject backslashes on every platform
      autoClose: true,
    });
  } catch (err) {
    throw classifyYauzlError(err);
  }
}

/**
 * Build a {@link SafeExtractFn} with custom bomb caps. The exported
 * {@link safeExtract} uses {@link DEFAULT_ARCHIVE_LIMITS}; tests inject tiny caps
 * to drive the bomb guards deterministically without enormous fixtures.
 */
export function createSafeExtract(overrides: Partial<ArchiveLimits> = {}): SafeExtractFn {
  const limits: ArchiveLimits = { ...DEFAULT_ARCHIVE_LIMITS, ...overrides };

  return async (
    archivePath: string,
    destDir: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<readonly ExtractedEntry[]> => {
    const { signal } = options;
    throwIfAborted(signal);
    const absDest = resolve(destDir);
    await mkdir(absDest, { recursive: true });
    throwIfAborted(signal);

    const zipfile = await openArchive(archivePath);
    const extracted: ExtractedEntry[] = [];
    let totalBytes = 0;
    let entryCount = 0;

    try {
      for await (const entry of zipfile.eachEntry()) {
        throwIfAborted(signal);
        entryCount += 1;
        if (entryCount > limits.maxEntries) {
          throw new ArchiveError(
            ARCHIVE_ERROR_CODES.BOMB,
            `archive exceeds ${limits.maxEntries} entries`,
          );
        }

        // Reject symlinks outright — never create them (they could escape later).
        if (isSymlinkEntry(entry)) {
          throw new ArchiveError(ARCHIVE_ERROR_CODES.SYMLINK, `symlink entry: ${entry.fileName}`);
        }

        assertSafeName(entry);
        const absPath = resolveWithin(absDest, entry.fileName);

        // Directory entries: create the dir, emit nothing.
        if (entry.fileName.endsWith('/')) {
          await mkdir(absPath, { recursive: true });
          continue;
        }

        // Bomb caps are checked from the central directory BEFORE any byte is read.
        enforceSizeLimits(entry, limits, totalBytes);
        totalBytes += entry.uncompressedSize;

        await mkdir(dirname(absPath), { recursive: true });
        const readStream = await zipfile.openReadStreamPromise(entry);
        try {
          await pipeline(readStream, createWriteStream(absPath), { signal });
        } catch (err) {
          await unlink(absPath).catch(() => undefined);
          throw err;
        }

        extracted.push({ entryPath: entry.fileName, absPath });
      }
    } catch (err) {
      throw err instanceof ArchiveError ? err : classifyYauzlError(err);
    } finally {
      zipfile.close();
    }

    return extracted;
  };
}

/** The guarded extractor every archive importer uses (the {@link SafeExtractFn}). */
export const safeExtract: SafeExtractFn = createSafeExtract();
