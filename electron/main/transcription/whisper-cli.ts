import { existsSync } from 'node:fs';
import { join } from 'node:path';

// whisper-cli path resolver for M2 on-device transcription (card #129, ADR-0027
// Decision 2/6 + "Binary provenance & integrity"). whisper.cpp's `whisper-cli`
// is built from source per-arch in CI and bundled by electron-builder as an
// extraResource (see electron-builder.yml + scripts/build-whisper-cli.sh), so a
// packaged app spawns it from `process.resourcesPath`, exactly as the bundled
// ffmpeg/ffprobe/better-sqlite3 binaries are resolved today (ADR-0012/0007).
//
// This module is deliberately Electron-free and fully injectable: the caller
// (the future transcription worker — a separate M2 card) passes `app.isPackaged`
// + `process.resourcesPath` + the app root, so the resolution logic stays a pure,
// unit-tested function. It only LOCATES the binary; spawning it (an array argv,
// local-file-only inputs, a bounded timeout) belongs to the transcription seam.

/** Sub-directory (under the resources root) that holds the per-arch binaries. */
export const WHISPER_CLI_RESOURCE_SUBDIR = 'whisper';

/** The platform-independent stem of the executable (`.exe` is added on Windows). */
export const WHISPER_CLI_BINARY_BASENAME = 'whisper-cli';

/** The electron-builder `${os}` key (Platform.buildConfigurationKey) we ship for. */
export type WhisperOsKey = 'mac' | 'win';

/**
 * The exact `<os>-<arch>` bundle sub-directories Kawsay ships a `whisper-cli`
 * for — the macros `${os}-${arch}` in electron-builder.yml expand to precisely
 * these on each build leg (macOS arm64 + x64, Windows x64). Windows arm64 is
 * deferred (ADR-0007), so it is intentionally absent.
 */
export const SUPPORTED_WHISPER_TARGETS = ['mac-arm64', 'mac-x64', 'win-x64'] as const;

/** A `<os>-<arch>` directory Kawsay ships a binary for. */
export type WhisperTarget = (typeof SUPPORTED_WHISPER_TARGETS)[number];

/**
 * A typed refusal: the current platform/arch is outside Kawsay's shipped matrix
 * (macOS arm64/x64 + Windows x64), so no bundled `whisper-cli` can exist for it.
 * Distinct from {@link WhisperCliNotFoundError} (a supported target whose binary
 * is simply not present on disk) so callers can tell "never bundled" from
 * "should be here but isn't".
 */
export class UnsupportedWhisperTargetError extends Error {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  constructor(platform: NodeJS.Platform, arch: string) {
    super(
      `whisper-cli is not shipped for ${platform}/${arch} (supported: macOS arm64+x64, Windows x64)`,
    );
    this.name = 'UnsupportedWhisperTargetError';
    this.platform = platform;
    this.arch = arch;
  }
}

/** A typed refusal: the bundled `whisper-cli` was not found at its resolved path. */
export class WhisperCliNotFoundError extends Error {
  /** The absolute path the resolver probed (and which was missing). */
  readonly searchedPath: string;
  /** The `<os>-<arch>` directory that was searched (e.g. `mac-arm64`). */
  readonly archDir: WhisperTarget;
  constructor(searchedPath: string, archDir: WhisperTarget) {
    super(
      `bundled whisper-cli not found at ${searchedPath} (build it via scripts/build-whisper-cli.sh)`,
    );
    this.name = 'WhisperCliNotFoundError';
    this.searchedPath = searchedPath;
    this.archDir = archDir;
  }
}

/**
 * Map a Node `process.platform` to the electron-builder `${os}` key used in the
 * bundle path. Only the shipped platforms resolve; anything else is a typed
 * {@link UnsupportedWhisperTargetError} (arch is reported as `*` since the
 * platform alone already disqualifies it).
 */
export function whisperOsKey(platform: NodeJS.Platform): WhisperOsKey {
  switch (platform) {
    case 'darwin':
      return 'mac';
    case 'win32':
      return 'win';
    default:
      throw new UnsupportedWhisperTargetError(platform, '*');
  }
}

/** The platform-specific executable name (`whisper-cli.exe` on Windows). */
export function whisperCliBinaryName(platform: NodeJS.Platform): string {
  return platform === 'win32' ? `${WHISPER_CLI_BINARY_BASENAME}.exe` : WHISPER_CLI_BINARY_BASENAME;
}

function isSupportedTarget(target: string): target is WhisperTarget {
  return (SUPPORTED_WHISPER_TARGETS as readonly string[]).includes(target);
}

/**
 * The `<os>-<arch>` bundle sub-directory for a platform/arch, matching what
 * electron-builder's `${os}-${arch}` macro expands to on each build leg. Throws
 * {@link UnsupportedWhisperTargetError} for any target outside the shipped
 * matrix (e.g. Windows arm64, or a non-arm64/x64 architecture).
 */
export function whisperCliArchDir(platform: NodeJS.Platform, arch: string): WhisperTarget {
  const target = `${whisperOsKey(platform)}-${arch}`;
  if (!isSupportedTarget(target)) {
    throw new UnsupportedWhisperTargetError(platform, arch);
  }
  return target;
}

/** Inputs for {@link resolveWhisperCliPath}. */
export interface ResolveWhisperCliOptions {
  /** Whether the app is packaged (`app.isPackaged`) — selects the base directory. */
  isPackaged: boolean;
  /** `process.resourcesPath` — the packaged app's resources dir (used when packaged). */
  resourcesPath: string;
  /** The app/repo root that contains the source `resources/` tree (used in dev). */
  projectRoot: string;
  /** Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** Defaults to `process.arch`. */
  arch?: string;
  /** Existence probe (injected for tests); defaults to `fs.existsSync`. */
  exists?: (path: string) => boolean;
}

/**
 * Resolve the absolute path of the bundled `whisper-cli` for the current (or
 * given) platform/arch.
 *
 * - **Packaged:** `<process.resourcesPath>/whisper/<os>-<arch>/whisper-cli[.exe]`
 *   — where electron-builder copies the per-arch binary (the extraResource
 *   `to: whisper/${os}-${arch}/`).
 * - **Dev:** `<projectRoot>/resources/whisper/<os>-<arch>/whisper-cli[.exe]` —
 *   where `scripts/build-whisper-cli.sh` writes a locally-built binary.
 *
 * Throws {@link UnsupportedWhisperTargetError} for an unshipped platform/arch and
 * {@link WhisperCliNotFoundError} when the (supported) binary is absent — the
 * resolver never returns a path it could not verify exists.
 */
export function resolveWhisperCliPath(options: ResolveWhisperCliOptions): string {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const exists = options.exists ?? existsSync;

  const archDir = whisperCliArchDir(platform, arch);
  const base = options.isPackaged
    ? join(options.resourcesPath, WHISPER_CLI_RESOURCE_SUBDIR, archDir)
    : join(options.projectRoot, 'resources', WHISPER_CLI_RESOURCE_SUBDIR, archDir);
  const binaryPath = join(base, whisperCliBinaryName(platform));

  if (!exists(binaryPath)) {
    throw new WhisperCliNotFoundError(binaryPath, archDir);
  }
  return binaryPath;
}
