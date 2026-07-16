// Durable, on-disk record of the app-wide UX settings the Settings view exposes
// (AC-13 / Journey G, #433): the text-size step and the reduced-motion override.
// Mirrors the M2 consent store (`../transcription/consent-store.ts`) exactly —
// a single tiny JSON file, no new dependency, no DB migration — but generalised
// from one boolean key to a small typed snapshot, since these two preferences
// naturally live together and are always read/written as a pair by the renderer.
//
// Reads are defensive PER FIELD (not "any problem ⇒ discard everything"): a
// missing file, unreadable file, or malformed JSON all resolve to the calm
// baseline, and — even inside an otherwise well-formed file — an out-of-range
// `textSize` or a non-boolean `reducedMotion` falls back to ITS OWN default
// while the other, valid field is kept. So one field never gets NUKED by
// corruption in the other.
//
// The filesystem is injected (defaulting to node:fs) so the store unit-tests
// without touching a real home directory, and writes are best-effort: a write
// failure must not crash the calm main process, and `set()` always re-reads
// afterward so the echoed result is the actual on-disk TRUTH — never a lie
// about what didn't persist.

import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  type WriteFileOptions,
} from 'node:fs';
import { dirname } from 'node:path';
import { log } from '../log';

/** The named, reverent text-size steps (mirrors `shared/ipc/schemas.ts`). */
export const TEXT_SIZE_STEPS = ['default', 'large', 'larger'] as const;
export type TextSizeStep = (typeof TEXT_SIZE_STEPS)[number];

/** The full persisted settings snapshot. */
export interface SettingsSnapshot {
  textSize: TextSizeStep;
  reducedMotion: boolean;
}

/** The slice of `node:fs` the store needs (injected for testability). */
export interface SettingsStoreFs {
  readFileSync(path: string, encoding: 'utf8'): string;
  writeFileSync(path: string, data: string, options?: WriteFileOptions): void;
  mkdirSync(path: string, options: { recursive: true }): string | undefined;
}

export interface SettingsStoreOptions {
  /** Absolute path of the settings JSON file (under the app's userData dir in prod). */
  filePath: string;
  /** Filesystem seam (defaults to node:fs). */
  fs?: SettingsStoreFs;
}

/** The durable settings store the Settings view + `usePrefersReducedMotion` reflect. */
export interface SettingsStore {
  /** Read the current durable snapshot (defaults for absent/corrupt config). */
  get(): SettingsSnapshot;
  /** Merge `patch` onto the durable snapshot, persist it, and return the RESOLVED
   *  (re-read) snapshot — the truth, even when the write itself failed. */
  set(patch: Partial<SettingsSnapshot>): SettingsSnapshot;
}

const DEFAULT_SETTINGS: SettingsSnapshot = { textSize: 'default', reducedMotion: false };

const DEFAULT_FS: SettingsStoreFs = {
  readFileSync: (path, encoding) => readFileSync(path, encoding),
  writeFileSync: (path, data, options) => writeFileSync(path, data, options),
  mkdirSync: (path, options) => mkdirSync(path, options),
};

function isTextSizeStep(value: unknown): value is TextSizeStep {
  return typeof value === 'string' && (TEXT_SIZE_STEPS as readonly string[]).includes(value);
}

/**
 * Build the durable settings store over `filePath`. Reads are defensive per
 * field: a missing file, unreadable file, or malformed JSON all resolve to the
 * calm baseline, and any individually out-of-range field falls back to its own
 * default while a sibling valid field is preserved.
 */
export function createSettingsStore(options: SettingsStoreOptions): SettingsStore {
  const fs = options.fs ?? DEFAULT_FS;
  const { filePath } = options;

  function read(): SettingsSnapshot {
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
      // No file yet (or unreadable) ⇒ the calm baseline.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn(
          '[kawsay]',
          'settings',
          'could not be read; falling back to the default settings',
          error,
        );
      }
      return { ...DEFAULT_SETTINGS };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      log.warn(
        '[kawsay]',
        'settings',
        'was malformed; falling back to the default settings',
        error,
      );
      return { ...DEFAULT_SETTINGS };
    }
    // A syntactically-valid but NON-object top-level JSON (`null`, a number, a
    // string, a boolean, an array) parses without a SyntaxError, so it slips
    // past the try/catch above. Guard the shape before dereferencing a field —
    // otherwise `parsed['textSize']` throws a TypeError out of read() and
    // rejects the renderer invoke, breaking the "malformed ⇒ calm baseline,
    // never a throw" invariant. (`typeof null === 'object'`, so null is checked
    // explicitly; arrays are objects too but carry no named fields, so they
    // resolve to defaults per-field anyway — excluded here for clarity.)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      log.warn(
        '[kawsay]',
        'settings',
        'was not a settings object; falling back to the default settings',
      );
      return { ...DEFAULT_SETTINGS };
    }
    const record = parsed as Record<string, unknown>;
    return {
      textSize: isTextSizeStep(record['textSize']) ? record['textSize'] : DEFAULT_SETTINGS.textSize,
      reducedMotion:
        typeof record['reducedMotion'] === 'boolean'
          ? record['reducedMotion']
          : DEFAULT_SETTINGS.reducedMotion,
    };
  }

  function write(next: SettingsSnapshot): void {
    try {
      fs.mkdirSync(dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    } catch (error) {
      // Best-effort (header contract): an unwritable location must not crash the
      // calm main process. The change simply is not persisted — a relaunch (or
      // even the very next read in THIS run) reads the prior value — and we
      // leave a diagnostic rather than throwing out of the seam.
      log.warn(
        '[kawsay] could not persist',
        'settings',
        '; future launches may not reflect this change',
        error,
      );
    }
  }

  return {
    get() {
      return read();
    },
    set(patch) {
      const next: SettingsSnapshot = { ...read(), ...patch };
      write(next);
      // Re-read rather than trusting `next`: if the write failed, this reports
      // the actual on-disk truth (the prior snapshot), never an unpersisted lie.
      return read();
    },
  };
}
