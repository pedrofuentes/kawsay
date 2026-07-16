# Scale budget (#442)

The library sizes Kawsay commits to handling **gracefully on the main process at
v1**, and the algorithmic-complexity bounds that keep those sizes affordable.

This is the "measure first" companion to ADR-0029's semantic/search design: that
ADR reserves ANN / vector-DB work as a follow-up "only when brute-force is
measured too slow." This doc picks the concrete supported point and adds a perf
test that **enforces the complexity** each hot path must keep — so we know *when*
the follow-up is actually needed rather than guessing.

The numbers live as a machine-checkable constant in
[`tests/perf/scale-budget.ts`](../../tests/perf/scale-budget.ts) and are enforced
by [`tests/perf/scale-budget.test.ts`](../../tests/perf/scale-budget.test.ts).

## Supported library sizes

| Dimension                    | Budget   | Rationale                                                            |
| ---------------------------- | -------- | ------------------------------------------------------------------- |
| Catalog **items**            | 50,000   | A large personal archive — ~a decade of one person's memories.      |
| Text-embedding **vectors**   | 30,000   | The brute-force semantic-search corpus (ADR-0029, inside 10k–100k). |
| Import **sources**           | 500      | Distinct connected exports/accounts.                                |
| **Collections**              | 2,000    | Hand-made + accepted suggested collections.                         |
| Embedding **dimension**      | 384      | `multilingual-e5-small` (ADR-0030).                                 |

These sit inside ADR-0029's stated 10k–100k envelope; 50k/30k is the point the
perf suite asserts against.

## Complexity bounds (what the perf test enforces)

The budget is affordable only if each scale-sensitive path keeps its complexity.
The perf test enforces these by **operation count** (deterministic, load-invariant)
rather than wall-clock timing (which flakes under parallel CI load — see #454):

- **Brute-force semantic scan** (`db/embeddings-repo.semanticSearch`) —
  **O(vectors · dim), linear**: exactly one `cosineSimilarity` per stored vector of
  the queried model, never n². Holds until the corpus outgrows the vector budget.
- **Smart-search semantic augmentation** (`app/catalog-session`) — the merge appends
  **at most `limit` semantic-only extras (K = page limit), page- and
  corpus-independent**. The `total` does not grow with offset. *(The remaining
  O(exact_total) exact refetch per page is the cursor-merge backlog below.)*
- **Theme clustering candidate scan** (`categorize/themes-cluster`) — the per-item
  scan is **bounded** (Cauchy-Schwarz prune, #318): it never falls back to a full
  O(dim) cosine against every open cluster, so a diverse corpus never costs ~n²·dim
  float ops per pass.

## Known cliffs beyond the budget — queued, not implemented

These are correct at v1 scale but become main-process cliffs as a library grows.
They are **deliberately not implemented** here (measure first); the perf test is the
tripwire that tells us when the corpus has outgrown the brute-force approach.

1. **Pre-filtered / ANN vector scan.** `semanticSearch` decodes and scans *every*
   stored vector in-process. Past the vector budget, replace with a pre-filtered
   scan or an ANN index (`sqlite-vec` loadable extension or an HNSW lib). Both are
   **new native/loadable dependencies → human-required** (ADR-0029).
2. **Cursor-based semantic merge.** Smart search re-fetches the entire exact-match
   set on every page (`catalog-session`: `repo.search({ limit: exactPage.total,
   offset: 0 })`) to do global-merge pagination. Replace with a cursor-based merge
   that does not refetch the whole exact set per page.
3. **Heavy reads on a worker.** Synchronous better-sqlite3 timeline/search reads run
   on the main process; move to a worker if they start blocking the IPC loop.

Tracked in **#477** (ANN / cursor-based semantic merge backlog). Order of work is
decided by the budget test: implement a cliff's fix only once the corpus crosses the
budget and the test shows the bound actually broken.

> **CI note:** the perf suite is a serial vitest `perf` project (single fork, no
> file parallelism, generous timeout). A dedicated CI *shard* that runs it alone
> would further isolate it from CPU contention, but that needs a workflow change —
> left for human follow-up (not added here).
