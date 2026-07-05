import { createHash } from 'node:crypto';
import { cosineSimilarity } from '../search/semantic';

// Pure, dependency-free THEME clustering over the M4-1 text embeddings
// (ADR-0030 Decision 3, milestone M4-2, card M4-2e). Like `search/semantic.ts`,
// this module has NO database, model, or filesystem dependency: it operates on
// already-decoded vectors passed in by the caller, so it is exhaustively unit-
// tested with synthetic vectors and reused by the categorization orchestrator
// (a later card) which decodes `item_embeddings` blobs (via `decodeVector`) and
// feeds them here.
//
// ── Algorithm: threshold agglomerative / greedy online clustering ────────────
// We iterate items in stable `id` order and assign each to the EXISTING cluster
// whose centroid is nearest in cosine similarity when that similarity is ≥ τ,
// otherwise we open a new cluster; centroids are maintained incrementally and
// clusters below a minimum size are dropped. This is chosen over k-means (k is
// unknown and seeding is non-deterministic) and over raw DBSCAN-over-cosine
// because it needs no density parameter, reuses `cosineSimilarity`, and — under
// a fixed id ordering with a first-wins tie-break — is fully DETERMINISTIC, so
// the same items always yield the same clusters, membership, and `source_key`.
// DBSCAN-over-cosine remains the documented alternative (ADR-0030 Decision 3) if
// real-corpus fixtures show local density beats a single global threshold.
//
// Determinism mirrors `semantic.ts`: a total, locale-independent id order (`<`
// on the raw string, never `localeCompare`), a strict-`>` "nearest" selection so
// the earliest-created (smallest-first-id) cluster wins a tie, and output sorted
// by each cluster's smallest member id.

/** One item to cluster: a stable id and its embedding vector (384-dim in prod). */
export interface ThemeClusterItem {
  readonly id: string;
  readonly vector: Float32Array;
}

/** Tunables for {@link clusterThemes}; omitted fields fall back to {@link THEME_CLUSTER_DEFAULTS}. */
export interface ThemeClusteringOptions {
  /**
   * Cosine-similarity threshold τ (INCLUSIVE): an item joins the nearest cluster
   * when its cosine to that cluster's centroid is ≥ τ, else it starts a new one.
   * Higher ⇒ tighter, more numerous themes. Should be a finite cosine in [-1, 1].
   */
  readonly threshold?: number;
  /**
   * Minimum members a cluster must have to be RETAINED; smaller clusters are
   * dropped (their items get no theme). Coerced to an integer ≥ 1 (values below
   * 1 clamp to 1, so singletons are kept).
   */
  readonly minClusterSize?: number;
}

/**
 * Documented defaults. `threshold` is a conservative starting point for the
 * `multilingual-e5-small` space, tunable per real fixtures (ADR-0030 Decision 3);
 * `minClusterSize` avoids trivial one/two-item themes.
 */
export const THEME_CLUSTER_DEFAULTS = {
  threshold: 0.82,
  minClusterSize: 3,
} as const satisfies Required<ThemeClusteringOptions>;

/** A member of a theme cluster with its cosine similarity to the final centroid. */
export interface ThemeClusterMember {
  readonly id: string;
  /** Cosine of this item's vector to the cluster's final centroid, in [-1, 1]
   *  (the auto-assignment confidence feed, ADR-0030 Decision 3). */
  readonly similarity: number;
}

/** A retained theme cluster: its members, mean centroid, size, and re-cluster key. */
export interface ThemeCluster {
  /** Deterministic, membership-derived signature — see {@link themeSourceKey}. */
  readonly sourceKey: string;
  /** Members in ascending id order. */
  readonly members: readonly ThemeClusterMember[];
  /** Elementwise mean of the members' vectors (same dimension as the inputs). */
  readonly centroid: Float32Array;
  readonly size: number;
}

/** The result of a clustering pass: retained clusters, ordered by smallest member id. */
export interface ThemeClusteringResult {
  readonly clusters: readonly ThemeCluster[];
}

/** Namespace prefix so a theme key never collides with a place key (a gazetteer id). */
const THEME_SOURCE_KEY_PREFIX = 'theme:';

/**
 * Deterministic re-cluster signature for a set of item ids: the SHA-256 hex of
 * the ids sorted ascending and joined by "\n", prefixed with `theme:`. Depends
 * ONLY on the membership set (order-independent), so the same cluster of items
 * always produces the same key across runs and machines — the idempotent upsert
 * key later stored in `categories.source_key` (ADR-0030 Decision 1). Bump the
 * prefix to version the scheme if the canonical form ever changes.
 */
export function themeSourceKey(memberIds: readonly string[]): string {
  const canonical = [...memberIds].sort(compareIdsAsc).join('\n');
  const digest = createHash('sha256').update(canonical, 'utf8').digest('hex');
  return `${THEME_SOURCE_KEY_PREFIX}${digest}`;
}

/**
 * Cluster items into themes by greedy threshold agglomeration over cosine
 * similarity (see the module header). Pure and deterministic: the output depends
 * only on the items and options, never on input order. Empty input degrades to
 * an empty result (no themes, no crash). Throws on malformed input — an empty
 * vector, a dimension mismatch, or a duplicate id — since each is a programming
 * error that would make results ill-defined or nondeterministic.
 */
export function clusterThemes(
  items: readonly ThemeClusterItem[],
  options: ThemeClusteringOptions = {},
): ThemeClusteringResult {
  if (items.length === 0) return { clusters: [] };

  const dim = validateAndDim(items);
  const threshold = options.threshold ?? THEME_CLUSTER_DEFAULTS.threshold;
  if (!Number.isFinite(threshold)) {
    throw new Error(`clusterThemes: threshold must be finite, got ${String(threshold)}`);
  }
  const rawMinClusterSize = options.minClusterSize ?? THEME_CLUSTER_DEFAULTS.minClusterSize;
  if (!Number.isFinite(rawMinClusterSize)) {
    throw new Error(
      `clusterThemes: minClusterSize must be finite, got ${String(rawMinClusterSize)}`,
    );
  }
  const minClusterSize = Math.max(1, Math.trunc(rawMinClusterSize));

  // Stable id order ⇒ reproducible clustering (the semantic.ts determinism rule).
  const ordered = [...items].sort((left, right) => compareIdsAsc(left.id, right.id));

  const working: WorkingCluster[] = [];
  for (const current of ordered) {
    let bestIndex = -1;
    let bestSimilarity = Number.NEGATIVE_INFINITY;
    for (let c = 0; c < working.length; c += 1) {
      const similarity = cosineSimilarity(current.vector, working[c].centroid);
      // Strict `>` ⇒ on a tie the earliest-created (smallest-first-id) cluster wins.
      if (similarity > bestSimilarity) {
        bestSimilarity = similarity;
        bestIndex = c;
      }
    }
    if (bestIndex >= 0 && bestSimilarity >= threshold) {
      addMember(working[bestIndex], current, dim);
    } else {
      working.push(newCluster(current, dim));
    }
  }

  const clusters = working
    .filter((cluster) => cluster.members.length >= minClusterSize)
    .sort((left, right) => compareIdsAsc(left.members[0].id, right.members[0].id))
    .map(finalizeCluster);

  return { clusters };
}

// ── Internals ────────────────────────────────────────────────────────────────

/** A cluster under construction: members plus an incrementally maintained centroid. */
interface WorkingCluster {
  readonly members: ThemeClusterItem[];
  /** Running elementwise SUM of member vectors (Float64 for accumulation precision). */
  readonly sum: Float64Array;
  /** Current mean = sum / count, cached as Float32 for the cosine comparison. */
  centroid: Float32Array;
}

function newCluster(item: ThemeClusterItem, dim: number): WorkingCluster {
  const sum = new Float64Array(dim);
  for (let i = 0; i < dim; i += 1) sum[i] = item.vector[i];
  return { members: [item], sum, centroid: Float32Array.from(item.vector) };
}

function addMember(cluster: WorkingCluster, item: ThemeClusterItem, dim: number): void {
  cluster.members.push(item);
  for (let i = 0; i < dim; i += 1) cluster.sum[i] += item.vector[i];
  const count = cluster.members.length;
  const centroid = new Float32Array(dim);
  for (let i = 0; i < dim; i += 1) centroid[i] = cluster.sum[i] / count;
  cluster.centroid = centroid;
}

function finalizeCluster(cluster: WorkingCluster): ThemeCluster {
  // Members are appended in ascending id order (we iterate `ordered`), but sort
  // defensively so membership and the derived source_key are order-independent.
  const orderedMembers = [...cluster.members].sort((left, right) =>
    compareIdsAsc(left.id, right.id),
  );
  const centroid = cluster.centroid;
  const members = orderedMembers.map((member) => ({
    id: member.id,
    similarity: cosineSimilarity(member.vector, centroid),
  }));
  return {
    sourceKey: themeSourceKey(members.map((member) => member.id)),
    members,
    centroid,
    size: members.length,
  };
}

/** Validate the batch and return the shared vector dimension. */
function validateAndDim(items: readonly ThemeClusterItem[]): number {
  const dim = items[0].vector.length;
  if (dim === 0) {
    throw new Error('clusterThemes: vectors must be non-empty (dimension > 0)');
  }
  const seen = new Set<string>();
  for (const item of items) {
    if (item.vector.length !== dim) {
      throw new Error(
        `clusterThemes: dimension mismatch (${item.vector.length} vs ${dim}) for item ${item.id}`,
      );
    }
    if (seen.has(item.id)) {
      throw new Error(`clusterThemes: duplicate item id ${item.id} (ids must be unique)`);
    }
    if (!item.vector.every(Number.isFinite)) {
      throw new Error(
        `clusterThemes: non-finite element in vector for item ${item.id} (NaN/Infinity not allowed)`,
      );
    }
    seen.add(item.id);
  }
  return dim;
}

/** Total, locale-independent ascending order on raw ids (matches semantic.ts). */
function compareIdsAsc(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
