import { describe, expect, it } from 'vitest';
import { handleGetVersion } from '../../electron/main/ipc/handlers/app';

describe('handleGetVersion (app:getVersion handler logic)', () => {
  it('returns the version reported by the injected app, shaped to the contract', () => {
    const result = handleGetVersion({ getVersion: () => '0.1.0' });
    expect(result).toEqual({ version: '0.1.0' });
  });

  it('reflects whatever the injected dependency reports', () => {
    const result = handleGetVersion({ getVersion: () => '9.9.9-beta.2' });
    expect(result).toEqual({ version: '9.9.9-beta.2' });
  });

  it('refuses to emit an empty version (defensive: response schema demands a non-empty string)', () => {
    expect(() => handleGetVersion({ getVersion: () => '' })).toThrow();
  });
});
