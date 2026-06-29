import { describe, expect, it, vi } from 'vitest';
import { createConsentStore, type ConsentStoreFs } from '../../electron/main/transcription/consent-store';

function fsDouble(overrides: Partial<ConsentStoreFs>): ConsentStoreFs {
  return {
    readFileSync: () => '{"transcriptionOptedIn": true}',
    writeFileSync: () => undefined,
    mkdirSync: () => undefined,
    ...overrides,
  };
}

describe('transcription consent store observability (#170)', () => {
  it('fails closed and logs a path-free diagnostic when consent JSON is unreadable', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = createConsentStore({
      filePath: '/Users/alice/Library/Application Support/Kawsay/transcription-consent.json',
      fs: fsDouble({
        readFileSync: () => {
          throw new Error('EACCES');
        },
      }),
    });

    expect(store.isOptedIn()).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      '[kawsay] transcription consent could not be read; treating as opted-out',
      expect.any(Error),
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain('/Users/alice');
    warn.mockRestore();
  });

  it('fails closed and logs a path-free diagnostic when consent JSON is malformed', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = createConsentStore({
      filePath: '/Users/alice/Library/Application Support/Kawsay/transcription-consent.json',
      fs: fsDouble({ readFileSync: () => '{ nope' }),
    });

    expect(store.isOptedIn()).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      '[kawsay] transcription consent was malformed; treating as opted-out',
      expect.any(Error),
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain('/Users/alice');
    warn.mockRestore();
  });

  it('logs a path-free diagnostic when persisting consent fails', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const path = '/Users/alice/Library/Application Support/Kawsay/transcription-consent.json';
    const store = createConsentStore({
      filePath: path,
      fs: fsDouble({
        writeFileSync: () => {
          const error = new Error(`EACCES: permission denied, open '${path}'`) as NodeJS.ErrnoException;
          error.code = 'EACCES';
          error.path = path;
          throw error;
        },
      }),
    });

    expect(() => store.setOptedIn(true)).not.toThrow();
    expect(warn).toHaveBeenCalledWith(
      '[kawsay] could not persist transcription consent; future launches may remain opted-out',
      { code: 'EACCES', name: 'Error' },
    );
    expect(warn.mock.calls.flat().map(String).join('\n')).not.toContain('/Users/alice');
    warn.mockRestore();
  });
});
