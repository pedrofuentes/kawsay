import { existsSync } from 'node:fs';
import { join } from 'node:path';

// ffmpeg + ffprobe path resolver for media ingestion (#175). v0.2.0 shipped NO
// ffmpeg (pnpm blocked ffmpeg-static's download postinstall) and a wrong-arch
// ffprobe (ffprobe-static@3.1.0's darwin/arm64 file is Mach-O x86_64), breaking
// every transcription job + every video thumbnail. The fix bundles the correct
// per-arch binaries (from @ffmpeg-installer / @ffprobe-installer) as plain files
// under resources/media/<os>-<arch>/, staged by scripts/stage-media-binaries.mjs
// and copied by electron-builder as an extraResource — exactly how whisper-cli
// is bundled (see electron/main/transcription/whisper-cli.ts, the sibling this
// module deliberately mirrors).
//
// Like the whisper-cli resolver, this module is Electron-free and fully
// injectable: the main process passes `app.isPackaged` + `process.resourcesPath`
// + the app root, so resolution stays a pure, unit-tested function. It only
// LOCATES the binary; spawning it (array argv, local-file-only inputs, bounded
// timeout, output caps) stays in the audio-extract / thumbnail / ffprobe seams.

/** Sub-directory (under the resources root) that holds the per-arch binaries. */
export const MEDIA_RESOURCE_SUBDIR = 'media';

/** The media tools Kawsay bundles and spawns. */
export type MediaTool = 'ffmpeg' | 'ffprobe';

/** The electron-builder `${os}` key (Platform.buildConfigurationKey) we ship for. */
export type MediaOsKey = 'mac' | 'win';

/**
 * The exact `<os>-<arch>` bundle sub-directories Kawsay ships ffmpeg + ffprobe
 * for — the macros `${os}-${arch}` in electron-builder.yml expand to precisely
 * these on each build leg (macOS arm64 + x64, Windows x64). Windows arm64 is
 * deferred (ADR-0007), so it is intentionally absent. Identical to whisper-cli's
 * SUPPORTED_WHISPER_TARGETS — the two bundles travel together.
 */
export const SUPPORTED_MEDIA_TARGETS = ['mac-arm64', 'mac-x64', 'win-x64'] as const;

/** A `<os>-<arch>` directory Kawsay ships a binary for. */
export type MediaTarget = (typeof SUPPORTED_MEDIA_TARGETS)[number];

/**
 * A typed refusal: the current platform/arch is outside Kawsay's shipped matrix
 * (macOS arm64/x64 + Windows x64), so no bundled ffmpeg/ffprobe can exist for it.
 * Distinct from {@link MediaBinaryNotFoundError} (a supported target whose binary
 * is simply absent) so callers can tell "never bundled" from "should be here".
 */
export class UnsupportedMediaTargetError extends Error {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  constructor(platform: NodeJS.Platform, arch: string) {
    super(
      `ffmpeg/ffprobe are not shipped for ${platform}/${arch} (supported: macOS arm64+x64, Windows x64)`,
    );
    this.name = 'UnsupportedMediaTargetError';
    this.platform = platform;
    this.arch = arch;
  }
}

/** A typed refusal: a bundled media binary was not found at its resolved path. */
export class MediaBinaryNotFoundError extends Error {
  /** Which tool was being resolved. */
  readonly tool: MediaTool;
  /** The absolute path the resolver probed (and which was missing). */
  readonly searchedPath: string;
  /** The `<os>-<arch>` directory that was searched (e.g. `mac-arm64`). */
  readonly archDir: MediaTarget;
  constructor(tool: MediaTool, searchedPath: string, archDir: MediaTarget) {
    super(
      `bundled ${tool} not found at ${searchedPath} (stage it via scripts/stage-media-binaries.mjs / \`pnpm stage:media\`)`,
    );
    this.name = 'MediaBinaryNotFoundError';
    this.tool = tool;
    this.searchedPath = searchedPath;
    this.archDir = archDir;
  }
}

/**
 * Map a Node `process.platform` to the electron-builder `${os}` key used in the
 * bundle path. Only the shipped platforms resolve; anything else is a typed
 * {@link UnsupportedMediaTargetError} (arch reported as `*` since the platform
 * alone already disqualifies it).
 */
export function mediaOsKey(platform: NodeJS.Platform): MediaOsKey {
  switch (platform) {
    case 'darwin':
      return 'mac';
    case 'win32':
      return 'win';
    default:
      throw new UnsupportedMediaTargetError(platform, '*');
  }
}

/** The platform-specific executable name (`ffmpeg.exe` / `ffprobe.exe` on Windows). */
export function mediaBinaryName(tool: MediaTool, platform: NodeJS.Platform): string {
  return platform === 'win32' ? `${tool}.exe` : tool;
}

function isSupportedTarget(target: string): target is MediaTarget {
  return (SUPPORTED_MEDIA_TARGETS as readonly string[]).includes(target);
}

/**
 * The `<os>-<arch>` bundle sub-directory for a platform/arch, matching what
 * electron-builder's `${os}-${arch}` macro expands to on each build leg. Throws
 * {@link UnsupportedMediaTargetError} for any target outside the shipped matrix
 * (e.g. Windows arm64, or a non-arm64/x64 architecture).
 */
export function mediaArchDir(platform: NodeJS.Platform, arch: string): MediaTarget {
  const target = `${mediaOsKey(platform)}-${arch}`;
  if (!isSupportedTarget(target)) {
    throw new UnsupportedMediaTargetError(platform, arch);
  }
  return target;
}

/** Inputs for {@link resolveMediaBinaryPath}. */
export interface ResolveMediaBinaryOptions {
  /** Which binary to resolve. */
  tool: MediaTool;
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
 * Resolve the absolute path of a bundled media binary for the current (or given)
 * platform/arch.
 *
 * - **Packaged:** `<process.resourcesPath>/media/<os>-<arch>/<tool>[.exe]` — where
 *   electron-builder copies the per-arch binary (extraResource `to:
 *   media/${os}-${arch}/`).
 * - **Dev:** `<projectRoot>/resources/media/<os>-<arch>/<tool>[.exe]` — where
 *   `scripts/stage-media-binaries.mjs` writes the staged binary.
 *
 * Throws {@link UnsupportedMediaTargetError} for an unshipped platform/arch and
 * {@link MediaBinaryNotFoundError} when the (supported) binary is absent — the
 * resolver never returns a path it could not verify exists.
 */
export function resolveMediaBinaryPath(options: ResolveMediaBinaryOptions): string {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const exists = options.exists ?? existsSync;

  const archDir = mediaArchDir(platform, arch);
  const base = options.isPackaged
    ? join(options.resourcesPath, MEDIA_RESOURCE_SUBDIR, archDir)
    : join(options.projectRoot, 'resources', MEDIA_RESOURCE_SUBDIR, archDir);
  const binaryPath = join(base, mediaBinaryName(options.tool, platform));

  if (!exists(binaryPath)) {
    throw new MediaBinaryNotFoundError(options.tool, binaryPath, archDir);
  }
  return binaryPath;
}

/** Resolve the bundled `ffmpeg` for the current (or given) platform/arch. */
export function resolveFfmpegPath(options: Omit<ResolveMediaBinaryOptions, 'tool'>): string {
  return resolveMediaBinaryPath({ ...options, tool: 'ffmpeg' });
}

/** Resolve the bundled `ffprobe` for the current (or given) platform/arch. */
export function resolveFfprobePath(options: Omit<ResolveMediaBinaryOptions, 'tool'>): string {
  return resolveMediaBinaryPath({ ...options, tool: 'ffprobe' });
}
