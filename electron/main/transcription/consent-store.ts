// Durable, on-disk record of the user's transcription opt-in (AC-22, #157). The
// consent UI (#132/#146) only toggles ephemeral state; this is the persistent seam
// the gate reads, so the choice survives a relaunch and transcription NEVER runs
// unless the user has explicitly turned it on. The default — for an absent OR
// corrupt file — is the calm, privacy-preserving OPTED-OUT, so a damaged config can
// never silently start on-device transcription. It is a single tiny JSON file
// (`{ "transcriptionOptedIn": boolean }`); no new dependency, no DB migration.
//
// The filesystem is injected (defaulting to node:fs) so the store unit-tests
// without touching a real home directory, and writes are best-effort: a write
// failure must not crash the calm main process.

import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  type WriteFileOptions,
} from 'node:fs';
import { dirname } from 'node:path';

/** The persisted shape — one boolean, nothing else. */
interface ConsentFile {
  transcriptionOptedIn: boolean;
}

/** The slice of `node:fs` the store needs (injected for testability). */
export interface ConsentStoreFs {
  readFileSync(path: string, encoding: 'utf8'): string;
  writeFileSync(path: string, data: string, options?: WriteFileOptions): void;
  mkdirSync(path: string, options: { recursive: true }): string | undefined;
}

export interface ConsentStoreOptions {
  /** Absolute path of the consent JSON file (under the app's userData dir in prod). */
  filePath: string;
  /** Filesystem seam (defaults to node:fs). */
  fs?: ConsentStoreFs;
}

/** The durable opt-in store the transcription gate consults. */
export interface ConsentStore {
  /** True iff the user has explicitly opted in (false for absent/corrupt config). */
  isOptedIn(): boolean;
  /** Persist the opt-in choice durably (creating parent dirs as needed). */
  setOptedIn(value: boolean): void;
}

const DEFAULT_FS: ConsentStoreFs = {
  readFileSync: (path, encoding) => readFileSync(path, encoding),
  writeFileSync: (path, data, options) => writeFileSync(path, data, options),
  mkdirSync: (path, options) => mkdirSync(path, options),
};

/**
 * Build the durable consent store over `filePath`. Reads are defensive: a missing
 * file, unreadable file, or malformed JSON all resolve to OPTED-OUT (never a
 * throw), so transcription stays off until an explicit, well-formed opt-in.
 */
export function createConsentStore(options: ConsentStoreOptions): ConsentStore {
  const fs = options.fs ?? DEFAULT_FS;
  const { filePath } = options;

  function read(): boolean {
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
      // No file yet (or unreadable) ⇒ never opted in.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('[kawsay] transcription consent could not be read; treating as opted-out', error);
      }
      return false;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<ConsentFile>;
      return parsed.transcriptionOptedIn === true;
    } catch (error) {
      // A corrupt file is treated as opted-out — calm default, never a crash.
      console.warn('[kawsay] transcription consent was malformed; treating as opted-out', error);
      return false;
    }
  }

  return {
    isOptedIn() {
      return read();
    },
    setOptedIn(value) {
      const payload: ConsentFile = { transcriptionOptedIn: value };
      try {
        fs.mkdirSync(dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
      } catch (error) {
        // Best-effort (header contract): an unwritable location must not crash the
        // calm main process. Fail closed — the choice simply is not persisted (a
        // relaunch reads the prior/absent value, defaulting to opted-OUT) — and
        // leave a diagnostic rather than throwing out of the seam.
        console.warn(
          '[kawsay] could not persist transcription consent; future launches may remain opted-out',
          error,
        );
      }
    },
  };
}
