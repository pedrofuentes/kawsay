import { describe, expect, it, vi } from 'vitest';
import {
  buildVideoThumbnailer,
  computeCapabilities,
  isResolvable,
  type CapabilityProbes,
} from '../../electron/main/app/capabilities';

// The aggregate capability report (#441): a pure projection of the lazily-resolved
// "resolve, degrade, never throw" seams (ffmpeg/ffprobe, the off-thread cluster
// worker entry, the smart-search embedder, the place gazetteer) into a single DTO the
// renderer + a packaging guard can read. Availability is computed from injected
// probes so it is exercised without any real binary/thread.

const ALL_TRUE: CapabilityProbes = {
  ffmpeg: () => true,
  ffprobe: () => true,
  clusterWorker: () => true,
  embedder: () => true,
  gazetteer: () => true,
};

describe('computeCapabilities', () => {
  it('reports every capability available when all probes pass (the healthy packaged build)', () => {
    expect(computeCapabilities(ALL_TRUE)).toEqual({
      ffmpeg: true,
      ffprobe: true,
      clusterWorker: true,
      embedder: true,
      gazetteer: true,
    });
  });

  it('reflects each probe independently (a per-seam degrade is surfaced, not hidden)', () => {
    expect(computeCapabilities({ ...ALL_TRUE, ffmpeg: () => false })).toMatchObject({
      ffmpeg: false,
      ffprobe: true,
      clusterWorker: true,
    });
    expect(computeCapabilities({ ...ALL_TRUE, clusterWorker: () => false })).toMatchObject({
      clusterWorker: false,
      ffmpeg: true,
    });
    expect(computeCapabilities({ ...ALL_TRUE, embedder: () => false })).toMatchObject({
      embedder: false,
    });
    expect(computeCapabilities({ ...ALL_TRUE, gazetteer: () => false })).toMatchObject({
      gazetteer: false,
    });
  });
});

describe('isResolvable', () => {
  it('is true when the resolver returns without throwing', () => {
    expect(isResolvable(() => '/bin/ffmpeg')).toBe(true);
  });

  it('is false when the resolver throws (the bundled binary is absent)', () => {
    expect(
      isResolvable(() => {
        throw new Error('bundled ffmpeg not found');
      }),
    ).toBe(false);
  });
});

describe('buildVideoThumbnailer — loud, redacted ffmpeg degrade (#441)', () => {
  it('returns a working thumbnailer and stays SILENT when ffmpeg resolves', () => {
    const warn = vi.fn();
    const frame = vi.fn(async () => null);
    const thumbnailer = buildVideoThumbnailer({
      resolveFfmpegPath: () => '/bundled/ffmpeg',
      createFrameThumbnailer: () => frame,
      logger: { warn },
    });

    expect(typeof thumbnailer).toBe('function');
    expect(warn).not.toHaveBeenCalled();
  });

  it('degrades to a null thumbnailer AND warns loudly when the bundled ffmpeg is missing', async () => {
    const warn = vi.fn();
    const error = new Error('bundled ffmpeg not found at /res/media/mac-arm64/ffmpeg');
    const thumbnailer = buildVideoThumbnailer({
      resolveFfmpegPath: () => {
        throw error;
      },
      createFrameThumbnailer: () => {
        throw new Error('must not build a frame thumbnailer on the degrade path');
      },
      logger: { warn },
    });

    // Never throws on boot — degrades to a null thumbnailer (videos fall back to an icon).
    await expect(thumbnailer('/some/video.mp4', 320)).resolves.toBeNull();

    // Exactly ONE loud warning, framed as a possible packaging regression.
    expect(warn).toHaveBeenCalledTimes(1);
    const [message, forwarded] = warn.mock.calls[0] ?? [];
    expect(String(message).toLowerCase()).toContain('ffmpeg');
    expect(String(message).toLowerCase()).toContain('packaging');
    // Zero-egress diagnostics: the resolved binary path must NEVER be in the template
    // (only the redacting logger's Error arg is projected — the template is not).
    expect(String(message)).not.toContain('/res/media');
    // The caught error is forwarded as a SEPARATE arg so the redacting logger reduces
    // it to its safe {name, code} shape (never the raw message/stack).
    expect(forwarded).toBe(error);
  });
});
