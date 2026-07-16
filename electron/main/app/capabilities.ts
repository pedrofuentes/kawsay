// The aggregate CAPABILITY seam (#441). The main process resolves several bundled
// assets LAZILY and NON-throwingly — the per-arch ffmpeg/ffprobe binaries, the built
// off-thread categorization cluster-worker entry, the smart-search embedder, and the
// place gazetteer. Each seam degrades gracefully (a null thumbnailer, inline
// main-thread clustering, exact-FTS search, an empty gazetteer), which is exactly
// right for a dev/CI checkout — but a SHIPPED build that silently omitted one is a
// packaging regression (the v0.2.0 missing-ffmpeg incident that motivated
// scripts/verify-media-binaries). This module turns those seams into:
//   1. a pure {@link computeCapabilities} report the app:/status DTO + a packaging
//      guard read (mirroring the EmbedderStatus `available` shape), and
//   2. {@link buildVideoThumbnailer}, which makes the ffmpeg degrade LOUD — a single
//      redacted warning through the #440 logger, framed as a possible packaging
//      regression — instead of the previous silent try/catch.
// Local diagnostics ONLY (no telemetry, no egress, AC-4); the redacting logger keeps
// any Error arg reduced to its safe {name, code} shape and the templates carry no path.

import type { CapabilitiesDTO } from '@shared/ipc/schemas';
import type { VideoThumbnailer } from '../library/thumbnail-service';
import { log, type Logger } from '../log';

/** The aggregate capability report — the pure DTO the handler validates + returns. */
export type CapabilitiesReport = CapabilitiesDTO;

/**
 * The per-seam availability probes {@link computeCapabilities} projects. Each is a
 * boolean thunk resolved at report time (post-`whenReady`, invoke-time), so the
 * report always reflects the live bundled state, never a boot-time snapshot.
 */
export interface CapabilityProbes {
  /** Whether the bundled `ffmpeg` binary resolves for this platform/arch. */
  ffmpeg(): boolean;
  /** Whether the bundled `ffprobe` binary resolves for this platform/arch. */
  ffprobe(): boolean;
  /** Whether the built off-thread cluster-worker entry is present on disk. */
  clusterWorker(): boolean;
  /** Whether the smart-search embedder (binary + model) is available. */
  embedder(): boolean;
  /** Whether the place-name gazetteer asset is bundled. */
  gazetteer(): boolean;
}

/** Project the per-seam probes into the flat, boolean-per-capability report DTO. */
export function computeCapabilities(probes: CapabilityProbes): CapabilitiesReport {
  return {
    ffmpeg: probes.ffmpeg(),
    ffprobe: probes.ffprobe(),
    clusterWorker: probes.clusterWorker(),
    embedder: probes.embedder(),
    gazetteer: probes.gazetteer(),
  };
}

/**
 * Adapt a THROWING resolver (e.g. `resolveFfmpegPath`, which throws when the bundled
 * binary is absent or the platform is unshipped) into a boolean capability probe:
 * `true` when it resolves, `false` when it throws. The thrown value is intentionally
 * swallowed here — the report only carries availability; the loud packaging-regression
 * diagnostic is emitted at the actual degrade seam (e.g. {@link buildVideoThumbnailer}).
 */
export function isResolvable(resolve: () => unknown): boolean {
  try {
    resolve();
    return true;
  } catch {
    return false;
  }
}

/** Collaborators for {@link buildVideoThumbnailer} (all injectable for unit tests). */
export interface VideoThumbnailerDeps {
  /** Resolve the bundled `ffmpeg` path; THROWS when it is absent/unshipped. */
  resolveFfmpegPath(): string;
  /** Build the real ffmpeg-backed video-frame thumbnailer from a resolved path. */
  createFrameThumbnailer(options: { ffmpegPath: string }): VideoThumbnailer;
  /** Where the loud degrade warning goes; defaults to the shared redacting logger. */
  logger?: Pick<Logger, 'warn'>;
}

/**
 * Build the video-frame thumbnailer, degrading NON-throwingly to a null thumbnailer
 * (videos fall back to their type icon) when the bundled ffmpeg can't be resolved —
 * but making that degrade LOUD (#441): a single warning through the redacting logger,
 * framed as a possible packaging regression, with the caught error forwarded as a
 * SEPARATE arg (so the logger reduces it to its safe {name, code} shape) and NO path
 * in the template. A dev/CI checkout without staged binaries logs this and keeps
 * running; a shipped build that trips it is the packaging defect this surfaces.
 */
export function buildVideoThumbnailer(deps: VideoThumbnailerDeps): VideoThumbnailer {
  const logger = deps.logger ?? log;
  try {
    const frame = deps.createFrameThumbnailer({ ffmpegPath: deps.resolveFfmpegPath() });
    return (absPath, maxDimension) => frame(absPath, maxDimension);
  } catch (error) {
    logger.warn(
      '[kawsay] bundled ffmpeg could not be resolved; video previews are unavailable — expected in a dev checkout, but a possible packaging regression in a shipped build',
      error,
    );
    return async () => null;
  }
}
