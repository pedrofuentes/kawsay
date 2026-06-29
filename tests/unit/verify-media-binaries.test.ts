import { describe, expect, it } from 'vitest';
import { ffmpegLicenseFailures } from '../../scripts/verify-media-binaries.mjs';

describe('media binary verifier nonfree guard (#181)', () => {
  it('rejects ffmpeg builds that report nonfree or not legally redistributable', () => {
    const failures = ffmpegLicenseFailures(
      'mac-arm64/ffmpeg',
      '/repo/resources/media/mac-arm64/ffmpeg',
      () => `ffmpeg version n7.1\nbuilt with Apple clang\nconfiguration: --disable-nonfree --enable-nonfree\nThis version of ffmpeg has nonfree parts compiled in.\nTherefore it is not legally redistributable.`,
    );

    expect(failures).toEqual([
      'NONFREE mac-arm64/ffmpeg: ffmpeg -L/build configuration contains nonfree/not legally redistributable (/repo/resources/media/mac-arm64/ffmpeg)',
    ]);
  });
});
