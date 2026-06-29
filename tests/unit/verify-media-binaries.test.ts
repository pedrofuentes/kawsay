import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ffmpegLicenseFailures } from '../../scripts/verify-media-binaries.mjs';

describe('media binary verifier nonfree guard (#181)', () => {
  it('rejects ffmpeg builds whose buildconf enables nonfree', () => {
    const failures = ffmpegLicenseFailures(
      'mac-arm64/ffmpeg',
      '/repo/resources/media/mac-arm64/ffmpeg',
      () => `ffmpeg version n7.1\nconfiguration: --disable-nonfree --enable-nonfree\n`,
      () => 'fixture notices',
    );

    expect(failures).toEqual([
      'NONFREE mac-arm64/ffmpeg: ffmpeg -L/build configuration contains nonfree/not legally redistributable (/repo/resources/media/mac-arm64/ffmpeg)',
    ]);
  });

  it('rejects ffmpeg builds that report nonfree parts', () => {
    const failures = ffmpegLicenseFailures(
      'mac-x64/ffmpeg',
      '/repo/resources/media/mac-x64/ffmpeg',
      () => `ffmpeg version n7.1\nThis version of ffmpeg has nonfree parts compiled in.\n`,
      () => 'fixture notices',
    );

    expect(failures).toEqual([
      'NONFREE mac-x64/ffmpeg: ffmpeg -L/build configuration contains nonfree/not legally redistributable (/repo/resources/media/mac-x64/ffmpeg)',
    ]);
  });

  it('rejects ffmpeg builds that report they are not legally redistributable', () => {
    const failures = ffmpegLicenseFailures(
      'mac-x64/ffmpeg',
      '/repo/resources/media/mac-x64/ffmpeg',
      () => `ffmpeg version n7.1\nTherefore it is not legally redistributable.\n`,
      () => 'fixture notices',
    );

    expect(failures).toEqual([
      'NONFREE mac-x64/ffmpeg: ffmpeg -L/build configuration contains nonfree/not legally redistributable (/repo/resources/media/mac-x64/ffmpeg)',
    ]);
  });

  it('rejects GPL-enabled ffmpeg when NOTICES says the build is LGPL-only (#183)', () => {
    const failures = ffmpegLicenseFailures(
      'mac-arm64/ffmpeg',
      '/repo/resources/media/mac-arm64/ffmpeg',
      () => `ffmpeg version n7.1\nconfiguration: --enable-gpl --disable-nonfree\n`,
      () => `Configure policy: LGPL-only (\`--disable-gpl\`, \`--disable-nonfree\`)`,
    );

    expect(failures).toEqual([
      'GPL-MISMATCH mac-arm64/ffmpeg: ffmpeg build configuration enables GPL while NOTICES declares LGPL-only (/repo/resources/media/mac-arm64/ffmpeg)',
    ]);
  });

  it('rejects GPL-enabled macOS source builds based on build configuration, not NOTICES phrasing', () => {
    const failures = ffmpegLicenseFailures(
      'mac-arm64/ffmpeg',
      '/repo/resources/media/mac-arm64/ffmpeg',
      () => `ffmpeg version n7.1\nconfiguration: --enable-gpl --disable-nonfree\n`,
      () => `Kawsay ships a source-built ffmpeg binary with pinned configure flags.`,
    );

    expect(failures).toEqual([
      'GPL-MISMATCH mac-arm64/ffmpeg: ffmpeg build configuration enables GPL while macOS ffmpeg must be LGPL-only (/repo/resources/media/mac-arm64/ffmpeg)',
    ]);
  });

  it('accepts a clean LGPL-only ffmpeg build that matches NOTICES (#184)', () => {
    const failures = ffmpegLicenseFailures(
      'mac-arm64/ffmpeg',
      '/repo/resources/media/mac-arm64/ffmpeg',
      () =>
        `ffmpeg version n7.1
configuration: --disable-gpl --disable-nonfree
ffmpeg is free software; you can redistribute it and/or modify it under the terms of the GNU Lesser General Public License
`,
      () => `Configure policy: LGPL-only (\`--disable-gpl\`, \`--disable-nonfree\`)`,
    );

    expect(failures).toEqual([]);
  });

  it('keeps an isolated NOTICES fixture aligned with the LGPL-only macOS ffmpeg guard', () => {
    const notices = readFileSync(
      fileURLToPath(new URL('../fixtures/media/NOTICES.lgpl-only.md', import.meta.url)),
      'utf8',
    );

    expect(notices).toMatch(/Configure policy: LGPL-only \(`--disable-gpl`, `--disable-nonfree`/);
    expect(notices).toMatch(/build guard rejects `--enable-nonfree`/);
  });
});
