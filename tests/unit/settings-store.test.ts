import { describe, expect, it, vi } from 'vitest';
import {
  createSettingsStore,
  type SettingsStoreFs,
} from '../../electron/main/settings/settings-store';

function fsDouble(overrides: Partial<SettingsStoreFs>): SettingsStoreFs {
  return {
    readFileSync: () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
    writeFileSync: () => undefined,
    mkdirSync: () => undefined,
    ...overrides,
  };
}

describe('settings store — defaults (AC-13 / Journey G, #433)', () => {
  it('defaults to the calm baseline when no file exists yet', () => {
    const store = createSettingsStore({
      filePath: '/Users/alice/Library/Application Support/Kawsay/settings.json',
      fs: fsDouble({}),
    });

    expect(store.get()).toEqual({ textSize: 'default', reducedMotion: false });
  });

  it('falls back to defaults when the file is malformed JSON (fails closed, never throws)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = createSettingsStore({
      filePath: '/Users/alice/Library/Application Support/Kawsay/settings.json',
      fs: fsDouble({ readFileSync: () => '{ not json' }),
    });

    expect(store.get()).toEqual({ textSize: 'default', reducedMotion: false });
    warn.mockRestore();
  });

  it('ignores an out-of-range textSize value and falls back to "default"', () => {
    const store = createSettingsStore({
      filePath: '/settings.json',
      fs: fsDouble({
        readFileSync: () => JSON.stringify({ textSize: 'gigantic', reducedMotion: true }),
      }),
    });

    expect(store.get()).toEqual({ textSize: 'default', reducedMotion: true });
  });

  it('ignores a non-boolean reducedMotion value and falls back to false', () => {
    const store = createSettingsStore({
      filePath: '/settings.json',
      fs: fsDouble({
        readFileSync: () => JSON.stringify({ textSize: 'large', reducedMotion: 'yes' }),
      }),
    });

    expect(store.get()).toEqual({ textSize: 'large', reducedMotion: false });
  });
});

describe('settings store — persistence round-trip', () => {
  it('persists a full snapshot and a fresh store instance reads it back (survives a relaunch)', () => {
    let written: string | undefined;
    const fs = fsDouble({
      readFileSync: () => {
        if (written === undefined) {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        }
        return written;
      },
      writeFileSync: (_path, data) => {
        written = data as string;
      },
    });

    const first = createSettingsStore({ filePath: '/settings.json', fs });
    const resolved = first.set({ textSize: 'larger', reducedMotion: true });
    expect(resolved).toEqual({ textSize: 'larger', reducedMotion: true });

    const second = createSettingsStore({ filePath: '/settings.json', fs });
    expect(second.get()).toEqual({ textSize: 'larger', reducedMotion: true });
  });

  it('a partial patch merges onto the current snapshot rather than clobbering it', () => {
    let written: string | undefined;
    const fs = fsDouble({
      readFileSync: () => {
        if (written === undefined) {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        }
        return written;
      },
      writeFileSync: (_path, data) => {
        written = data as string;
      },
    });
    const store = createSettingsStore({ filePath: '/settings.json', fs });

    store.set({ textSize: 'large' });
    const resolved = store.set({ reducedMotion: true });

    expect(resolved).toEqual({ textSize: 'large', reducedMotion: true });
  });

  it('creates the parent directory before writing (mirrors the consent store)', () => {
    const mkdirSync = vi.fn();
    const store = createSettingsStore({
      filePath: '/Users/alice/Library/Application Support/Kawsay/settings.json',
      fs: fsDouble({ mkdirSync }),
    });

    store.set({ textSize: 'large' });

    expect(mkdirSync).toHaveBeenCalledWith(
      '/Users/alice/Library/Application Support/Kawsay',
      { recursive: true },
    );
  });
});

describe('settings store — best-effort writes never throw or leak paths', () => {
  it('a write failure does not throw, and set() echoes the still-unpersisted TRUTH (never lies)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const path = '/Users/alice/Library/Application Support/Kawsay/settings.json';
    const store = createSettingsStore({
      filePath: path,
      fs: fsDouble({
        writeFileSync: () => {
          const error = new Error(`EACCES: permission denied, open '${path}'`) as NodeJS.ErrnoException;
          error.code = 'EACCES';
          throw error;
        },
      }),
    });

    let resolved: unknown;
    expect(() => {
      resolved = store.set({ textSize: 'larger' });
    }).not.toThrow();
    // The write failed, so re-reading (fails closed to ENOENT) still reports the
    // calm default — never the un-persisted 'larger' the caller asked for.
    expect(resolved).toEqual({ textSize: 'default', reducedMotion: false });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('/Users/alice');
    warn.mockRestore();
  });

  it('a read failure other than ENOENT logs a path-free diagnostic', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = createSettingsStore({
      filePath: '/Users/alice/Library/Application Support/Kawsay/settings.json',
      fs: fsDouble({
        readFileSync: () => {
          const error = new Error('EACCES') as NodeJS.ErrnoException;
          error.code = 'EACCES';
          throw error;
        },
      }),
    });

    expect(store.get()).toEqual({ textSize: 'default', reducedMotion: false });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('/Users/alice');
    warn.mockRestore();
  });
});
