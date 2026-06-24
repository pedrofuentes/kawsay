import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import ffmpegStatic from 'ffmpeg-static';
import type { GeneratedAsset, ThumbnailGenerator, ThumbnailRequest } from '../ingest';

/** Longest edge (px) of generated WebP renditions (ARCHITECTURE §5.1). */
const THUMBNAIL_MAX_EDGE = 480;
/** Hard ceiling on a single ffmpeg invocation — a resource cap (§7.2). */
const FFMPEG_TIMEOUT_MS = 30_000;
/** Cap captured stderr so a chatty ffmpeg can't balloon memory. */
const STDERR_CAP = 4096;

type DerivedDir = 'thumbnails' | 'posters';

/**
 * Library-relative, content-addressed rendition path:
 * `derived/<dir>/<hash[0:2]>/<hash>.webp` (mirrors the originals sharding, §4.4).
 */
export function derivedRelPath(dir: DerivedDir, hash: string): string {
  return join('derived', dir, hash.slice(0, 2), `${hash}.webp`);
}

/**
 * Build the ffmpeg argv for a single down-scaled WebP frame.
 *
 * Pure, and crucially an ARRAY argv: the input and output are discrete elements,
 * never concatenated into a flag or a shell string, so an attacker-controlled
 * filename cannot inject flags or shell syntax (§7.2, AC-4). The output path is
 * always the final element.
 */
export function buildFrameArgs(inputPath: string, outputPath: string): string[] {
  return [
    '-y',
    '-loglevel',
    'error',
    '-i',
    inputPath,
    '-frames:v',
    '1',
    '-vf',
    `scale='min(${THUMBNAIL_MAX_EDGE},iw)':-2:flags=lanczos`,
    '-f',
    'webp',
    outputPath,
  ];
}

/**
 * Run ffmpeg to completion. Injected so the generator is unit-testable without a
 * real binary; the default spawns the bundled ffmpeg with an array argv.
 */
export type RunFfmpeg = (command: string, args: readonly string[]) => Promise<void>;

const defaultRun: RunFfmpeg = (command, args) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn(command, [...args], { timeout: FFMPEG_TIMEOUT_MS, windowsHide: true });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < STDERR_CAP) stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with ${String(code)}: ${stderr.slice(0, 500)}`));
    });
  });

export interface ThumbnailGeneratorOptions {
  /** Absolute path of the ffmpeg binary (e.g. ffmpeg-static). */
  ffmpegPath: string;
  /** Subprocess runner; defaults to spawning ffmpeg with an array argv. */
  run?: RunFfmpeg;
}

/**
 * Build a {@link ThumbnailGenerator}: photos get a `thumbnail`, videos get a
 * `poster` frame, each a content-addressed WebP under the library `derived/`
 * tree. The generator only ever hands ffmpeg LOCAL paths (no URLs, no shell).
 */
export function createThumbnailGenerator(options: ThumbnailGeneratorOptions): ThumbnailGenerator {
  const run = options.run ?? defaultRun;
  return async (request: ThumbnailRequest): Promise<GeneratedAsset[]> => {
    const isVideo = request.mediaType === 'video';
    const kind = isVideo ? 'poster' : 'thumbnail';
    const dir: DerivedDir = isVideo ? 'posters' : 'thumbnails';
    const relPath = derivedRelPath(dir, request.contentHash);
    const absPath = join(request.libraryRoot, relPath);
    await mkdir(dirname(absPath), { recursive: true });
    await run(options.ffmpegPath, buildFrameArgs(request.sourcePath, absPath));
    return [{ kind, path: relPath }];
  };
}

/** The production generator wired to the bundled ffmpeg binary (ffmpeg-static). */
export function createFfmpegThumbnailGenerator(): ThumbnailGenerator {
  const ffmpegPath: string | null = ffmpegStatic;
  if (ffmpegPath === null) {
    throw new Error('ffmpeg-static did not resolve a binary for this platform');
  }
  return createThumbnailGenerator({ ffmpegPath });
}
