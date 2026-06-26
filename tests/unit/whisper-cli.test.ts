import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import {
  SUPPORTED_WHISPER_TARGETS,
  UnsupportedWhisperTargetError,
  WHISPER_CLI_BINARY_BASENAME,
  WHISPER_CLI_RESOURCE_SUBDIR,
  WhisperCliNotFoundError,
  resolveWhisperCliPath,
  whisperCliArchDir,
  whisperCliBinaryName,
  whisperOsKey,
} from '../../electron/main/transcription/whisper-cli';

// The whisper-cli path resolver (card #129, M2 · ADR-0027 Decision 6 / "Binary
// provenance & integrity"). The `whisper-cli` binary is built per-arch from
// source in CI and bundled by electron-builder as an extraResource, resolved at
// runtime through `process.resourcesPath` — exactly the seam these tests pin.
// The resolver is electron-free and fully injectable so it runs under vitest.

describe('whisperOsKey (process.platform → electron-builder ${os} key)', () => {
  it('maps macOS (darwin) to the "mac" build key', () => {
    expect(whisperOsKey('darwin')).toBe('mac');
  });

  it('maps Windows (win32) to the "win" build key', () => {
    expect(whisperOsKey('win32')).toBe('win');
  });

  it('rejects an unshipped platform (e.g. linux) with a typed error', () => {
    // Kawsay ships macOS + Windows only (ADR-0007); any other platform has no
    // bundled whisper-cli, so it is a typed, reportable refusal — never a guess.
    expect(() => whisperOsKey('linux')).toThrow(UnsupportedWhisperTargetError);
  });
});

describe('whisperCliBinaryName (platform-specific executable name)', () => {
  it('uses the .exe suffix on Windows', () => {
    expect(whisperCliBinaryName('win32')).toBe('whisper-cli.exe');
  });

  it('uses the bare basename on macOS', () => {
    expect(whisperCliBinaryName('darwin')).toBe('whisper-cli');
    expect(whisperCliBinaryName('darwin')).toBe(WHISPER_CLI_BINARY_BASENAME);
  });
});

describe('whisperCliArchDir (the per-arch <os>-<arch> bundle sub-directory)', () => {
  it('produces the exact directory electron-builder ${os}-${arch} expands to', () => {
    // These three are the only shipped targets: macOS arm64 + x64, Windows x64.
    expect(whisperCliArchDir('darwin', 'arm64')).toBe('mac-arm64');
    expect(whisperCliArchDir('darwin', 'x64')).toBe('mac-x64');
    expect(whisperCliArchDir('win32', 'x64')).toBe('win-x64');
  });

  it('enumerates exactly the three shipped targets', () => {
    expect([...SUPPORTED_WHISPER_TARGETS].sort()).toEqual(['mac-arm64', 'mac-x64', 'win-x64']);
  });

  it('rejects an unshipped target (Windows arm64 is deferred — ADR-0007)', () => {
    expect(() => whisperCliArchDir('win32', 'arm64')).toThrow(UnsupportedWhisperTargetError);
  });

  it('rejects an unsupported architecture (e.g. ia32)', () => {
    expect(() => whisperCliArchDir('darwin', 'ia32')).toThrow(UnsupportedWhisperTargetError);
  });
});

describe('resolveWhisperCliPath (dev vs packaged resolution)', () => {
  const present = (): boolean => true;

  it('resolves under process.resourcesPath in a packaged app', () => {
    const resourcesPath = join('/Applications', 'Kawsay.app', 'Contents', 'Resources');
    const resolved = resolveWhisperCliPath({
      isPackaged: true,
      resourcesPath,
      projectRoot: '/unused/in/packaged',
      platform: 'darwin',
      arch: 'arm64',
      exists: present,
    });
    // <resourcesPath>/whisper/mac-arm64/whisper-cli — the extraResource `to:`.
    expect(resolved).toBe(
      join(resourcesPath, WHISPER_CLI_RESOURCE_SUBDIR, 'mac-arm64', 'whisper-cli'),
    );
  });

  it('resolves under the repo resources/ tree in development', () => {
    const projectRoot = join('/home', 'dev', 'kawsay');
    const resolved = resolveWhisperCliPath({
      isPackaged: false,
      resourcesPath: '/unused/in/dev',
      projectRoot,
      platform: 'win32',
      arch: 'x64',
      exists: present,
    });
    // <projectRoot>/resources/whisper/win-x64/whisper-cli.exe
    expect(resolved).toBe(
      join(projectRoot, 'resources', WHISPER_CLI_RESOURCE_SUBDIR, 'win-x64', 'whisper-cli.exe'),
    );
  });

  it('defaults platform/arch to the current process and probes with fs by default', () => {
    // No explicit platform/arch/exists: defaults to process.* + fs.existsSync.
    // The binary is not built in this checkout, so the default fs probe misses
    // and the resolver raises the typed not-found error (never returns a guess).
    expect(() =>
      resolveWhisperCliPath({
        isPackaged: false,
        resourcesPath: '/unused',
        projectRoot: '/nonexistent-kawsay-root',
      }),
    ).toThrow(WhisperCliNotFoundError);
  });

  it('throws a typed not-found error carrying the searched path when the binary is absent', () => {
    const resourcesPath = '/opt/kawsay/resources';
    try {
      resolveWhisperCliPath({
        isPackaged: true,
        resourcesPath,
        projectRoot: '/unused',
        platform: 'darwin',
        arch: 'x64',
        exists: () => false,
      });
      expect.unreachable('expected a WhisperCliNotFoundError');
    } catch (error) {
      expect(error).toBeInstanceOf(WhisperCliNotFoundError);
      const notFound = error as WhisperCliNotFoundError;
      expect(notFound.name).toBe('WhisperCliNotFoundError');
      expect(notFound.archDir).toBe('mac-x64');
      expect(notFound.searchedPath).toBe(
        join(resourcesPath, WHISPER_CLI_RESOURCE_SUBDIR, 'mac-x64', 'whisper-cli'),
      );
    }
  });

  it('propagates the typed unsupported-target error for an unshipped platform', () => {
    expect(() =>
      resolveWhisperCliPath({
        isPackaged: true,
        resourcesPath: '/opt/kawsay/resources',
        projectRoot: '/unused',
        platform: 'linux',
        arch: 'x64',
        exists: present,
      }),
    ).toThrow(UnsupportedWhisperTargetError);
  });
});
