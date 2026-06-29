import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createConsentStore } from '../../electron/main/transcription/consent-store';
import { makeTmpDir, removeTmpDir } from '../helpers/tmp';

describe('transcription consent store (durable opt-in — gates start AND download, AC-22)', () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = makeTmpDir('consent-');
    filePath = join(dir, 'nested', 'transcription-consent.json');
  });
  afterEach(() => removeTmpDir(dir));

  it('defaults to opted-OUT when no choice has ever been persisted', () => {
    const store = createConsentStore({ filePath });
    expect(store.isOptedIn()).toBe(false);
  });

  it('persists an explicit opt-in durably (a fresh store over the same file reads it back)', () => {
    createConsentStore({ filePath }).setOptedIn(true);
    // A brand-new store instance (mirrors the next app launch) sees the choice.
    expect(createConsentStore({ filePath }).isOptedIn()).toBe(true);
  });

  it('can be turned back off', () => {
    const store = createConsentStore({ filePath });
    store.setOptedIn(true);
    store.setOptedIn(false);
    expect(store.isOptedIn()).toBe(false);
    expect(createConsentStore({ filePath }).isOptedIn()).toBe(false);
  });

  it('treats a corrupt consent file as opted-out (calm default, never throws)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const flat = join(dir, 'flat.json');
    writeFileSync(flat, '{ not valid json');
    const store = createConsentStore({ filePath: flat });
    expect(() => store.isOptedIn()).not.toThrow();
    expect(store.isOptedIn()).toBe(false);
    warn.mockRestore();
  });

  it('does not leak the absolute consent path when real filesystem reads fail', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const blocker = join(dir, 'not-a-directory');
    writeFileSync(blocker, 'file blocks child path');
    const blockedPath = join(blocker, 'transcription-consent.json');

    expect(createConsentStore({ filePath: blockedPath }).isOptedIn()).toBe(false);

    const serializedLogs = JSON.stringify(warn.mock.calls);
    const diagnosticCodes = warn.mock.calls.flatMap((call) =>
      call
        .filter((entry): entry is { code: string } => typeof entry === 'object' && entry !== null && 'code' in entry)
        .map((entry) => entry.code),
    );
    expect(diagnosticCodes.filter((code) => !['ENOTDIR', 'ENOENT'].includes(code))).toEqual([]);
    expect(serializedLogs).not.toContain(blockedPath);
    expect(serializedLogs).not.toContain(dir);
    warn.mockRestore();
  });

  it('logs malformed JSON diagnostics without passing a raw Error object', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const malformed = join(dir, 'malformed.json');
    writeFileSync(malformed, '{ not valid json');

    expect(createConsentStore({ filePath: malformed }).isOptedIn()).toBe(false);

    expect(warn).toHaveBeenCalledWith(
      '[kawsay] transcription consent was malformed; treating as opted-out',
      expect.not.objectContaining({ stack: expect.any(String) }),
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain(malformed);
    warn.mockRestore();
  });

  it('does not throw when persisting fails — writes are best-effort (#160)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // The header contract promises a write failure "must not crash the calm main
    // process". A read-only / unwritable location surfaces as a throwing
    // mkdirSync or writeFileSync; setOptedIn must swallow it (fail-closed: the
    // choice simply is not persisted) rather than propagate.
    const failingMkdir = createConsentStore({
      filePath,
      fs: {
        readFileSync: () => {
          throw new Error('unused');
        },
        writeFileSync: () => undefined,
        mkdirSync: () => {
          throw new Error('EACCES: permission denied, mkdir');
        },
      },
    });
    expect(() => failingMkdir.setOptedIn(true)).not.toThrow();

    const failingWrite = createConsentStore({
      filePath,
      fs: {
        readFileSync: () => {
          throw new Error('unused');
        },
        writeFileSync: () => {
          throw new Error('EROFS: read-only file system, write');
        },
        mkdirSync: () => undefined,
      },
    });
    expect(() => failingWrite.setOptedIn(true)).not.toThrow();
    warn.mockRestore();
  });
});
