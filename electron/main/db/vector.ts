// Pure, dependency-free vector-math primitives (ADR-0029 Decision 1). This is a
// NEUTRAL lower-layer module: it has NO database, model, or search dependency —
// just float32 vector arithmetic — so the db layer (the brute-force cosine scan
// in embeddings-repo) can depend on it WITHOUT reaching UP into ../search, and
// ../search/semantic re-exports it for the ranking layer. It is exhaustively
// unit-tested with synthetic vectors (see tests/unit/semantic.test.ts).

/**
 * Cosine similarity of two equal-length float32 vectors, in [-1, 1] (higher =
 * more similar). Magnitude-normalized, so it is invariant to vector scale.
 * Returns 0 (never NaN) when either vector has zero magnitude, and throws on a
 * dimension mismatch — comparing vectors of different dims (i.e. from different
 * models) is a programming error, not a 0-similarity result.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`cosineSimilarity: dimension mismatch (${a.length} vs ${b.length})`);
  }
  let dot = 0;
  let magASquared = 0;
  let magBSquared = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i];
    const y = b[i];
    dot += x * y;
    magASquared += x * x;
    magBSquared += y * y;
  }
  if (magASquared === 0 || magBSquared === 0) return 0;
  return dot / Math.sqrt(magASquared * magBSquared);
}
