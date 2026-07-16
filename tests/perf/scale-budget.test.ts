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

  it('smart-search semantic augmentation is bounded by the page limit, not the corpus', () => {
    // catalog-session merges the WHOLE exact set with at most `limit` semantic hits
    // (K = limit, page-independent). The complexity property that keeps smart search
    // affordable as the corpus grows: the count of semantic-only EXTRAS the merge
    // appends does NOT grow with the exact-set size — it stays ≤ K. Assert it at two
    // exact-set sizes with the SAME fixed-K semantic list: identical extra count.
    const K = 20; // a page limit
    const exact = (size: number): { id: string }[] =>
      Array.from({ length: size }, (_, i) => ({ id: `x-${String(i).padStart(6, '0')}` }));
    // K semantic hits on ids DISJOINT from any exact set (pure semantic-only extras).
    const semantic: SemanticHit<{ id: string }>[] = Array.from({ length: K }, (_, i) => ({
      item: { id: `sem-${String(i).padStart(6, '0')}` },
      score: 1 - i / (K * 2),
    }));

    const mergedSmall = mergeSemanticAndExact(exact(1000), semantic);
    const mergedLarge = mergeSemanticAndExact(exact(2000), semantic);

    const extras = (m: typeof mergedSmall): number =>
      m.filter((r) => r.origin === 'semantic').length;

    // Every exact row is preserved (AC-29) …
    expect(mergedSmall.filter((r) => r.origin !== 'semantic')).toHaveLength(1000);
    expect(mergedLarge.filter((r) => r.origin !== 'semantic')).toHaveLength(2000);
    // … and the semantic augmentation is EXACTLY K in both — page/corpus-independent.
    expect(extras(mergedSmall)).toBe(K);
    expect(extras(mergedLarge)).toBe(K);
    expect(extras(mergedLarge)).toBe(extras(mergedSmall));
  });
});
