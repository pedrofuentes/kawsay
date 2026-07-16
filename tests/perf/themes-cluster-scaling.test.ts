import { describe, expect, it, vi } from 'vitest';

// Count every real cosine invocation `clusterThemes` makes, WITHOUT changing its
// behaviour: the mock wraps `search/semantic.cosineSimilarity` (the module
// themes-cluster imports from) and forwards to the real implementation, so cluster
// output is identical and only the call count is observed.
//
// This is the #454 de-flake for #318's "scales sub-quadratically" assertion. The
// old test proved the bound with a WALL-CLOCK ratio (`boundedElapsed*2 <
// naiveElapsed`), which flaked under parallel CI load. The bounded scan (#318)
// replaced the per-(item, cluster) `cosineSimilarity` call with an inline,
// early-terminating dot product, so on the hot assignment loop it makes ZERO
// cosine calls — `clusterThemes` only calls `cosineSimilarity` once per retained
// member when finalising centroids. That gives an OPERATION-COUNT invariant that
// is exact and load-invariant: total cosine calls == number of retained members
// (O(n)), NOT O(n·k). A regression to the naive per-pair scan would blow the count
// up by orders of magnitude and fail deterministically, under any CPU load.
let cosineCalls = 0;
vi.mock('../../electron/main/search/semantic', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../electron/main/search/semantic')>();
  return {
    ...actual,
    cosineSimilarity: (a: Float32Array, b: Float32Array): number => {
      cosineCalls += 1;
      return actual.cosineSimilarity(a, b);
    },
  };
});

import {
  clusterThemes,
  type ThemeClusterItem,
} from '../../electron/main/categorize/themes-cluster';
import { cosineSimilarity } from '../../electron/main/search/semantic';

// Deterministic PRNG ⇒ the corpus is identical run-to-run and machine-to-machine.
const mulberry32 = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

describe('clusterThemes — scales sub-quadratically on a large diverse corpus (#318, de-flaked #454)', () => {
  it(
    'bounds the O(n²·dim) scan: assignment loop makes NO per-pair cosine calls',
    { timeout: 60_000 },
    () => {
      const CLUSTER_COUNT = 1000; // 2 items per cluster ⇒ k trends to n/2 (worst case)
      const DIM = 384; // production embedding dimension (ADR-0030)
      const N = CLUSTER_COUNT * 2;

      // Per-cluster deterministic base vector on the unit sphere; both members share
      // the base plus a tiny opposite-signed jitter so cos(m0, m1) ≥ 0.99 stays inside
      // τ while cross-cluster cosines concentrate near 0 (random unit vectors in R^384
      // have std ≈ 1/√dim ≈ 0.05, far below τ = 0.99) — a maximally diverse corpus.
      const items: ThemeClusterItem[] = [];
      for (let cluster = 0; cluster < CLUSTER_COUNT; cluster += 1) {
        const rng = mulberry32(0xc0ffee ^ cluster);
        const base = new Float32Array(DIM);
        let normSq = 0;
        for (let j = 0; j < DIM; j += 1) {
          const x = rng() - 0.5;
          base[j] = x;
          normSq += x * x;
        }
        const scale = 1 / Math.sqrt(normSq);
        for (let j = 0; j < DIM; j += 1) base[j] *= scale;
        const jitterAxis = cluster % DIM;
        for (const sign of [1, -1] as const) {
          const vector = new Float32Array(base);
          vector[jitterAxis] += sign * 0.01;
          const id = String(items.length).padStart(6, '0');
          items.push({ id, vector });
        }
      }
      expect(items).toHaveLength(N);

      const opts = { threshold: 0.99, minClusterSize: 1 };

      // Naive reference: the pre-#318 assignment loop — a full O(dim) cosine per
      // (item, cluster) pair with no bound. Structurally mirrors the module (sort by
      // id, strict-`>` argmax, τ-gate, sorted output) so its assignments are an
      // exactness oracle for the bounded impl on this large corpus.
      interface RefCluster {
        members: ThemeClusterItem[];
        sum: Float64Array;
        centroid: Float32Array;
      }
      const naiveClusterAssignments = (input: readonly ThemeClusterItem[]): string[][] => {
        const ordered = [...input].sort((l, r) => (l.id < r.id ? -1 : l.id > r.id ? 1 : 0));
        const working: RefCluster[] = [];
        for (const current of ordered) {
          let bestIdx = -1;
          let bestSim = Number.NEGATIVE_INFINITY;
          for (let c = 0; c < working.length; c += 1) {
            const sim = cosineSimilarity(current.vector, working[c].centroid);
            if (sim > bestSim) {
              bestSim = sim;
              bestIdx = c;
            }
          }
          if (bestIdx >= 0 && bestSim >= opts.threshold) {
            const cl = working[bestIdx];
            cl.members.push(current);
            for (let j = 0; j < DIM; j += 1) cl.sum[j] += current.vector[j];
            const cnt = cl.members.length;
            const centroid = new Float32Array(DIM);
            for (let j = 0; j < DIM; j += 1) centroid[j] = cl.sum[j] / cnt;
            cl.centroid = centroid;
          } else {
            const sum = new Float64Array(DIM);
            for (let j = 0; j < DIM; j += 1) sum[j] = current.vector[j];
            working.push({
              members: [current],
              sum,
              centroid: Float32Array.from(current.vector),
            });
          }
        }
        return working
          .sort((l, r) => (l.members[0].id < r.members[0].id ? -1 : 1))
          .map((cl) =>
            [...cl.members]
              .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
              .map((m) => m.id),
          );
      };

      const naiveAssignments = naiveClusterAssignments(items);

      // ── The de-flaked, deterministic complexity guard ──────────────────────────
      // Reset the counter AFTER the naive oracle (which itself calls the wrapped
      // cosine) so the count reflects ONLY the real clusterThemes call.
      cosineCalls = 0;
      const boundedResult = clusterThemes(items, opts);
      const boundedCosineCalls = cosineCalls;
      const boundedAssignments = boundedResult.clusters.map((cl) => cl.members.map((m) => m.id));

      // Correctness: the bounded scan produces IDENTICAL assignments to the naive
      // full-scan on this large diverse corpus (validates the Cauchy-Schwarz prune
      // never drops a real match nor breaks the strict-`>` tie-break).
      expect(boundedAssignments).toEqual(naiveAssignments);
      expect(boundedResult.clusters).toHaveLength(CLUSTER_COUNT);
      for (const cluster of boundedResult.clusters) {
        expect(cluster.size).toBe(2);
      }

      // Complexity (OPERATION COUNT — replaces the flaky wall-clock ratio, #454):
      // the bounded assignment loop makes NO per-pair cosine calls. `clusterThemes`
      // only calls `cosineSimilarity` once per retained member when finalising
      // centroids ⇒ exactly N calls here (all members retained, minClusterSize 1).
      // The naive per-pair scan would make Ω(n·k) ≈ millions — so this fails
      // deterministically if #318's bound is ever removed, under ANY CPU load.
      expect(boundedCosineCalls).toBe(N);
      // Guard the oracle: N is orders of magnitude below the naive per-pair cost, so
      // this is a genuine sub-quadratic assertion, not a trivially-satisfiable one.
      expect(boundedCosineCalls).toBeLessThan((N * CLUSTER_COUNT) / 100);
    },
  );
});
