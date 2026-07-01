export function targetArch(target: string): 'arm64' | 'x64';
export function targetPlatform(target: string): 'darwin' | 'win32';
export function embedBinaryName(target: string): string;
export function stagedEmbedBinaryPath(target: string, projectRoot: string): string;
export function hostEmbedTargets(platform?: NodeJS.Platform): string[];
export function detectBinaryArch(file: string): 'arm64' | 'x64' | 'ia32' | 'unknown';
export function verifyEmbedBinaries(options?: {
  projectRoot?: string;
  targets?: readonly string[];
  log?: (message: string) => void;
}): string[];
export const EMBED_TARGETS: string[];
export const EMBED_CLI_BINARY_BASENAME: string;
export const EMBED_RESOURCE_SUBDIR: string;
