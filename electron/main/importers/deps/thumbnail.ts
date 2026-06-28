import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { GeneratedAsset, ThumbnailGenerator, ThumbnailRequest } from '../ingest';
import { assertLocalMediaPath } from './media-path';

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
 * always the final element. `-protocol_whitelist file` precedes `-i` so it
 * applies to the input demuxer, pinning ffmpeg to the file protocol — a crafted
 * local container can never make it follow an embedded remote reference (egress,
 * AC-4) — and `assertLocalMediaPath` refuses a URL-style input outright.
 */
export function buildFrameArgs(inputPath: string, outputPath: string): string[] {
  assertLocalMediaPath(inputPath);
  return [
    '-y',
    '-loglevel',
    'error',
    '-protocol_whitelist',
    'file',
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
  /** Absolute path of the bundled, per-arch ffmpeg binary. */
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

/** Options for the production ffmpeg-backed thumbnail factories. */
export interface FfmpegThumbnailerOptions {
  /** Absolute path to the bundled, per-arch ffmpeg (resolved by the main process). */
  ffmpegPath: string;
}

/**
 * The production generator wired to the bundled, per-arch ffmpeg binary. The
 * path is resolved by the main process (importers/deps/media-binaries.ts) and
 * threaded in, so this factory never touches the filesystem to find a binary.
 */
export function createFfmpegThumbnailGenerator(
  options: FfmpegThumbnailerOptions,
): ThumbnailGenerator {
  return createThumbnailGenerator({ ffmpegPath: options.ffmpegPath });
}

// ── On-demand video-frame thumbnailer (catalog:thumbnail by id — U4) ─────────
//
// The import-time generator above writes a content-addressed poster file. The
// thumbnail SERVICE instead needs a frame on demand, in memory, for an item the
// renderer is currently showing. This pipes a single down-scaled WebP frame to
// STDOUT (`pipe:1`) so nothing touches disk, reusing the very same hardening:
// an array argv (no shell), `-protocol_whitelist file` before `-i`, and an
// `assertLocalMediaPath` refusal of any URL-style input (AC-4, §7.2).

/** Cap captured stdout so a misbehaving ffmpeg can't exhaust memory (§7.2). */
const STDOUT_CAP = 16 * 1024 * 1024;

/** The single still a `catalog:thumbnail` video render yields (always WebP). */
export interface VideoFrameThumbnail {
  data: Buffer;
  mimeType: 'image/webp';
}

/**
 * Build the ffmpeg argv that emits ONE down-scaled WebP frame on stdout. Same
 * safety contract as {@link buildFrameArgs} — array argv, file-protocol-pinned,
 * URL inputs refused — but the output sink is the literal `pipe:1`, never an
 * attacker-influenced path. `maxEdge` is the longest edge the frame is scaled to.
 */
export function buildFramePipeArgs(inputPath: string, maxEdge: number): string[] {
  assertLocalMediaPath(inputPath);
  return [
    '-loglevel',
    'error',
    '-protocol_whitelist',
    'file',
    '-i',
    inputPath,
    '-frames:v',
    '1',
    '-vf',
    `scale='min(${maxEdge},iw)':-2:flags=lanczos`,
    '-f',
    'webp',
    'pipe:1',
  ];
}

/**
 * Run ffmpeg and CAPTURE its stdout as a Buffer (the frame bytes). Injected so
 * the thumbnailer is unit-testable without a real binary; the default spawns the
 * bundled ffmpeg with an array argv and a bounded stdout buffer.
 */
export type RunFfmpegCapture = (command: string, args: readonly string[]) => Promise<Buffer>;

const defaultRunCapture: RunFfmpegCapture = (command, args) =>
  new Promise<Buffer>((resolve, reject) => {
    const child = spawn(command, [...args], { timeout: FFMPEG_TIMEOUT_MS, windowsHide: true });
    const chunks: Buffer[] = [];
    let size = 0;
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > STDOUT_CAP) {
        child.kill();
        reject(new Error('ffmpeg frame exceeded the stdout cap'));
        return;
      }
      chunks.push(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < STDERR_CAP) stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`ffmpeg exited with ${String(code)}: ${stderr.slice(0, 500)}`));
    });
  });

export interface VideoFrameThumbnailerOptions {
  /** Absolute path of the bundled, per-arch ffmpeg binary. */
  ffmpegPath: string;
  /** Subprocess runner; defaults to spawning ffmpeg and capturing stdout. */
  run?: RunFfmpegCapture;
}

/**
 * Build an on-demand video thumbnailer: `(absPath, maxEdge) → {data, 'image/webp'}`
 * or null. `buildFramePipeArgs` runs OUTSIDE the try so a URL input rejects loudly
 * (a programming/contract error, never a silent skip), while a genuine decode
 * failure — an unreadable or truncated clip — degrades to null so one bad video
 * falls back to its type icon instead of breaking the view.
 */
export function createVideoFrameThumbnailer(
  options: VideoFrameThumbnailerOptions,
): (absPath: string, maxEdge: number) => Promise<VideoFrameThumbnail | null> {
  const run = options.run ?? defaultRunCapture;
  return async (absPath, maxEdge) => {
    const args = buildFramePipeArgs(absPath, maxEdge);
    try {
      const data = await run(options.ffmpegPath, args);
      if (data.length === 0) return null;
      return { data, mimeType: 'image/webp' };
    } catch {
      return null;
    }
  };
}

/** The production video-frame thumbnailer wired to the bundled, per-arch ffmpeg. */
export function createFfmpegVideoFrameThumbnailer(
  options: FfmpegThumbnailerOptions,
): (absPath: string, maxEdge: number) => Promise<VideoFrameThumbnail | null> {
  return createVideoFrameThumbnailer({ ffmpegPath: options.ffmpegPath });
}
