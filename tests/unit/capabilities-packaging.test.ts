import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  createCapabilitiesResolver,
  type CapabilityResolveInputs,
} from '../../electron/main/app/capabilities';

// A PACKAGING-LEVEL guard (#441), complementing the runtime scripts/verify-media-binaries.
// Crucially it drives the REAL production wiring — the exact `createCapabilitiesResolver`
// closure the composition root answers `app:capabilities` with — NOT a copy of it, so a
// regression in the probe→DTO mapping (a swapped resolver, a wrong path var, a dropped
// binding) is caught here rather than shipping a FALSE-HEALTHY report for a broken build
// (the silent-degrade class this issue exists to prevent). A supported target (mac-arm64)
// is pinned so the staged layout is identical on any CI host (the resolvers take an
// explicit platform/arch), never dependent on the OS the suite happens to run on.

const platform: NodeJS.Platform = 'darwin';
const arch = 'arm64';
const target = `mac-${arch}`;

interface StageOptions {
  ffmpeg?: boolean;
  ffprobe?: boolean;
  embed?: boolean;
  gazetteer?: boolean;
  clusterWorker?: boolean;
}

interface StagedTree {
  resourcesPath: string;
  clusterWorkerPath: string;
}

/** Stage a packaged resources tree + the built worker entry, omitting any piece asked. */
function stageTree(opts: StageOptions = {}): StagedTree {
  const {
    ffmpeg = true,
    ffprobe = true,
    embed = true,
    gazetteer = true,
    clusterWorker = true,
  } = opts;
  const root = mkdtempSync(join(tmpdir(), 'kawsay-pack-'));
  const resourcesPath = join(root, 'resources');

  const mediaDir = join(resourcesPath, 'media', target);
  mkdirSync(mediaDir, { recursive: true });
  if (ffmpeg) writeFileSync(join(mediaDir, 'ffmpeg'), '');
  if (ffprobe) writeFileSync(join(mediaDir, 'ffprobe'), '');

  const embedDir = join(resourcesPath, 'embed', target);
  mkdirSync(embedDir, { recursive: true });
  if (embed) {
    writeFileSync(join(embedDir, 'llama-embedding'), '');
    writeFileSync(join(embedDir, 'multilingual-e5-small-q4_k_m.gguf'), '');
  }

  const gazetteerDir = join(resourcesPath, 'gazetteer');
  mkdirSync(gazetteerDir, { recursive: true });
  if (gazetteer) writeFileSync(join(gazetteerDir, 'cities1000.ndjson'), '');

  const moduleDir = join(root, 'out', 'main');
  mkdirSync(moduleDir, { recursive: true });
  const clusterWorkerPath = join(moduleDir, 'categorization-cluster-worker.js');
  if (clusterWorker) writeFileSync(clusterWorkerPath, '');

  return { resourcesPath, clusterWorkerPath };
}

/** Build the REAL production resolver over a staged tree (pinned target for CI parity). */
function resolverFor(
  tree: StagedTree,
  logger?: { warn: ReturnType<typeof vi.fn> },
): () => ReturnType<ReturnType<typeof createCapabilitiesResolver>> {
  const resolveInputs = (): CapabilityResolveInputs => ({
    isPackaged: true,
    resourcesPath: tree.resourcesPath,
    projectRoot: '/unused',
    platform,
    arch,
  });
  return createCapabilitiesResolver({
    resolveInputs,
    clusterWorkerPath: tree.clusterWorkerPath,
    ...(logger ? { logger } : {}),
  });
}

describe('packaged build capability report — REAL wiring (packaging guard #441)', () => {
  it('reports EVERY capability available for a fully staged packaged tree', () => {
    const report = resolverFor(stageTree())();

    expect(report).toEqual({
      ffmpeg: true,
      ffprobe: true,
      clusterWorker: true,
      embedder: true,
      gazetteer: true,
    });
  });

  it('flags the packaging regression when the media binaries are omitted (the missing-ffmpeg incident)', () => {
    const logger = { warn: vi.fn() };
    const report = resolverFor(stageTree({ ffmpeg: false, ffprobe: false }), logger)();

    expect(report.ffmpeg).toBe(false);
    expect(report.ffprobe).toBe(false);
    // The worker entry (staged) is still reported healthy — the report is per-seam.
    expect(report.clusterWorker).toBe(true);
  });

  it('flags a missing cluster worker entry (silent main-thread clustering regression)', () => {
    const report = resolverFor(stageTree({ clusterWorker: false }))();

    expect(report.clusterWorker).toBe(false);
    expect(report.ffmpeg).toBe(true);
  });
});

describe('createCapabilitiesResolver — loud, redacted per-seam degrade (#441)', () => {
  it('warns LOUDLY (redacted, no path) when ffprobe is missing, forwarding the Error as a separate arg', () => {
    const logger = { warn: vi.fn() };
    const report = resolverFor(stageTree({ ffprobe: false }), logger)();

    expect(report.ffprobe).toBe(false);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [message, forwarded] = logger.warn.mock.calls[0] ?? [];
    expect(String(message).toLowerCase()).toContain('ffprobe');
    expect(String(message).toLowerCase()).toContain('packaging');
    // Zero-egress: the resolved binary path must NEVER be in the template.
    expect(String(message)).not.toContain(target);
    // The caught error is forwarded as a SEPARATE arg so the redacting logger reduces
    // it to its safe {name, code} shape — never interpolated into the template.
    expect(forwarded).toBeInstanceOf(Error);
  });

  it('warns LOUDLY when the smart-search embedder is unavailable, with the reason as a structured arg (no path)', () => {
    const logger = { warn: vi.fn() };
    const report = resolverFor(stageTree({ embed: false }), logger)();

    expect(report.embedder).toBe(false);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [message, forwarded] = logger.warn.mock.calls[0] ?? [];
    expect(String(message).toLowerCase()).toContain('embedder');
    expect(String(message)).not.toContain(target);
    // The reason is a bounded enum, forwarded as a structured arg — never a path.
    expect(forwarded).toEqual({ reason: 'binary-unavailable' });
  });

  it('does NOT double-log the ffmpeg-only degrade (it is logged at its own thumbnailer seam)', () => {
    const logger = { warn: vi.fn() };
    // ffmpeg absent but ffprobe present (+ everything else): the resolver reports
    // ffmpeg:false but stays SILENT — buildVideoThumbnailer owns that loud warning.
    const report = resolverFor(stageTree({ ffmpeg: false }), logger)();

    expect(report.ffmpeg).toBe(false);
    expect(report.ffprobe).toBe(true);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('warns at most ONCE per seam across repeated reports (a re-query never re-spams)', () => {
    const logger = { warn: vi.fn() };
    const resolve = resolverFor(stageTree({ ffprobe: false, embed: false }), logger);

    resolve();
    resolve();
    resolve();

    // Exactly one ffprobe warning + one embedder warning across three reports.
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });
});
