import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ARCHIVE_ERROR_CODES,
  ArchiveError,
  DEFAULT_ARCHIVE_LIMITS,
  createSafeExtract,
  safeExtract,
} from '../../electron/main/importers/safe-extract';
import { makeTmpDir, removeTmpDir } from '../helpers/tmp';

// ── Minimal, dependency-free ZIP writer ─────────────────────────────────────
// `yauzl` is read-only, so the adversarial fixtures are hand-built here. This
// gives the tests total control over hostile entry names, Unix symlink mode
// bits, and declared (un)compressed sizes — none of which a normal zip tool
// will emit. Keeping the writer in the test file (not the SUT) ensures the
// security guards are exercised against real on-disk bytes.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

interface ZipEntrySpec {
  name: string;
  data?: Buffer;
  /** 0 = store, 8 = deflate. */
  method?: 0 | 8;
  /** Central-directory uncompressed size override for adversarial fixtures. */
  declaredUncompressedSize?: number;
  /** Raw compressed bytes override for corrupt mid-stream fixtures. */
  compressedOverride?: Buffer;
  /** Full 32-bit external file attributes (high 16 bits carry the Unix mode). */
  externalAttrs?: number;
}

function buildZip(entries: readonly ZipEntrySpec[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const spec of entries) {
    const nameBuf = Buffer.from(spec.name, 'binary');
    const method = spec.method ?? 0;
    const raw = spec.data ?? Buffer.alloc(0);
    const compressed = spec.compressedOverride ?? (method === 8 ? deflateRawSync(raw) : raw);
    const crc = crc32(raw);
    const flags = 0x800; // UTF-8 filename flag

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    const localRecord = Buffer.concat([local, nameBuf, compressed]);
    locals.push(localRecord);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // version made by: UNIX host
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(spec.declaredUncompressedSize ?? raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE((spec.externalAttrs ?? 0) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, nameBuf]));
    offset += localRecord.length;
  }

  const centralDir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDir, end]);
}

/** Unix mode `S_IFLNK | 0777`, shifted into the external-attributes high word. */
const SYMLINK_ATTRS = (0xa1ff << 16) >>> 0;

async function expectArchiveError(
  run: Promise<unknown>,
  code: (typeof ARCHIVE_ERROR_CODES)[keyof typeof ARCHIVE_ERROR_CODES],
): Promise<ArchiveError> {
  let thrown: unknown;
  let resolved = false;
  try {
    await run;
    resolved = true;
  } catch (err) {
    thrown = err;
  }
  if (resolved) {
    throw new Error(`expected rejection with ${code} but the extractor resolved`);
  }
  expect(thrown).toBeInstanceOf(ArchiveError);
  expect((thrown as ArchiveError).code).toBe(code);
  return thrown as ArchiveError;
}

describe('safeExtract', () => {
  let base: string;
  let dest: string;

  beforeEach(() => {
    base = makeTmpDir('safe-extract-');
    dest = join(base, 'dest');
    mkdirSync(dest, { recursive: true });
  });
  afterEach(() => removeTmpDir(base));

  function writeArchive(name: string, entries: readonly ZipEntrySpec[]): string {
    const archivePath = join(base, name);
    writeFileSync(archivePath, buildZip(entries));
    return archivePath;
  }

  // ── Happy path ────────────────────────────────────────────────────────────
  describe('valid archives', () => {
    it('extracts every file under destDir with the in-archive entryPath preserved', async () => {
      const archive = writeArchive('valid.zip', [
        { name: 'photos/', data: Buffer.alloc(0) }, // explicit directory entry
        { name: 'photos/cat.txt', data: Buffer.from('meow'), method: 8 },
        { name: 'note.txt', data: Buffer.from('hello world'), method: 0 },
      ]);

      const result = await safeExtract(archive, dest);

      // Directory entries are not emitted as extracted files.
      expect(result).toHaveLength(2);
      expect(result.map((e) => e.entryPath)).toEqual(['photos/cat.txt', 'note.txt']);

      const cat = result.find((e) => e.entryPath === 'photos/cat.txt');
      const note = result.find((e) => e.entryPath === 'note.txt');
      expect(cat?.absPath).toBe(join(dest, 'photos', 'cat.txt'));
      expect(note?.absPath).toBe(join(dest, 'note.txt'));
      expect(readFileSync(join(dest, 'photos', 'cat.txt'), 'utf8')).toBe('meow');
      expect(readFileSync(join(dest, 'note.txt'), 'utf8')).toBe('hello world');

      // Everything stays strictly inside destDir.
      for (const entry of result) {
        expect(entry.absPath.startsWith(dest)).toBe(true);
      }
    });

    it('returns an empty list for an archive with no file entries', async () => {
      const archive = writeArchive('empty.zip', []);
      await expect(safeExtract(archive, dest)).resolves.toEqual([]);
    });
  });

  // ── Zip-slip / path traversal (AC-3) ──────────────────────────────────────
  describe('path traversal → ERR_ARCHIVE_UNSAFE_PATH', () => {
    it('rejects a ../ traversal entry and writes nothing outside destDir', async () => {
      const archive = writeArchive('slip.zip', [
        { name: '../escape.txt', data: Buffer.from('pwned') },
      ]);
      await expectArchiveError(safeExtract(archive, dest), ARCHIVE_ERROR_CODES.UNSAFE_PATH);
      expect(existsSync(join(base, 'escape.txt'))).toBe(false);
      expect(readdirSync(dest)).toEqual([]);
    });

    it('rejects a normalized .. segment that would otherwise stay inside the scratch root', async () => {
      const archive = writeArchive('scratch-slip.zip', [
        { name: 'Takeout/../escape-inside-workdir.txt', data: Buffer.from('pwned') },
      ]);
      const err = await expectArchiveError(
        safeExtract(archive, dest),
        ARCHIVE_ERROR_CODES.UNSAFE_PATH,
      );
      expect(err.message).toContain('..');
      expect(existsSync(join(dest, 'escape-inside-workdir.txt'))).toBe(false);
    });

    it('rejects an absolute-path entry', async () => {
      const archive = writeArchive('abs.zip', [
        { name: '/etc/kawsay-evil.txt', data: Buffer.from('x') },
      ]);
      await expectArchiveError(safeExtract(archive, dest), ARCHIVE_ERROR_CODES.UNSAFE_PATH);
      expect(existsSync('/etc/kawsay-evil.txt')).toBe(false);
    });

    it('rejects a Windows drive-letter entry', async () => {
      const archive = writeArchive('drive.zip', [{ name: 'C:/evil.txt', data: Buffer.from('x') }]);
      await expectArchiveError(safeExtract(archive, dest), ARCHIVE_ERROR_CODES.UNSAFE_PATH);
      expect(readdirSync(dest)).toEqual([]);
    });

    it('rejects a backslash-traversal entry', async () => {
      const archive = writeArchive('back.zip', [
        { name: '..\\..\\evil.txt', data: Buffer.from('x') },
      ]);
      await expectArchiveError(safeExtract(archive, dest), ARCHIVE_ERROR_CODES.UNSAFE_PATH);
      expect(readdirSync(dest)).toEqual([]);
    });

    it('rejects a NUL byte in the entry name (guard beyond yauzl.validateFileName)', async () => {
      const archive = writeArchive('nul.zip', [{ name: 'evil\u0000.txt', data: Buffer.from('x') }]);
      await expectArchiveError(safeExtract(archive, dest), ARCHIVE_ERROR_CODES.UNSAFE_PATH);
      expect(readdirSync(dest)).toEqual([]);
    });
  });

  // ── Symlink rejection (AC-10) ─────────────────────────────────────────────
  describe('symlink entries → ERR_ARCHIVE_SYMLINK', () => {
    it('rejects a symlink entry and never materializes a link', async () => {
      const archive = writeArchive('symlink.zip', [
        { name: 'link', data: Buffer.from('/etc/passwd'), externalAttrs: SYMLINK_ATTRS },
      ]);
      await expectArchiveError(safeExtract(archive, dest), ARCHIVE_ERROR_CODES.SYMLINK);
      expect(existsSync(join(dest, 'link'))).toBe(false);
      expect(readdirSync(dest)).toEqual([]);
    });
  });

  // ── Decompression bombs (AC-10) ───────────────────────────────────────────
  describe('decompression bombs → ERR_ARCHIVE_BOMB', () => {
    it('rejects an entry over the per-entry uncompressed cap', async () => {
      const extract = createSafeExtract({ maxEntryBytes: 4 });
      const archive = writeArchive('per-entry.zip', [
        { name: 'big.bin', data: Buffer.alloc(5, 0x41) },
      ]);
      await expectArchiveError(extract(archive, dest), ARCHIVE_ERROR_CODES.BOMB);
      expect(existsSync(join(dest, 'big.bin'))).toBe(false);
    });

    it('rejects an archive over the total uncompressed cap', async () => {
      const extract = createSafeExtract({ maxTotalBytes: 6 });
      const archive = writeArchive('total.zip', [
        { name: 'a.bin', data: Buffer.alloc(4, 0x41) },
        { name: 'b.bin', data: Buffer.alloc(4, 0x42) },
      ]);
      await expectArchiveError(extract(archive, dest), ARCHIVE_ERROR_CODES.BOMB);
    });

    it('rejects an archive over the entry-count cap', async () => {
      const extract = createSafeExtract({ maxEntries: 2 });
      const archive = writeArchive('count.zip', [
        { name: 'a', data: Buffer.from('1') },
        { name: 'b', data: Buffer.from('2') },
        { name: 'c', data: Buffer.from('3') },
      ]);
      await expectArchiveError(extract(archive, dest), ARCHIVE_ERROR_CODES.BOMB);
    });

    it('rejects a high compression-ratio entry before writing it to disk', async () => {
      // 256 KiB of zeros deflates to a few hundred bytes — ratio well over 100.
      const archive = writeArchive('ratio.zip', [
        { name: 'bomb.bin', data: Buffer.alloc(256 * 1024, 0), method: 8 },
      ]);
      await expectArchiveError(safeExtract(archive, dest), ARCHIVE_ERROR_CODES.BOMB);
      expect(existsSync(join(dest, 'bomb.bin'))).toBe(false);
    });

    it('maps a declared-vs-actual size mismatch to ERR_ARCHIVE_BOMB and unlinks the partial file', async () => {
      const archive = writeArchive('size-mismatch.zip', [
        {
          name: 'partial.bin',
          data: Buffer.from('short'),
          declaredUncompressedSize: 100,
        },
      ]);

      await expectArchiveError(safeExtract(archive, dest), ARCHIVE_ERROR_CODES.BOMB);
      expect(existsSync(join(dest, 'partial.bin'))).toBe(false);
    });
  });

  describe('AbortSignal support', () => {
    it('honors a pre-aborted signal before opening or creating the destination', async () => {
      const archive = writeArchive('aborted.zip', [{ name: 'never.txt', data: Buffer.from('x') }]);
      const neverCreated = join(base, 'never-created');
      const controller = new AbortController();
      controller.abort();

      await expectArchiveError(
        safeExtract(archive, neverCreated, { signal: controller.signal }),
        ARCHIVE_ERROR_CODES.ABORTED,
      );
      expect(existsSync(neverCreated)).toBe(false);
    });

    it('maps a mid-extraction pipeline abort to ERR_ARCHIVE_ABORTED and unlinks the partial file', async () => {
      const archive = writeArchive('abort-mid-stream.zip', [
        { name: 'partial.bin', data: Buffer.from('complete bytes') },
      ]);
      const controller = new AbortController();
      const partialPath = join(dest, 'partial.bin');

      vi.resetModules();
      vi.doMock('node:stream/promises', () => ({
        pipeline: async (
          _readStream: unknown,
          writeStream: NodeJS.WritableStream,
          options: { signal?: AbortSignal } = {},
        ) => {
          await new Promise<void>((resolve, reject) => {
            writeStream.once('open', () => resolve());
            writeStream.once('error', reject);
          });
          writeStream.write(Buffer.from('partial bytes'));
          await new Promise<void>((resolve) => writeStream.end(resolve));
          expect(existsSync(partialPath)).toBe(true);
          expect(options.signal).toBe(controller.signal);
          controller.abort();
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          throw err;
        },
      }));

      try {
        const mocked = await import('../../electron/main/importers/safe-extract');
        let thrown: unknown;
        try {
          await mocked.safeExtract(archive, dest, { signal: controller.signal });
        } catch (err) {
          thrown = err;
        }

        expect(thrown).toBeInstanceOf(mocked.ArchiveError);
        expect((thrown as ArchiveError).code).toBe(ARCHIVE_ERROR_CODES.ABORTED);
        expect(existsSync(partialPath)).toBe(false);
      } finally {
        vi.doUnmock('node:stream/promises');
        vi.resetModules();
      }
    });
  });

  // ── Corrupt / non-zip input ───────────────────────────────────────────────
  describe('corrupt input → ERR_ARCHIVE_CORRUPT', () => {
    it('rejects a file that is not a valid zip', async () => {
      const archive = join(base, 'corrupt.zip');
      writeFileSync(archive, Buffer.from('this is definitely not a zip archive'));
      await expectArchiveError(safeExtract(archive, dest), ARCHIVE_ERROR_CODES.CORRUPT);
    });

    it('unlinks a partial file when a stream fails after extraction has begun', async () => {
      const archive = writeArchive('bad-stream.zip', [
        {
          name: 'partial.txt',
          data: Buffer.from('hello world'),
          method: 8,
          compressedOverride: Buffer.concat([
            deflateRawSync(Buffer.from('hello world')).subarray(0, 4),
            Buffer.from([0xff, 0xff, 0xff, 0xff]),
          ]),
        },
      ]);

      await expectArchiveError(safeExtract(archive, dest), ARCHIVE_ERROR_CODES.CORRUPT);
      expect(existsSync(join(dest, 'partial.txt'))).toBe(false);
    });

    it('rejects a missing archive file', async () => {
      await expectArchiveError(
        safeExtract(join(base, 'does-not-exist.zip'), dest),
        ARCHIVE_ERROR_CODES.CORRUPT,
      );
    });
  });

  // ── Policy: caps and codes must never be silently weakened ────────────────
  describe('policy surface (ADR-0006)', () => {
    it('exposes the documented default caps', () => {
      expect(DEFAULT_ARCHIVE_LIMITS).toEqual({
        maxEntryBytes: 500 * 1024 * 1024,
        maxTotalBytes: 2 * 1024 * 1024 * 1024,
        maxEntries: 100_000,
        maxCompressionRatio: 100,
      });
    });

    it('exposes the stable ERR_ARCHIVE_* error codes', () => {
      expect(ARCHIVE_ERROR_CODES).toEqual({
        UNSAFE_PATH: 'ERR_ARCHIVE_UNSAFE_PATH',
        BOMB: 'ERR_ARCHIVE_BOMB',
        SYMLINK: 'ERR_ARCHIVE_SYMLINK',
        CORRUPT: 'ERR_ARCHIVE_CORRUPT',
        ABORTED: 'ERR_ARCHIVE_ABORTED',
      });
    });

    it('strips C0/C1 control characters from entry names in error details', async () => {
      const archive = writeArchive('control-detail.zip', [
        { name: 'bad\u001b\u0085name/../evil.txt', data: Buffer.from('x') },
      ]);

      const err = await expectArchiveError(
        safeExtract(archive, dest),
        ARCHIVE_ERROR_CODES.UNSAFE_PATH,
      );

      expect(err.message).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/u);
    });
  });
});
