import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  hashFileSha256,
  verifyModelFile,
  verifyModelOnDisk,
} from '../../electron/main/transcription/model-integrity';
import {
  MODEL_SHA256,
  MODEL_SIZE_BYTES,
} from '../../electron/main/transcription/model-source';
import { makeTmpDir, removeTmpDir } from '../helpers/tmp';

const sha256 = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

describe('hashFileSha256 — streaming SHA-256 over a file', () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTmpDir('model-hash-');
  });
  afterEach(() => {
    removeTmpDir(dir);
  });

  it('matches a known SHA-256 of the file bytes', async () => {
    const bytes = Buffer.from('a small fake model payload', 'utf8');
    const path = join(dir, 'fake.bin');
    writeFileSync(path, bytes);
    expect(await hashFileSha256(path)).toBe(sha256(bytes));
  });

  it('rejects when the file does not exist', async () => {
    await expect(hashFileSha256(join(dir, 'absent.bin'))).rejects.toThrow();
  });
});

describe('verifyModelFile — integrity gate (ADR-0027 Decision 6b)', () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTmpDir('model-verify-');
  });
  afterEach(() => {
    removeTmpDir(dir);
  });

  function writeFixture(name: string, bytes: Uint8Array): string {
    const path = join(dir, name);
    writeFileSync(path, bytes);
    return path;
  }

  it('passes a file whose size AND hash match the expected values', async () => {
    const bytes = Buffer.from('the exact expected bytes', 'utf8');
    const path = writeFixture('ok.bin', bytes);
    const result = await verifyModelFile(path, {
      sha256: sha256(bytes),
      size: bytes.length,
    });
    expect(result).toEqual({
      valid: true,
      reason: 'ok',
      actualSize: bytes.length,
      actualSha256: sha256(bytes),
    });
  });

  it('rejects a size mismatch WITHOUT hashing (cheap pre-hash gate)', async () => {
    const bytes = Buffer.from('too short', 'utf8');
    const path = writeFixture('wrong-size.bin', bytes);
    const hashFile = vi.fn(() => Promise.resolve('unused'));
    const result = await verifyModelFile(
      path,
      { sha256: sha256(bytes), size: bytes.length + 1 },
      { hashFile },
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('size-mismatch');
    expect(result.actualSize).toBe(bytes.length);
    // The hash is never computed when size already disqualifies the file.
    expect(hashFile).not.toHaveBeenCalled();
  });

  it('rejects a hash mismatch when the size matches', async () => {
    const bytes = Buffer.from('right length wrong bytes', 'utf8');
    const path = writeFixture('wrong-hash.bin', bytes);
    const result = await verifyModelFile(path, {
      sha256: 'f'.repeat(64),
      size: bytes.length,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('hash-mismatch');
    expect(result.actualSha256).toBe(sha256(bytes));
  });

  it('reports a missing file as not-valid (never throws)', async () => {
    const result = await verifyModelFile(join(dir, 'absent.bin'), {
      sha256: 'a'.repeat(64),
      size: 10,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('missing');
    expect(result.actualSize).toBeNull();
  });

  it('detects post-install tampering: a once-valid file fails after a byte flips', async () => {
    const bytes = Buffer.from('untampered model bytes here', 'utf8');
    const path = writeFixture('tamper.bin', bytes);
    const expected = { sha256: sha256(bytes), size: bytes.length };
    expect((await verifyModelFile(path, expected)).valid).toBe(true);

    // Flip one byte in place, keeping the size identical — only the hash changes.
    const tampered = Buffer.from(bytes);
    tampered[0] = tampered[0] ^ 0xff;
    writeFileSync(path, tampered);

    const after = await verifyModelFile(path, expected);
    expect(after.valid).toBe(false);
    expect(after.reason).toBe('hash-mismatch');
  });
});

describe('verifyModelOnDisk — verifies against the pinned ADR-0027 constants', () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTmpDir('model-ondisk-');
  });
  afterEach(() => {
    removeTmpDir(dir);
  });

  it('rejects a small stand-in file (size differs from the pinned 487,601,967 bytes)', async () => {
    const path = join(dir, 'ggml-small.bin');
    writeFileSync(path, Buffer.from('not the real 466MiB model', 'utf8'));
    const result = await verifyModelOnDisk(path);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('size-mismatch');
  });

  it('passes only when both the pinned size and pinned hash match (injected hash for the 466MiB stand-in)', async () => {
    // Exercise the pinned-constant path without materialising 466 MiB: report the
    // pinned size via an injected stat and the pinned hash via an injected hasher.
    const path = join(dir, 'ggml-small.bin');
    writeFileSync(path, Buffer.from('stand-in', 'utf8'));
    const result = await verifyModelOnDisk(path, {
      statSize: () => Promise.resolve(MODEL_SIZE_BYTES),
      hashFile: () => Promise.resolve(MODEL_SHA256),
    });
    expect(result).toEqual({
      valid: true,
      reason: 'ok',
      actualSize: MODEL_SIZE_BYTES,
      actualSha256: MODEL_SHA256,
    });
  });
});
