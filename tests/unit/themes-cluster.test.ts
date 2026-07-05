import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  clusterThemes,
  themeSourceKey,
  THEME_CLUSTER_DEFAULTS,
  type ThemeClusterItem,
  type ThemeClusteringResult,
} from '../../electron/main/categorize/themes-cluster';
import { cosineSimilarity } from '../../electron/main/search/semantic';

// Build a float32 vector from plain numbers (test ergonomics, as semantic.test.ts).
const vec = (...values: number[]): Float32Array => Float32Array.from(values);
const item = (id: string, vector: Float32Array): ThemeClusterItem => ({ id, vector });

// A 2-D unit vector whose cosine similarity to (1, 0) is EXACTLY `c`:
//   cos((1,0), (c, √(1−c²))) = c / √(c² + (1−c²)) = c.
// Lets a test pin a pair's similarity just above / below τ with a wide margin.
const unitAtCos = (c: number): Float32Array => vec(c, Math.sqrt(Math.max(0, 1 - c * c)));

const membership = (result: ThemeClusteringResult): string[][] =>
  result.clusters.map((cluster) => cluster.members.map((member) => member.id));

describe('clusterThemes — threshold-agglomerative cosine clustering (ADR-0030 Decision 3)', () => {
  it('returns no clusters for empty input (graceful degrade, never crashes)', () => {
    expect(clusterThemes([])).toEqual({ clusters: [] });
    expect(clusterThemes([], { threshold: 0.5, minClusterSize: 1 })).toEqual({ clusters: [] });
  });

  it('groups near-identical vectors and separates dissimilar ones', () => {
    const items = [
      item('a1', vec(1, 0, 0)),
      item('a2', vec(0.99, 0.01, 0)),
      item('a3', vec(0.98, 0.02, 0)),
      item('b1', vec(0, 0, 1)),
      item('b2', vec(0.01, 0, 0.99)),
      item('b3', vec(0.02, 0, 0.98)),
    ];
    const result = clusterThemes(items, { threshold: 0.82, minClusterSize: 1 });
    expect(membership(result)).toEqual([
      ['a1', 'a2', 'a3'],
      ['b1', 'b2', 'b3'],
    ]);
    expect(result.clusters.map((c) => c.size)).toEqual([3, 3]);
  });

  it('merges a pair whose cosine is just above τ', () => {
    const result = clusterThemes([item('p1', vec(1, 0)), item('p2', unitAtCos(0.83))], {
      threshold: 0.82,
      minClusterSize: 1,
    });
    expect(membership(result)).toEqual([['p1', 'p2']]);
  });

  it('splits a pair whose cosine is just below τ', () => {
    const result = clusterThemes([item('p1', vec(1, 0)), item('p2', unitAtCos(0.81))], {
      threshold: 0.82,
      minClusterSize: 1,
    });
    expect(membership(result)).toEqual([['p1'], ['p2']]);
  });

  it('treats τ as inclusive (cosine ≥ τ merges): identical vectors merge at τ = 1', () => {
    const result = clusterThemes([item('p1', vec(1, 0)), item('p2', vec(1, 0))], {
      threshold: 1,
      minClusterSize: 1,
    });
    expect(membership(result)).toEqual([['p1', 'p2']]);
  });

  it('drops clusters smaller than minClusterSize (pruning)', () => {
    const items = [
      item('a1', vec(1, 0, 0)),
      item('a2', vec(1, 0, 0)),
      item('a3', vec(1, 0, 0)),
      item('lonely', vec(0, 1, 0)),
    ];
    expect(membership(clusterThemes(items, { threshold: 0.82, minClusterSize: 2 }))).toEqual([
      ['a1', 'a2', 'a3'],
    ]);
    // With no effective minimum, the singleton survives as its own cluster.
    expect(clusterThemes(items, { threshold: 0.82, minClusterSize: 1 }).clusters).toHaveLength(2);
  });

  it('clamps minClusterSize below 1 up to 1 (no pruning of singletons)', () => {
    const result = clusterThemes([item('solo', vec(1, 0))], { threshold: 0.82, minClusterSize: 0 });
    expect(membership(result)).toEqual([['solo']]);
  });

  it('is deterministic: identical output regardless of input order or repeated runs', () => {
    const base = [
      item('a1', vec(1, 0, 0)),
      item('a2', vec(0.99, 0.01, 0)),
      item('b1', vec(0, 1, 0)),
      item('b2', vec(0.01, 0.99, 0)),
      item('c1', vec(0, 0, 1)),
      item('c2', vec(0, 0.01, 0.99)),
    ];
    const shuffled = [base[4], base[0], base[3], base[1], base[5], base[2]];
    const opts = { threshold: 0.82, minClusterSize: 2 };

    const run1 = clusterThemes(base, opts);
    const run2 = clusterThemes(base, opts);
    const run3 = clusterThemes(shuffled, opts);

    expect(run2).toEqual(run1);
    expect(run3).toEqual(run1);
    expect(membership(run1)).toEqual([
      ['a1', 'a2'],
      ['b1', 'b2'],
      ['c1', 'c2'],
    ]);
  });

  it('reports each member’s cosine similarity to the final cluster centroid', () => {
    const result = clusterThemes(
      [item('a1', vec(1, 0)), item('a2', vec(1, 0)), item('a3', vec(1, 0))],
      { threshold: 0.5, minClusterSize: 1 },
    );
    expect(result.clusters).toHaveLength(1);
    for (const member of result.clusters[0].members) {
      expect(member.similarity).toBeCloseTo(1, 5);
    }
    // Centroid of three identical unit vectors is that unit vector.
    expect(result.clusters[0].centroid[0]).toBeCloseTo(1, 5);
    expect(result.clusters[0].centroid[1]).toBeCloseTo(0, 5);
  });

  it('computes the centroid as the elementwise mean of member vectors', () => {
    const v1 = vec(1, 0);
    const v2 = unitAtCos(0.99);
    const result = clusterThemes([item('a1', v1), item('a2', v2)], {
      threshold: 0.9,
      minClusterSize: 1,
    });
    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0].centroid[0]).toBeCloseTo((v1[0] + v2[0]) / 2, 5);
    expect(result.clusters[0].centroid[1]).toBeCloseTo((v1[1] + v2[1]) / 2, 5);
  });

  it('reports each member’s similarity as its cosine to the FINAL mean centroid, not a trivial 1', () => {
    // NON-identical members: the mean centroid differs from every member vector, so
    // each member's similarity is a distinct, non-1 value. This discriminates the
    // real centroid from a hardcoded `similarity: 1` and from a wrong-reference
    // vector (e.g. the first member instead of the mean).
    const v1 = vec(1, 0);
    const v2 = unitAtCos(0.997);
    const v3 = unitAtCos(0.94);
    const result = clusterThemes([item('a1', v1), item('a2', v2), item('a3', v3)], {
      threshold: 0.9,
      minClusterSize: 1,
    });
    expect(result.clusters).toHaveLength(1);

    // Oracle: the elementwise-mean centroid, computed INDEPENDENTLY of the module.
    const mean = vec((v1[0] + v2[0] + v3[0]) / 3, (v1[1] + v2[1] + v3[1]) / 3);
    const expected: Record<string, number> = {
      a1: cosineSimilarity(v1, mean),
      a2: cosineSimilarity(v2, mean),
      a3: cosineSimilarity(v3, mean),
    };
    for (const member of result.clusters[0].members) {
      expect(member.similarity).toBeCloseTo(expected[member.id], 5);
    }

    // Guard the oracle itself: the expected values are mutually distinct and none is
    // ~1, so the assertion above genuinely pins each member's cosine to the mean.
    const values = Object.values(expected);
    for (const value of values) expect(value).toBeLessThan(0.999);
    expect(new Set(values.map((value) => value.toFixed(4))).size).toBe(values.length);
  });

  it('throws on inconsistent vector dimensions (a programming error, per semantic.ts ethos)', () => {
    expect(() => clusterThemes([item('a', vec(1, 0, 0)), item('b', vec(1, 0))])).toThrow(
      /dimension/i,
    );
  });

  it('throws on a zero-length vector', () => {
    expect(() => clusterThemes([item('a', vec())])).toThrow(/dimension|non-empty|length/i);
  });

  it('throws on duplicate item ids (would make membership nondeterministic)', () => {
    expect(() => clusterThemes([item('dup', vec(1, 0)), item('dup', vec(0, 1))])).toThrow(
      /duplicate|unique/i,
    );
  });

  // ── #316: non-finite threshold / minClusterSize must throw (not silently return empty) ─────

  it('throws when threshold is NaN (not silently returns empty result)', () => {
    expect(() =>
      clusterThemes([item('a', vec(1, 0)), item('b', vec(1, 0))], { threshold: NaN }),
    ).toThrow(/threshold.*finite|non-finite.*threshold|threshold/i);
  });

  it('throws when threshold is Infinity', () => {
    expect(() =>
      clusterThemes([item('a', vec(1, 0)), item('b', vec(1, 0))], {
        threshold: Number.POSITIVE_INFINITY,
      }),
    ).toThrow(/threshold.*finite|non-finite.*threshold|threshold/i);
  });

  it('throws when threshold is -Infinity', () => {
    expect(() =>
      clusterThemes([item('a', vec(1, 0)), item('b', vec(1, 0))], {
        threshold: Number.NEGATIVE_INFINITY,
      }),
    ).toThrow(/threshold.*finite|non-finite.*threshold|threshold/i);
  });

  it('throws when minClusterSize is NaN (not silently returns empty result)', () => {
    expect(() =>
      clusterThemes([item('a', vec(1, 0)), item('b', vec(1, 0))], { minClusterSize: NaN }),
    ).toThrow(/minClusterSize.*finite|non-finite.*minClusterSize|minClusterSize/i);
  });

  it('throws when minClusterSize is Infinity', () => {
    expect(() =>
      clusterThemes([item('a', vec(1, 0)), item('b', vec(1, 0))], {
        minClusterSize: Number.POSITIVE_INFINITY,
      }),
    ).toThrow(/minClusterSize.*finite|non-finite.*minClusterSize|minClusterSize/i);
  });

  it('existing clamp behavior for finite values ≤ 1 is unchanged (clamps, never throws)', () => {
    // 0, -5, 1.7 are all finite — must clamp to ≥ 1, not throw.
    const twoIdentical = [item('a', vec(1, 0)), item('b', vec(1, 0))];
    expect(() => clusterThemes(twoIdentical, { minClusterSize: 0 })).not.toThrow();
    expect(() => clusterThemes(twoIdentical, { minClusterSize: -5 })).not.toThrow();
    expect(() => clusterThemes(twoIdentical, { minClusterSize: 1.7 })).not.toThrow();
  });

  // ── #317: non-finite vector element must throw (not silently prune the item) ──────────────

  it('throws when a vector element is NaN (non-finite element, silent prune is forbidden)', () => {
    expect(() => clusterThemes([item('a', vec(1, 0)), item('b', vec(NaN, 0))])).toThrow(
      /finite|NaN|non-finite/i,
    );
  });

  it('throws when a vector element is Infinity', () => {
    expect(() =>
      clusterThemes([item('a', vec(1, 0)), item('b', vec(Number.POSITIVE_INFINITY, 0))]),
    ).toThrow(/finite|NaN|non-finite/i);
  });

  it('throws when a vector element is -Infinity', () => {
    expect(() =>
      clusterThemes([item('a', vec(1, 0)), item('b', vec(Number.NEGATIVE_INFINITY, 0))]),
    ).toThrow(/finite|NaN|non-finite/i);
  });

  // ── #319: tie-break determinism — strict `>` means earliest-created cluster wins a tie ────

  it('tie-break: equidistant item joins earliest-created (smallest-first-id) cluster, not the later one', () => {
    // Items sorted by id: a1, b1, c1.
    // a1 (1,0) → opens cluster A.  b1 (0,1) → cos to A = 0 < threshold → opens cluster B.
    // c1 (√½, √½) has cosine √½ to both centroids — an exact tie at 45°.
    // Strict `>` means cluster A (index 0, found first) retains bestIndex → c1 joins A.
    // If `>` were `>=`, cluster B would overwrite bestIndex and c1 would join B instead.
    const sqrt2inv = Math.SQRT1_2; // 1/√2 ≈ 0.7071
    const items = [
      item('a1', vec(1, 0)),
      item('b1', vec(0, 1)),
      item('c1', vec(sqrt2inv, sqrt2inv)),
    ];
    const result = clusterThemes(items, { threshold: 0.7, minClusterSize: 1 });
    // c1 must be in the same cluster as a1 (cluster A), never with b1.
    const clusterA = result.clusters.find((cl) => cl.members.some((m) => m.id === 'a1'));
    const clusterB = result.clusters.find((cl) => cl.members.some((m) => m.id === 'b1'));
    expect(clusterA).toBeDefined();
    expect(clusterB).toBeDefined();
    expect(clusterA?.members.map((m) => m.id)).toContain('c1');
    expect(clusterB?.members.map((m) => m.id)).not.toContain('c1');
  });

  it('exposes documented defaults and applies them when options are omitted', () => {
    expect(THEME_CLUSTER_DEFAULTS.threshold).toBeGreaterThan(0);
    expect(THEME_CLUSTER_DEFAULTS.threshold).toBeLessThanOrEqual(1);
    expect(THEME_CLUSTER_DEFAULTS.minClusterSize).toBeGreaterThanOrEqual(1);

    const n = THEME_CLUSTER_DEFAULTS.minClusterSize;
    const items = Array.from({ length: n }, (_, i) => item(`d${i}`, vec(1, 0, 0)));
    const kept = clusterThemes(items); // no options ⇒ defaults
    expect(kept.clusters).toHaveLength(1);
    expect(kept.clusters[0].size).toBe(n);
    // One member short of the default minimum ⇒ pruned to nothing.
    expect(clusterThemes(items.slice(0, n - 1)).clusters).toHaveLength(0);
  });

  // ── #318: per-item candidate scan must be bounded so a large, topically-diverse ────
  // corpus (ADR-0030 cites n=10k–100k, dim=384) doesn't cost ~n²·dim float ops per
  // pass. Naive `k * cosineSimilarity` = O(n · k · dim) full inner-loops takes tens
  // of seconds even at moderate n; the bounded implementation must be materially
  // faster on the SAME hardware while producing IDENTICAL cluster output.
  it(
    'scales sub-quadratically on a large diverse corpus (bounds the O(n²·dim) scan, #318)',
    { timeout: 60_000 },
    () => {
      const N = 4000;
      const CLUSTER_COUNT = 2000; // 2 items per cluster ⇒ k trends to n/2 (worst case)
      const DIM = 384; // production embedding dimension (ADR-0030)

      // Deterministic PRNG so the corpus is identical run-to-run and machine-to-machine.
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

      // Per-cluster deterministic base vector on the unit sphere; both members of a
      // cluster share the base plus a tiny opposite-signed jitter so cos(m0, m1) ≥
      // 0.99 stays inside τ while cross-cluster cosines concentrate near 0 (random
      // unit vectors in R^384 have std ≈ 1/√dim ≈ 0.05, far below τ = 0.99).
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

      // Naive reference: the pre-#318 assignment loop — a full O(dim) cosine call
      // per (item, cluster) pair with no bound. Kept structurally minimal (matches
      // the module's algorithm bit-for-bit: sort by id, strict-`>` argmax, τ-gate,
      // sorted output by smallest member id) so the bounded impl's output can be
      // compared against it as an exactness oracle on this large corpus.
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

      // Warm the JIT on both hot paths with a small slice before timing, so neither
      // impl pays a cold-start tax that would skew the ratio comparison.
      const warmup = items.slice(0, 200);
      clusterThemes(warmup, opts);
      naiveClusterAssignments(warmup);

      const naiveStart = performance.now();
      const naiveAssignments = naiveClusterAssignments(items);
      const naiveElapsed = performance.now() - naiveStart;

      const boundedStart = performance.now();
      const boundedResult = clusterThemes(items, opts);
      const boundedElapsed = performance.now() - boundedStart;
      const boundedAssignments = boundedResult.clusters.map((cl) => cl.members.map((m) => m.id));

      // Correctness: the bounded scan must produce IDENTICAL assignments to the
      // naive full-scan on this large diverse corpus (validates that the Cauchy-
      // Schwarz prune never drops a real match nor breaks the strict-`>` tie-break).
      expect(boundedAssignments).toEqual(naiveAssignments);
      expect(boundedResult.clusters).toHaveLength(CLUSTER_COUNT);
      for (const cluster of boundedResult.clusters) {
        expect(cluster.size).toBe(2);
      }

      // Complexity bound: same hardware, same corpus, same algorithm shape — the
      // bounded impl must be materially faster (≥ 2×) than the naive O(n·k·dim)
      // reference. Gated behind a noise-floor: if naiveElapsed is too short
      // (< 50 ms), scheduling jitter can flip the ratio even on correct code, so
      // we skip the timing assertion rather than produce a false failure. The three
      // correctness oracles above are the load-bearing assertions regardless.
      if (naiveElapsed >= 50) {
        expect(boundedElapsed * 2).toBeLessThan(naiveElapsed);
      }
    },
  );
});

describe('themeSourceKey — deterministic, membership-derived re-cluster signature', () => {
  it('is "theme:" + sha256 hex of the members’ ids sorted ascending and joined by "\\n"', () => {
    const items = [item('z9', vec(1, 0, 0)), item('a1', vec(1, 0, 0)), item('m5', vec(1, 0, 0))];
    const result = clusterThemes(items, { threshold: 0.82, minClusterSize: 1 });
    expect(result.clusters).toHaveLength(1);
    const expected =
      'theme:' + createHash('sha256').update(['a1', 'm5', 'z9'].join('\n')).digest('hex');
    expect(result.clusters[0].sourceKey).toBe(expected);
  });

  it('is order-independent, namespaced, and collision-distinct on membership', () => {
    expect(themeSourceKey(['b', 'a', 'c'])).toBe(themeSourceKey(['a', 'b', 'c']));
    expect(themeSourceKey(['a', 'b'])).toMatch(/^theme:[0-9a-f]{64}$/);
    expect(themeSourceKey(['a', 'b'])).not.toBe(themeSourceKey(['a', 'c']));
  });

  it('yields the same source_key for the same membership across input orderings (idempotent)', () => {
    const opts = { threshold: 0.5, minClusterSize: 1 };
    const forward = clusterThemes(
      [item('a1', vec(1, 0)), item('a2', vec(1, 0)), item('a3', vec(1, 0))],
      opts,
    );
    const reversed = clusterThemes(
      [item('a3', vec(1, 0)), item('a1', vec(1, 0)), item('a2', vec(1, 0))],
      opts,
    );
    expect(forward.clusters[0].sourceKey).toBe(reversed.clusters[0].sourceKey);
  });
});
