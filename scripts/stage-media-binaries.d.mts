// Hand-written type declarations for scripts/stage-media-binaries.mjs (a plain
// ESM build script run under bare `node`), so tests/unit/media-binaries.test.ts
// can import its exports under `tsc --strict`. Same approach as the other
// type-only shims in the repo (e.g. ffprobe-static.d.ts). Keep in lock-step with
// the .mjs module's exports.

export type MediaTool = 'ffmpeg' | 'ffprobe';
export type MediaTarget = 'mac-arm64' | 'mac-x64' | 'win-x64';
export type MediaArch = 'arm64' | 'x64';

export const MEDIA_TOOLS: readonly MediaTool[];
export const SUPPORTED_MEDIA_TARGETS: readonly MediaTarget[];

export function targetArch(target: MediaTarget): MediaArch;
export function targetPlatform(target: MediaTarget): NodeJS.Platform;
export function mediaBinaryName(tool: MediaTool, target: MediaTarget): string;
export function mediaBinarySourceKind(tool: MediaTool, target: MediaTarget): 'from-source' | 'installer';
export function sourceBinaryPath(tool: MediaTool, target: MediaTarget, projectRoot?: string): string;
export function stagedBinaryPath(tool: MediaTool, target: MediaTarget, projectRoot: string): string;
export function hostMediaTargets(platform?: NodeJS.Platform): MediaTarget[];
export function stageMediaBinaries(options?: {
  targets?: readonly MediaTarget[];
  projectRoot: string;
}): string[];
