import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { MODEL_SHA256, MODEL_SIZE_BYTES } from './model-source';

/**
 * Integrity verification for the opt-in transcription model (ADR-0027 Decision 6b
 * / AC-24). The app NEVER runs an unverified model: a downloaded file is hashed
 * and matched against the pinned SHA-256 before it is installed, and re-validated
 * before EACH `whisper-cli` spawn (post-install on-disk tampering / bit-rot is in
 * the threat model, not only the download). This module is the shared verifier for
 * both seams.
 *
 * Deliberately pure + injectable: the size probe and the hasher are parameters so
 * the gate is unit-tested without materialising a 466 MiB file, and so the cheap
 * size pre-gate can be proven to short-circuit before any hashing happens.
 */

/** Why a file did (not) verify. `ok` is the only passing reason. */
export type ModelVerificationReason = 'ok' | 'missing' | 'size-mismatch' | 'hash-mismatch';

export interface ModelVerification {
  /** True only when the file exists AND its size AND its SHA-256 all match. */
  readonly valid: boolean;
  readonly reason: ModelVerificationReason;
  /** The file's actual byte size, or null when it is missing/unreadable. */
  readonly actualSize: number | null;
  /** The file's actual SHA-256, or null when size already disqualified it (or it is missing). */
  readonly actualSha256: string | null;
}

/** The expected, pinned integrity facts a file is checked against. */
export interface ModelIntegrityExpectation {
  readonly sha256: string;
  readonly size: number;
}

/** Injectable I/O so the verifier is testable without a real 466 MiB file. */
export interface ModelIntegrityDeps {
  /** Return a file's byte size, or null if it does not exist / cannot be stat'd. */
  readonly statSize?: (path: string) => Promise<number | null>;
  /** Compute a file's SHA-256 (lowercase hex). */
  readonly hashFile?: (path: string) => Promise<string>;
}

/**
 * Streaming SHA-256 → lowercase hex. Streamed so the ~466 MiB model is hashed with
 * bounded memory (mirrors `importers/deps/hash.ts`). Rejects if the file is absent
 * or unreadable.
 */
export function hashFileSha256(path: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('error', reject);
    stream.on('data', (chunk: string | Buffer) => hash.update(chunk));
    stream.on('end', () => {
      resolve(hash.digest('hex'));
    });
  });
}

async function defaultStatSize(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size;
  } catch {
    return null;
  }
}

/**
 * Verify a file against an expected SHA-256 + byte size. Never throws — a missing
 * or unreadable file is reported as `valid: false`. The **size is checked first**
 * as a cheap pre-gate: a wrong-size file is rejected WITHOUT hashing (no point
 * reading 466 MiB to learn the size already disqualified it).
 */
export async function verifyModelFile(
  path: string,
  expected: ModelIntegrityExpectation,
  deps: ModelIntegrityDeps = {},
): Promise<ModelVerification> {
  const statSize = deps.statSize ?? defaultStatSize;
  const hashFile = deps.hashFile ?? hashFileSha256;

  const actualSize = await statSize(path);
  if (actualSize === null) {
    return { valid: false, reason: 'missing', actualSize: null, actualSha256: null };
  }
  if (actualSize !== expected.size) {
    return { valid: false, reason: 'size-mismatch', actualSize, actualSha256: null };
  }

  let actualSha256: string;
  try {
    actualSha256 = await hashFile(path);
  } catch {
    // The file vanished/became unreadable between the stat and the hash.
    return { valid: false, reason: 'missing', actualSize, actualSha256: null };
  }
  if (actualSha256 !== expected.sha256) {
    return { valid: false, reason: 'hash-mismatch', actualSize, actualSha256 };
  }
  return { valid: true, reason: 'ok', actualSize, actualSha256 };
}

/**
 * Verify a file on disk against the **pinned** model integrity (ADR-0027 / AC-24).
 * This is the function the transcription worker (card #134) calls before EACH
 * `whisper-cli` spawn to guard against post-install on-disk tampering.
 */
export function verifyModelOnDisk(
  path: string,
  deps: ModelIntegrityDeps = {},
): Promise<ModelVerification> {
  return verifyModelFile(path, { sha256: MODEL_SHA256, size: MODEL_SIZE_BYTES }, deps);
}
