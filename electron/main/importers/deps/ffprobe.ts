import { spawn } from 'node:child_process';
import { path as ffprobeStaticPath } from 'ffprobe-static';
import type { MediaInfo, MediaProber } from '../types';
import { assertLocalMediaPath } from './media-path';

/**
 * The structural subset of an ffprobe result we read — decoupled from ffprobe's
 * full JSON output so the parser is trivially testable with plain objects.
 */
export interface ProbeStreamLike {
  codec_type?: string;
  width?: number;
  height?: number;
  duration?: string | number;
}
export interface ProbeDataLike {
  format?: { duration?: string | number; format_name?: string };
  streams?: ProbeStreamLike[];
}

function toFiniteNumber(value: string | number | undefined | null): number | null {
  if (value === undefined || value === null) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Pure: map an ffprobe result onto {@link MediaInfo} (duration + video
 * geometry). `mimeType` is deliberately left null — ffprobe's container/codec
 * names are an unreliable MIME source, so the importer derives MIME from magic
 * bytes / extension instead.
 */
export function parseFfprobe(data: ProbeDataLike): MediaInfo {
  const streams = data.streams ?? [];
  const video = streams.find((stream) => stream.codec_type === 'video');
  return {
    durationSec: toFiniteNumber(data.format?.duration ?? video?.duration),
    width: toFiniteNumber(video?.width),
    height: toFiniteNumber(video?.height),
    mimeType: null,
  };
}

/** The subprocess seam: probe a LOCAL path and return its raw ffprobe data. */
export type FfprobeRunner = (path: string) => Promise<ProbeDataLike>;

/**
 * Hard ceiling on a single ffprobe invocation — a resource cap (§7.2). A
 * crafted or truncated media file can make ffprobe hang indefinitely; bounding
 * it ensures one unreadable clip can never stall the whole import.
 */
const FFPROBE_TIMEOUT_MS = 30_000;
/** Cap captured stderr so a chatty ffprobe can't balloon memory. */
const STDERR_CAP = 4096;

/**
 * Reject if `work` has not settled within `ms`. The timer is unref'd (a pending
 * probe never keeps the process alive) and cleared as soon as `work` settles.
 */
function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref?.();
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export interface MediaProberOptions {
  /** Upper bound on a single probe; on expiry the prober degrades to all-null. */
  timeoutMs?: number;
}

/**
 * Build a {@link MediaProber} over an injected runner. A probe failure never
 * throws — it degrades to all-null (an item with unknown geometry, AC-15) so a
 * single unreadable clip cannot abort an import. The runner is bounded by a
 * timeout so a runner (or ffprobe) that hangs still degrades to all-null.
 */
export function createMediaProber(
  runner: FfprobeRunner,
  options: MediaProberOptions = {},
): MediaProber {
  const timeoutMs = options.timeoutMs ?? FFPROBE_TIMEOUT_MS;
  return async (path: string): Promise<MediaInfo> => {
    try {
      return parseFfprobe(
        await withTimeout(runner(path), timeoutMs, `ffprobe timed out after ${String(timeoutMs)}ms`),
      );
    } catch {
      return { durationSec: null, width: null, height: null, mimeType: null };
    }
  };
}

/**
 * Build the ffprobe argv for a single LOCAL path. `-protocol_whitelist file`
 * pins ffprobe to the file protocol so a crafted local container with an
 * embedded external reference can never make it open a remote URL (egress,
 * AC-4); `assertLocalMediaPath` additionally refuses a URL-style top-level
 * input before we ever spawn. The path is a discrete final element — never
 * interpolated into a flag or a shell string.
 */
export function buildFfprobeArgs(path: string): string[] {
  assertLocalMediaPath(path);
  return [
    '-v',
    'quiet',
    '-protocol_whitelist',
    'file',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    path,
  ];
}

/**
 * Spawn the bundled ffprobe (subprocess) for a single LOCAL path — never a URL,
 * so ffprobe cannot be coerced into network I/O (§6.1/§7.2, AC-4). Mirrors
 * thumbnail.ts's bounded approach: a discrete array argv (the path is never
 * interpolated into a shell string), `-protocol_whitelist file` to block
 * embedded remote references, and a hard `{ timeout }` that kills a ffprobe
 * stuck on a crafted/truncated file, so the promise rejects (and the prober
 * degrades to all-null) instead of hanging forever.
 */
const ffprobeStaticRunner: FfprobeRunner = (path) =>
  new Promise<ProbeDataLike>((resolve, reject) => {
    const child = spawn(ffprobeStaticPath, buildFfprobeArgs(path), {
      timeout: FFPROBE_TIMEOUT_MS,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < STDERR_CAP) stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffprobe exited with ${String(code)}: ${stderr.slice(0, 500)}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout) as ProbeDataLike);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });

/** The production {@link MediaProber} (bundled ffprobe via ffprobe-static). */
export const probeMedia: MediaProber = createMediaProber(ffprobeStaticRunner);
