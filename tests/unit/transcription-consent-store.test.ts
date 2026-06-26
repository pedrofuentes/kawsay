import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
    const flat = join(dir, 'flat.json');
    writeFileSync(flat, '{ not valid json');
    const store = createConsentStore({ filePath: flat });
    expect(() => store.isOptedIn()).not.toThrow();
    expect(store.isOptedIn()).toBe(false);
  });
});
