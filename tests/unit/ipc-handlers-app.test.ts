import { describe, expect, it } from 'vitest';
import { handleCapabilities, handleGetVersion } from '../../electron/main/ipc/handlers/app';

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

describe('handleCapabilities (app:capabilities handler logic, #441)', () => {
  const HEALTHY = {
    ffmpeg: true,
    ffprobe: true,
    clusterWorker: true,
    embedder: true,
    gazetteer: true,
  } as const;

  it('returns the injected capability report, shaped + validated to the contract', () => {
    expect(handleCapabilities({ getCapabilities: () => ({ ...HEALTHY }) })).toEqual(HEALTHY);
  });

  it('passes a partially-degraded report straight through (the surface the UI reads)', () => {
    const degraded = { ...HEALTHY, ffmpeg: false, clusterWorker: false };
    expect(handleCapabilities({ getCapabilities: () => degraded })).toEqual(degraded);
  });

  it('refuses a malformed report (defensive: the strict response schema rejects it)', () => {
    expect(() =>
      handleCapabilities({ getCapabilities: () => ({ ffmpeg: true }) as never }),
    ).toThrow();
  });
});
