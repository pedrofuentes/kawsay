// Unit tests for the categorization opt-in consent store (T-M4-2h / #270). Like
// smart search, categorization REUSES the parameterized M2 consent store with its
// OWN key + label + file, so opting in to one never implies the other. The calm,
// privacy-preserving default — for an absent OR corrupt config — is OPTED-OUT, so
// categorization never runs until an explicit, well-formed opt-in.
import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { createCategorizationConsentStore } from '../../electron/main/categorize/categorization-consent';
import {
  CATEGORIZATION_CONSENT_KEY,
  CATEGORIZATION_CONSENT_LABEL,
} from '../../electron/main/categorize/categorization-orchestrator';
import type { ConsentStoreFs } from '../../electron/main/transcription/consent-store';

function memoryFs(files = new Map<string, string>()): { fs: ConsentStoreFs; files: Map<string, string> } {
  const fs: ConsentStoreFs = {
    readFileSync: (path) => {
      const value = files.get(path);
      if (value === undefined) {
        const error = new Error('ENOENT') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      }
      return value;
    },
    writeFileSync: (path, data) => {
      files.set(path, String(data));
    },
    mkdirSync: () => undefined,
  };
  return { fs, files };
}

describe('createCategorizationConsentStore (its own opt-in, independent of the others)', () => {
  it('reuses the #269 consent key + label constants (does not reinvent them)', () => {
    expect(CATEGORIZATION_CONSENT_KEY).toBe('categorizationOptedIn');
    expect(CATEGORIZATION_CONSENT_LABEL).toBe('categorization');
    expect(CATEGORIZATION_CONSENT_KEY).not.toBe('transcriptionOptedIn');
    expect(CATEGORIZATION_CONSENT_KEY).not.toBe('smartSearchOptedIn');
  });

  it('defaults OPTED-OUT and persists under its OWN key', () => {
    const { fs, files } = memoryFs();
    const filePath = join('/userData', 'categorization-consent.json');
    const store = createCategorizationConsentStore({ filePath, fs });

    expect(store.isOptedIn()).toBe(false); // calm default: opted OUT
    store.setOptedIn(true);
    expect(store.isOptedIn()).toBe(true);
    expect(files.get(filePath)).toContain('categorizationOptedIn');
    expect(files.get(filePath)).not.toContain('transcriptionOptedIn');
    expect(files.get(filePath)).not.toContain('smartSearchOptedIn');
  });

  it('treats a corrupt config as OPTED-OUT (never a crash)', () => {
    const files = new Map<string, string>([
      [join('/userData', 'categorization-consent.json'), '{ this is not json'],
    ]);
    const { fs } = memoryFs(files);
    const store = createCategorizationConsentStore({
      filePath: join('/userData', 'categorization-consent.json'),
      fs,
    });
    expect(store.isOptedIn()).toBe(false);
  });
});
