import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  MEDIA_RESOURCE_SUBDIR,
  MediaBinaryNotFoundError,
  SUPPORTED_MEDIA_TARGETS as RESOLVER_TARGETS,
  UnsupportedMediaTargetError,
  mediaArchDir,
  mediaBinaryName,
  mediaOsKey,
  resolveFfmpegPath,
  resolveFfprobePath,
} from '../../electron/main/importers/deps/media-binaries';
import {
  SUPPORTED_MEDIA_TARGETS,
  hostMediaTargets,
  sourceBinaryPath,
  stageMediaBinaries,
  targetArch,
} from '../../scripts/stage-media-binaries.mjs';
import { detectBinaryArch } from '../helpers/binary-arch';
import { makeTmpDir, removeTmpDir } from '../helpers/tmp';

// #175 — the packaged v0.2.0 app shipped NO ffmpeg binary at all (pnpm blocked
// ffmpeg-static's download postinstall) and a WRONG-ARCH ffprobe (ffprobe-static
// @3.1.0's darwin/arm64 file is actually Mach-O x86_64), so every transcription
// job and every video thumbnail failed at runtime. Every other suite injects a
// fake `run`/`spawn`, so a missing-or-wrong-arch binary was completely invisible.
// This suite is the regression guard the bug needed: it (1) asserts the install
// provides a correct-arch ffmpeg AND ffprobe for ALL THREE shipped targets —
// directly guarding the cross-arch gap where a single arm64 runner builds the
// x64 dmg too — and (2) resolves the binary the app ACTUALLY spawns (via the
// production resolver) and proves it exists on disk and is the host arch in dev.

describe('media binary resolver — pure platform/arch mapping (#175)', () => {
  it('maps macOS/Windows to the electron-builder ${os} key, rejecting others', () => {
    expect(mediaOsKey('darwin')).toBe('mac');
    expect(mediaOsKey('win32')).toBe('win');
    expect(() => mediaOsKey('linux')).toThrow(UnsupportedMediaTargetError);
  });

  it('appends .exe only on Windows', () => {
    expect(mediaBinaryName('ffmpeg', 'win32')).toBe('ffmpeg.exe');
    expect(mediaBinaryName('ffprobe', 'win32')).toBe('ffprobe.exe');
    expect(mediaBinaryName('ffmpeg', 'darwin')).toBe('ffmpeg');
    expect(mediaBinaryName('ffprobe', 'darwin')).toBe('ffprobe');
  });

  it('produces exactly the three shipped <os>-<arch> bundle directories', () => {
    expect(mediaArchDir('darwin', 'arm64')).toBe('mac-arm64');
    expect(mediaArchDir('darwin', 'x64')).toBe('mac-x64');
    expect(mediaArchDir('win32', 'x64')).toBe('win-x64');
    expect([...RESOLVER_TARGETS].sort()).toEqual(['mac-arm64', 'mac-x64', 'win-x64']);
  });

  it('rejects unshipped targets (Windows arm64 is deferred — ADR-0007)', () => {
    expect(() => mediaArchDir('win32', 'arm64')).toThrow(UnsupportedMediaTargetError);
    expect(() => mediaArchDir('darwin', 'ia32')).toThrow(UnsupportedMediaTargetError);
  });

  it('resolves the packaged path under resourcesPath/media/<os>-<arch>', () => {
    const resolved = resolveFfmpegPath({
      isPackaged: true,
      resourcesPath: '/A/Kawsay.app/Contents/Resources',
      projectRoot: '/repo',
      platform: 'darwin',
      arch: 'arm64',
      exists: () => true,
    });
    expect(resolved).toBe(
      join('/A/Kawsay.app/Contents/Resources', MEDIA_RESOURCE_SUBDIR, 'mac-arm64', 'ffmpeg'),
    );
  });

  it('resolves the dev path under projectRoot/resources/media/<os>-<arch>', () => {
    const resolved = resolveFfprobePath({
      isPackaged: false,
      resourcesPath: '/ignored',
      projectRoot: '/repo',
      platform: 'win32',
      arch: 'x64',
      exists: () => true,
    });
    expect(resolved).toBe(join('/repo', 'resources', MEDIA_RESOURCE_SUBDIR, 'win-x64', 'ffprobe.exe'));
  });

  it('throws a typed not-found error (never returns an unverified path)', () => {
    expect(() =>
      resolveFfmpegPath({
        isPackaged: true,
        resourcesPath: '/A/Resources',
        projectRoot: '/repo',
        platform: 'darwin',
        arch: 'arm64',
        exists: () => false,
      }),
    ).toThrow(MediaBinaryNotFoundError);
  });
});

describe('installed source binaries are correct-arch for ALL shipped targets (#175)', () => {
  // The cross-arch guard: pnpm `supportedArchitectures` installs the
  // @ffmpeg-installer / @ffprobe-installer per-platform packages for every
  // target, so a single arm64 macOS runner can stage the x64 dmg's binaries
  // too. Asserting each is the EXPECTED arch is exactly the check the broken
  // ffprobe-static@3.1.0 (Mach-O x86_64 mislabelled arm64) silently failed.
  it('enumerates exactly the three shipped targets', () => {
    expect([...SUPPORTED_MEDIA_TARGETS].sort()).toEqual(['mac-arm64', 'mac-x64', 'win-x64']);
  });

  for (const target of SUPPORTED_MEDIA_TARGETS) {
    for (const tool of ['ffmpeg', 'ffprobe'] as const) {
      it(`provides a ${targetArch(target)} ${tool} for ${target}`, () => {
        const src = sourceBinaryPath(tool, target);
        expect(existsSync(src), `${tool} source binary missing for ${target} at ${src}`).toBe(true);
        expect(statSync(src).size).toBeGreaterThan(0);
        expect(detectBinaryArch(src), `${tool} for ${target} is the wrong arch`).toBe(
          targetArch(target),
        );
      });
    }
  }
});

describe('the app resolver returns an on-disk, host-arch binary in dev (#175)', () => {
  // Stage the host build leg's binaries into a throwaway project root, then ask
  // the PRODUCTION resolver (dev branch) for the exact path the app spawns and
  // prove the file is there and is this machine's arch — the end-to-end check
  // that the v0.2.0 packaging bug defeated.
  let projectRoot: string;

  beforeAll(() => {
    projectRoot = makeTmpDir('media-resolve-');
    stageMediaBinaries({ targets: hostMediaTargets(), projectRoot });
  });

  afterAll(() => {
    if (projectRoot) removeTmpDir(projectRoot);
  });

  it('resolves an ffmpeg binary that exists on disk and is the host arch', () => {
    const ffmpegPath = resolveFfmpegPath({ isPackaged: false, resourcesPath: '', projectRoot });
    expect(existsSync(ffmpegPath), `ffmpeg missing at ${ffmpegPath}`).toBe(true);
    expect(statSync(ffmpegPath).size).toBeGreaterThan(0);
    expect(detectBinaryArch(ffmpegPath)).toBe(process.arch);
  });

  it('resolves an ffprobe binary that exists on disk and is the host arch', () => {
    const ffprobePath = resolveFfprobePath({ isPackaged: false, resourcesPath: '', projectRoot });
    expect(existsSync(ffprobePath), `ffprobe missing at ${ffprobePath}`).toBe(true);
    expect(statSync(ffprobePath).size).toBeGreaterThan(0);
    expect(detectBinaryArch(ffprobePath)).toBe(process.arch);
  });
});
