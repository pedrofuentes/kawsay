-- 004: composite index for the semanticSearch (model_id, dim) predicate scan (#215).
-- Forward-only, idempotent. The brute-force cosine scan filters on (model_id, dim);
-- only idx_item_embeddings_item(item_id) existed, so this index filters other
-- models/dims out of the scan.
CREATE INDEX IF NOT EXISTS idx_item_embeddings_model_dim
  ON item_embeddings (model_id, dim);
