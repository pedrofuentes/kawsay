import ffmpeg from 'fluent-ffmpeg';
import { path as ffprobeStaticPath } from 'ffprobe-static';
import type { MediaInfo, MediaProber } from '../types';

/**
 * The structural subset of an ffprobe result we read — decoupled from fluent's
 * heavy `FfprobeData` so the parser is trivially testable with plain objects.
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
 * Build a {@link MediaProber} over an injected runner. A probe failure never
 * throws — it degrades to all-null (an item with unknown geometry, AC-15) so a
 * single unreadable clip cannot abort an import.
 */
export function createMediaProber(runner: FfprobeRunner): MediaProber {
  return async (path: string): Promise<MediaInfo> => {
    try {
      return parseFfprobe(await runner(path));
    } catch {
      return { durationSec: null, width: null, height: null, mimeType: null };
    }
  };
}

/**
 * Spawn the bundled ffprobe (subprocess) for a single LOCAL path — never a URL,
 * so ffprobe cannot be coerced into network I/O (§6.1/§7.2, AC-4). The path is
 * passed as a discrete argument, never interpolated into a shell string.
 */
const ffprobeStaticRunner: FfprobeRunner = (path) =>
  new Promise<ProbeDataLike>((resolve, reject) => {
    ffmpeg.setFfprobePath(ffprobeStaticPath);
    ffmpeg.ffprobe(path, (error, data) => {
      if (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      resolve(data);
    });
  });

/** The production {@link MediaProber} (fluent-ffmpeg + ffprobe-static). */
export const probeMedia: MediaProber = createMediaProber(ffprobeStaticRunner);
