import { describe, expect, it } from 'vitest';
import { FUSE_CONFIG } from '../../electron/build/fuses';

// The fuses are physically flipped during packaging (card P1, via @electron/fuses);
// here we pin the intended states from ARCHITECTURE §2.5 so the security posture is
// declared, reviewable, and regression-protected before packaging exists.
describe('FUSE_CONFIG (packaged-app hardening states, ARCHITECTURE §2.5)', () => {
  it('disables Node-injection and inspection escape hatches', () => {
    expect(FUSE_CONFIG.runAsNode).toBe(false);
    expect(FUSE_CONFIG.enableNodeOptionsEnvironmentVariable).toBe(false);
    expect(FUSE_CONFIG.enableNodeCliInspectArguments).toBe(false);
  });

  it('enforces ASAR-only loading with embedded integrity validation', () => {
    expect(FUSE_CONFIG.onlyLoadAppFromAsar).toBe(true);
    expect(FUSE_CONFIG.enableEmbeddedAsarIntegrityValidation).toBe(true);
  });

  it('hardens the file protocol and encrypts cookies at rest', () => {
    expect(FUSE_CONFIG.grantFileProtocolExtraPrivileges).toBe(false);
    expect(FUSE_CONFIG.enableCookieEncryption).toBe(true);
  });
});
