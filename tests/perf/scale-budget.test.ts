import Database, { type Database as Db } from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Count every real cosine invocation the brute-force scan makes, WITHOUT changing
// its behaviour: the mock wraps `db/vector.cosineSimilarity` (the primitive
// `db/embeddings-repo` scans with) and forwards to the real implementation, so
// scores are identical and only the call count is observed. This is what makes
// the semantic-scan complexity assertion an OPERATION COUNT — deterministic and
// load-invariant — rather than a wall-clock measurement that flakes under CI load
// (#454). The counter is read via the exported `__cosineCalls` accessor below.
let cosineCalls = 0;
vi.mock('../../electron/main/db/vector', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../electron/main/db/vector')>();
  return {
    ...actual,
    cosineSimilarity: (a: Float32Array, b: Float32Array): number => {
      cosineCalls += 1;
      return actual.cosineSimilarity(a, b);
    },
  };
});

import { createCatalogRepo } from '../../electron/main/db/catalog-repo';
import { createEmbeddingsRepo } from '../../electron/main/db/embeddings-repo';
import { runMigrations } from '../../electron/main/db/migrate';
import { mergeSemanticAndExact, type SemanticHit } from '../../electron/main/search/semantic';
import { SCALE_BUDGET, COMPLEXITY_BOUNDS } from './scale-budget';

const MODEL = 'scale-budget-embed-v1';

// Deterministic PRNG so every seeded corpus is byte-identical run-to-run and
// machine-to-machine (no wall-clock, no Math.random ⇒ nothing to flake).
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

const randomUnitVector = (rng: () => number, dim: number): Float32Array => {
  const v = new Float32Array(dim);
  let normSq = 0;
  for (let i = 0; i < dim; i += 1) {
    const x = rng() - 0.5;
    v[i] = x;
    normSq += x * x;
  }
  const scale = 1 / Math.sqrt(normSq);
  for (let i = 0; i < dim; i += 1) v[i] *= scale;
  return v;
};

/** A fresh in-memory catalog seeded with `count` items, each with one embedding. */
function seedCorpus(count: number, dim: number): { db: Db; queryVector: Float32Array } {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const catalog = createCatalogRepo(db);
  const embeddings = createEmbeddingsRepo(db);
  const rng = mulberry32(0x5ca1e ^ count);
  // Batch the seed in one transaction so 30k inserts stay well inside the budget.
  db.exec('BEGIN');
  for (let i = 0; i < count; i += 1) {
    const id = `it-${String(i).padStart(6, '0')}`;
    catalog.insertItem({ id, mediaType: 'message', description: `item ${id}` });
    embeddings.upsertEmbedding(id, MODEL, randomUnitVector(rng, dim));
  }
  db.exec('COMMIT');
  return { db, queryVector: randomUnitVector(mulberry32(0xf00d), dim) };
}

beforeEach(() => {
  cosineCalls = 0;
});

describe('scale budget — documented library sizes + complexity bounds (#442)', () => {
  it('exposes a coherent, machine-checkable budget', () => {
    // The budget is an app COMMITMENT (docs/perf/scale-budget.md); pin the shape so
    // a doc/constant drift is caught, and sanity-check the internal relationships.
    expect(SCALE_BUDGET.items).toBeGreaterThanOrEqual(SCALE_BUDGET.embeddingVectors);
    expect(SCALE_BUDGET.embeddingVectors).toBeGreaterThan(0);
    expect(SCALE_BUDGET.embeddingDim).toBe(384);
    expect(SCALE_BUDGET.sources).toBeGreaterThan(0);
    expect(SCALE_BUDGET.collections).toBeGreaterThan(0);
    expect(Object.keys(COMPLEXITY_BOUNDS)).toEqual([
      'semanticScan',
      'smartMergeAugmentation',
      'themeClusterScan',
    ]);
  });

  it('brute-force semantic scan is LINEAR in the corpus size (one cosine per vector)', () => {
    // ADR-0029: the semantic scan is a brute-force cosine over EVERY stored vector
    // of the queried model. The complexity contract is O(vectors · dim) — exactly
    // one cosine per row, never n². Prove it by operation count at two sizes: the
    // call count must scale 1:1 with the corpus, so doubling the corpus exactly
    // doubles the cosines. Deterministic ⇒ never flakes under parallel CI load.
    const dim = SCALE_BUDGET.embeddingDim;
    const n = 2000;

    const small = seedCorpus(n, dim);
    cosineCalls = 0;
    createEmbeddingsRepo(small.db).semanticSearch(small.queryVector, 10, { modelId: MODEL });
    const callsSmall = cosineCalls;

    const large = seedCorpus(2 * n, dim);
    cosineCalls = 0;
    createEmbeddingsRepo(large.db).semanticSearch(large.queryVector, 10, { modelId: MODEL });
    const callsLarge = cosineCalls;

    expect(callsSmall).toBe(n); // one cosine per stored vector — nothing quadratic
    expect(callsLarge).toBe(2 * n);
    expect(callsLarge).toBe(2 * callsSmall); // strictly linear growth

    small.db.close();
    large.db.close();
  });

  it('scans the WHOLE corpus at the budget vector count (30k) with linear work', () => {
    // The load-bearing budget assertion: at the committed corpus size the scan
    // touches every vector exactly once (linear), with NO quadratic blow-up. This
    // is an operation count, not a timer, so it holds identically under any load.
    const { db, queryVector } = seedCorpus(SCALE_BUDGET.embeddingVectors, SCALE_BUDGET.embeddingDim);
    cosineCalls = 0;
    const start = performance.now();
    const hits = createEmbeddingsRepo(db).semanticSearch(queryVector, 20, { modelId: MODEL });
    const elapsed = performance.now() - start;

    expect(cosineCalls).toBe(SCALE_BUDGET.embeddingVectors); // linear, whole corpus
    expect(hits).toHaveLength(20);

    // SECONDARY pathology guard (NOT load-bearing): a 30k×384 in-process scan is
    // ~tens of ms; an 8s ceiling is >100× head-room, so it can only trip on a real
    // super-linear regression, never on CI scheduling jitter. The operation-count
    // assertion above is the actual complexity guard.
    expect(elapsed).toBeLessThan(8000);

    db.close();
  });

  it('semantic-hit count feeding smart search is bounded by the page limit, not the corpus', () => {
    // The PRODUCTION bound (`app/catalog-session`): the semantic list handed to the
    // merge is `embeddings.semanticSearch(queryVector, input.limit, …)` — pre-capped
    // at the page limit. That is what keeps smart search corpus-independent: the merge
    // input never grows with the corpus. Prove it on the actual code path at two corpus
    // sizes — a fixed limit K yields exactly K hits whether the corpus is n or 2n.
    const dim = SCALE_BUDGET.embeddingDim;
    const K = 20;

    const small = seedCorpus(3000, dim);
    const hitsSmall = createEmbeddingsRepo(small.db).semanticSearch(small.queryVector, K, {
      modelId: MODEL,
    });
    const large = seedCorpus(6000, dim);
    const hitsLarge = createEmbeddingsRepo(large.db).semanticSearch(large.queryVector, K, {
      modelId: MODEL,
    });

    // Exactly K hits at BOTH sizes — corpus-independent (would be n/2n if unbounded).
    expect(hitsSmall).toHaveLength(K);
    expect(hitsLarge).toHaveLength(K);

    small.db.close();
    large.db.close();
  });

  it('mergeSemanticAndExact CLAMPS semantic-only extras to the page limit (not the candidate count)', () => {
    // Second, independent bound: `mergeSemanticAndExact`'s own `limit` clamp caps the
    // semantic-only extras at `max(0, limit − exactCount)` — every exact row is kept
    // (AC-29) and only the remaining slots are filled, no matter how many semantic
    // candidates exist. Exercised DISCRIMINATINGLY: feed FAR more candidates than any
    // capacity below (the "corpus" that must NOT leak through) and assert the extras
    // equal the CLAMPED capacity, never the candidate count. Deleting the `capacity`
    // clamp in search/semantic.ts makes every count below wrong (all 200 would leak).
    const limit = 25;
    const candidates = 200; // ≫ any capacity below — must be clamped away
    const semantic: SemanticHit<{ id: string }>[] = Array.from({ length: candidates }, (_, i) => ({
      item: { id: `sem-${String(i).padStart(6, '0')}` },
      score: 1 - i / (candidates * 2),
    }));
    const exact = (size: number): { id: string }[] =>
      Array.from({ length: size }, (_, i) => ({ id: `x-${String(i).padStart(6, '0')}` }));
    const extras = (m: ReturnType<typeof mergeSemanticAndExact<{ id: string }>>): number =>
      m.filter((r) => r.origin === 'semantic').length;

    // 10 exact ⇒ 15 slots remain ⇒ extras clamp to 15 (NOT 200), merged fills to limit.
    const few = mergeSemanticAndExact(exact(10), semantic, { limit });
    expect(few).toHaveLength(limit);
    expect(extras(few)).toBe(limit - 10);

    // 20 exact ⇒ only 5 slots remain ⇒ extras clamp to 5. The 200-candidate pool never
    // leaks: extras depend on the LIMIT and the exact count, never the candidate count.
    const more = mergeSemanticAndExact(exact(20), semantic, { limit });
    expect(more).toHaveLength(limit);
    expect(extras(more)).toBe(limit - 20);

    // Exact set already at/over the limit ⇒ ZERO semantic extras, yet every exact row
    // is still preserved (AC-29) — augmentation is strictly bounded by the page limit.
    const over = mergeSemanticAndExact(exact(limit + 5), semantic, { limit });
    expect(over.filter((r) => r.origin !== 'semantic')).toHaveLength(limit + 5);
    expect(extras(over)).toBe(0);
  });
});
