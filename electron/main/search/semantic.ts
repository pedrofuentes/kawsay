// Pure, dependency-free ranking primitives for on-device semantic search
// (ADR-0029 Decision 1, milestone M4-1). This module has NO database or model
// dependency: it is exhaustively unit-tested with synthetic vectors, and it
// drives the FTS-merge that a later slice (M4-1b) wires into the live search path.
//
// The governing rule is AC-29: the semantic layer EXTENDS exact search, it never
// regresses it. Every exact/FTS result is preserved and ranked ahead of any
// purely-semantic match, so with no model present search is exactly today's FTS.

// `cosineSimilarity` is a NEUTRAL vector-math primitive that lives in the db
// layer (../db/vector) so the brute-force cosine scan in db/embeddings-repo can
// depend on it WITHOUT reaching UP into ../search (the layering direction is
// db → primitive, never db → search). It is re-exported here so the ranking
// layer keeps a single semantic entry point.
export { cosineSimilarity } from '../db/vector';

/** A semantic (KNN) hit: an item and its cosine similarity to the query. */
export interface SemanticHit<T extends { readonly id: string }> {
  readonly item: T;
  readonly score: number;
}

/** Where a merged result came from: exact/FTS only, semantic only, or both. */
export type MergeOrigin = 'exact' | 'semantic' | 'both';

/** One entry of the merged result list (ADR-0029 merge). */
export interface MergedResult<T extends { readonly id: string }> {
  readonly item: T;
  readonly origin: MergeOrigin;
  /** Cosine similarity when the item was a semantic hit (`semantic`/`both`);
   *  null for an exact-only result. */
  readonly score: number | null;
}

/** Options for {@link mergeSemanticAndExact}. */
export interface MergeOptions {
  /**
   * Cap the TOTAL number of merged results. Exact results are ALWAYS kept —
   * never dropped to honour the cap (AC-29): the limit only bounds how many
   * semantic-only items are appended. Omitted ⇒ no cap.
   */
  readonly limit?: number;
  /**
   * Minimum similarity a SEMANTIC-ONLY item must meet to be included. Exact
   * (and exact+semantic) results are kept regardless of score. Omitted ⇒ 0.
   */
  readonly minScore?: number;
}

/**
 * Merge exact/FTS results with semantic KNN hits per ADR-0029:
 *   • every exact result is preserved, in its exact order, AHEAD of any
 *     semantic-only item — an exact match is never dropped or demoted (AC-29);
 *   • an item present in BOTH appears once, at its exact position, tagged
 *     `both` and carrying its semantic score;
 *   • semantic-only items follow, ordered by similarity desc (ties broken by
 *     id asc for determinism) and filtered by `minScore`;
 *   • the result is deterministic regardless of the semantic input order.
 *
 * Pure and generic over any `{ id }` item, so it is unit-tested with synthetic
 * data and reused by the live-search merge (M4-1b) without a DB dependency.
 */
export function mergeSemanticAndExact<T extends { readonly id: string }>(
  exact: readonly T[],
  semantic: readonly SemanticHit<T>[],
  opts: MergeOptions = {},
): MergedResult<T>[] {
  // Best (max) score per semantic id — dedupes repeated hits deterministically —
  // and one item reference per id for the semantic-only tail.
  const bestScore = new Map<string, number>();
  const itemById = new Map<string, T>();
  for (const { item, score } of semantic) {
    const previous = bestScore.get(item.id);
    if (previous === undefined || score > previous) bestScore.set(item.id, score);
    if (!itemById.has(item.id)) itemById.set(item.id, item);
  }

  const merged: MergedResult<T>[] = [];
  const exactIds = new Set<string>();

  // 1. Every exact result, in exact order — never dropped or demoted (AC-29).
  for (const item of exact) {
    if (exactIds.has(item.id)) continue; // guard against a duplicated exact id
    exactIds.add(item.id);
    const score = bestScore.get(item.id);
    merged.push({ item, origin: score === undefined ? 'exact' : 'both', score: score ?? null });
  }

  // 2. Semantic-only items: ranked by (score desc, id asc), minScore-filtered,
  //    then appended AFTER every exact result (so exact is never demoted).
  const minScore = opts.minScore ?? 0;
  const semanticOnly = [...bestScore.entries()]
    .filter(([id, score]) => !exactIds.has(id) && score >= minScore)
    .sort((left, right) => compareByScoreThenId(left, right));

  const capacity =
    opts.limit === undefined ? semanticOnly.length : Math.max(0, opts.limit - merged.length);
  for (const [id, score] of semanticOnly.slice(0, capacity)) {
    const item = itemById.get(id);
    if (item !== undefined) merged.push({ item, origin: 'semantic', score });
  }

  return merged;
}

/** Deterministic order for semantic-only entries: score desc, then id asc. */
function compareByScoreThenId(
  [leftId, leftScore]: readonly [string, number],
  [rightId, rightScore]: readonly [string, number],
): number {
  if (rightScore !== leftScore) return rightScore - leftScore;
  if (leftId === rightId) return 0;
  return leftId < rightId ? -1 : 1;
}
