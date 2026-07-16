// The Kawsay SCALE BUDGET — the library sizes the app commits to handling
// gracefully at v1, plus the algorithmic-complexity bounds that keep those sizes
// affordable. Filed for #442; the narrative lives in `docs/perf/scale-budget.md`.
//
// This is a machine-checkable MIRROR of that doc: the perf suite
// (`tests/perf/scale-budget.test.ts`) imports these numbers so the budget is
// enforced by a test, not just documented. It is deliberately test-side infra
// (no app module imports it): the budget describes a COMMITMENT and a set of
// complexity guards, it does not change any runtime algorithm.
//
// ── How the budget was chosen ────────────────────────────────────────────────
// ADR-0029 sizes the v1 semantic/search design at 10k–100k items with a
// dependency-free brute-force cosine scan (no vector DB). The budget picks a
// concrete supported point INSIDE that envelope: 50k items / 30k text-embedding
// vectors — a large personal archive (a decade of one person's messages, photos,
// and voice notes) — and pins the COMPLEXITY each hot path must keep so that
// point stays interactive on the main process. When a real corpus outgrows the
// brute-force scan, the ANN / cursor-merge follow-up (see the doc + backlog
// issue) is the escape hatch; the budget test is what tells us WHEN.

/** The supported library sizes (counts) the app commits to handling gracefully. */
export const SCALE_BUDGET = {
  /** Catalog items (messages, photos, videos, voice notes) — the timeline corpus. */
  items: 50_000,
  /** Stored text-embedding vectors — the brute-force semantic-search corpus (ADR-0029). */
  embeddingVectors: 30_000,
  /** Distinct import sources/accounts (one row per connected export). */
  sources: 500,
  /** Browsable collections (hand-made + accepted suggestions). */
  collections: 2_000,
  /** Production embedding dimension (multilingual-e5-small, ADR-0030). */
  embeddingDim: 384,
} as const;

/**
 * Complexity bounds each scale-sensitive path must respect so the {@link SCALE_BUDGET}
 * sizes stay affordable. These are the properties the perf test enforces (by
 * operation count, not wall clock), one per documented main-process cliff (#442):
 *
 * - `semanticScan` — the brute-force cosine scan (`db/embeddings-repo.semanticSearch`)
 *   is LINEAR in the vector-corpus size: exactly one `cosineSimilarity` per stored
 *   vector of the queried model, never n². This is the ADR-0029 "brute-force at v1
 *   scale" contract; it holds until the corpus outgrows `embeddingVectors`.
 * - `smartMergeAugmentation` — smart-search semantic augmentation is bounded by the
 *   PAGE LIMIT (K = limit), page-independent: the merged `total` and the count of
 *   semantic-only extras do NOT grow with the corpus or the page offset. (The
 *   remaining O(exact_total)-per-page exact refetch is the cursor-merge backlog.)
 * - `themeClusterScan` — theme clustering's per-item candidate scan is BOUNDED
 *   (Cauchy-Schwarz prune, #318): it does NOT fall back to a full O(dim)
 *   `cosineSimilarity` against every open cluster, so a diverse corpus never costs
 *   ~n²·dim float ops per pass.
 */
export const COMPLEXITY_BOUNDS = {
  semanticScan: 'O(vectors · dim) — linear, one cosine per stored vector',
  smartMergeAugmentation: 'O(limit) semantic extras — page-independent, not O(corpus)',
  themeClusterScan: 'bounded candidate scan — no full O(dim) cosine per (item, cluster) pair',
} as const;
