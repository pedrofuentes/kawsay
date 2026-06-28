import type { ImporterDeps, SafeExtractFn } from '../types';
import { hashFile } from './hash';
import { nodeFs } from './node-fs';
import { readExif } from './exif';
import { createFfprobeRunner, createMediaProber } from './ffprobe';

export { hashFile } from './hash';
export { nodeFs } from './node-fs';
export { readExif, normalizeExif, asUtcInstant } from './exif';
export {
  parseFfprobe,
  createMediaProber,
  createFfprobeRunner,
  type ProbeDataLike,
  type ProbeStreamLike,
  type FfprobeRunner,
} from './ffprobe';
export {
  createThumbnailGenerator,
  createFfmpegThumbnailGenerator,
  derivedRelPath,
  buildFrameArgs,
  type RunFfmpeg,
  type ThumbnailGeneratorOptions,
  type FfmpegThumbnailerOptions,
} from './thumbnail';

export interface ImporterDepsOptions {
  /**
   * The guarded, zip-slip-safe archive extractor — provided by card C2
   * (electron/main/.../safe-extract). REQUIRED; this card never implements it.
   */
  extractArchive: SafeExtractFn;
  /**
   * Absolute path to the bundled, per-arch ffprobe — resolved by the main
   * process (importers/deps/media-binaries.ts) and threaded in (#175), so the
   * deps never resolve a binary themselves. The {@link MediaProber} is built
   * over this path's hardened spawn runner.
   */
  ffprobePath: string;
}

/**
 * Compose the concrete, sandboxed {@link ImporterDeps} from the real wrappers,
 * threading in the C2-provided archive extractor and the per-arch ffprobe path
 * (the pieces this card does not own). Folder imports never call extractArchive.
 */
export function createImporterDeps(options: ImporterDepsOptions): ImporterDeps {
  return {
    fs: nodeFs,
    extractArchive: options.extractArchive,
    readExif,
    probeMedia: createMediaProber(createFfprobeRunner(options.ffprobePath)),
    hashFile,
  };
}

/**
 * A placeholder extractor for callers that don't yet have C2's safe-extract.
 * Rejects if an archive importer actually invokes it (folder imports won't), so
 * wiring the engine before C2 lands fails loudly rather than silently.
 */
export const unavailableExtractArchive: SafeExtractFn = async () => {
  throw new Error(
    'archive extraction is not available yet — card C2 (safe-extract) provides the guarded extractor',
  );
};
