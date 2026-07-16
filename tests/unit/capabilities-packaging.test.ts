import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeCapabilities, isResolvable } from '../../electron/main/app/capabilities';
import {
  resolveFfmpegPath,
  resolveFfprobePath,
} from '../../electron/main/importers/deps/media-binaries';
import { createEmbedder } from '../../electron/main/search/embed-cli';
import { isGazetteerBundled } from '../../electron/main/categorize/gazetteer';

// A PACKAGING-LEVEL guard (#441), complementing the runtime scripts/verify-media-binaries:
// given a FULLY staged packaged resources tree (all bundled binaries, the embedder
// model, the gazetteer, AND the built off-thread cluster-worker entry), the aggregate
// capability probe — wired exactly as the composition root wires it — must report
// EVERY capability available. A packaged build that reports any capability degraded is
// the very packaging regression this issue makes loud (the v0.2.0 missing-ffmpeg
// incident that motivated verify-media-binaries).
//
// A supported target (mac-arm64) is pinned so the staged layout is identical on any
// CI host (the resolvers take an explicit platform/arch), never dependent on the OS
// the suite happens to run on.

const platform: NodeJS.Platform = 'darwin';
const arch = 'arm64';
const target = `mac-${arch}`;

interface StagedTree {
  resourcesPath: string;
  clusterWorkerPath: string;
}

/** Stage a complete packaged resources tree + the built worker entry in a temp dir. */
function stageFullPackagedTree(): StagedTree {
  const root = mkdtempSync(join(tmpdir(), 'kawsay-pack-full-'));
  const resourcesPath = join(root, 'resources');

  const mediaDir = join(resourcesPath, 'media', target);
  mkdirSync(mediaDir, { recursive: true });
  writeFileSync(join(mediaDir, 'ffmpeg'), '');
  writeFileSync(join(mediaDir, 'ffprobe'), '');

  const embedDir = join(resourcesPath, 'embed', target);
  mkdirSync(embedDir, { recursive: true });
  writeFileSync(join(embedDir, 'llama-embedding'), '');
  writeFileSync(join(embedDir, 'multilingual-e5-small-q4_k_m.gguf'), '');

  const gazetteerDir = join(resourcesPath, 'gazetteer');
  mkdirSync(gazetteerDir, { recursive: true });
  writeFileSync(join(gazetteerDir, 'cities1000.ndjson'), '');

  // The off-thread cluster worker entry ships alongside the built main entry.
  const moduleDir = join(root, 'out', 'main');
  mkdirSync(moduleDir, { recursive: true });
  const clusterWorkerPath = join(moduleDir, 'categorization-cluster-worker.js');
  writeFileSync(clusterWorkerPath, '');

  return { resourcesPath, clusterWorkerPath };
}

function reportFor(resourcesPath: string, clusterWorkerPath: string): ReturnType<typeof computeCapabilities> {
  const inputs = { isPackaged: true, resourcesPath, projectRoot: '/unused', platform, arch };
  return computeCapabilities({
    ffmpeg: () => isResolvable(() => resolveFfmpegPath(inputs)),
    ffprobe: () => isResolvable(() => resolveFfprobePath(inputs)),
    clusterWorker: () => existsSync(clusterWorkerPath),
    embedder: () => createEmbedder(inputs).available,
    gazetteer: () => isGazetteerBundled(inputs),
  });
}

describe('packaged build capability report (packaging guard #441)', () => {
  it('reports EVERY capability available for a fully staged packaged tree', () => {
    const { resourcesPath, clusterWorkerPath } = stageFullPackagedTree();

    expect(reportFor(resourcesPath, clusterWorkerPath)).toEqual({
      ffmpeg: true,
      ffprobe: true,
      clusterWorker: true,
      embedder: true,
      gazetteer: true,
    });
  });

  it('flags the packaging regression when a bundled binary is omitted (the missing-ffmpeg incident)', () => {
    const { clusterWorkerPath } = stageFullPackagedTree();
    // An otherwise-complete tree whose media dir was never staged — exactly the
    // silent v0.2.0 failure this guard now makes visible.
    const emptyResources = mkdtempSync(join(tmpdir(), 'kawsay-pack-empty-'));

    const report = reportFor(emptyResources, clusterWorkerPath);

    expect(report.ffmpeg).toBe(false);
    expect(report.ffprobe).toBe(false);
    // The worker entry (staged) is still reported healthy — the report is per-seam.
    expect(report.clusterWorker).toBe(true);
  });

  it('flags a missing cluster worker entry (silent main-thread clustering regression)', () => {
    const { resourcesPath } = stageFullPackagedTree();

    const report = reportFor(resourcesPath, join(tmpdir(), 'nonexistent-cluster-worker.js'));

    expect(report.clusterWorker).toBe(false);
    expect(report.ffmpeg).toBe(true);
  });
});
