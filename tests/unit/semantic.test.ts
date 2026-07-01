import { describe, expect, it } from 'vitest';
import {
  cosineSimilarity,
  mergeSemanticAndExact,
  type MergedResult,
  type SemanticHit,
} from '../../electron/main/search/semantic';

// Build a float32 vector from plain numbers (test ergonomics).
const vec = (...values: number[]): Float32Array => Float32Array.from(values);

describe('cosineSimilarity (magnitude-normalized, dimension-checked — ADR-0029)', () => {
  it('is ~1 for identical vectors', () => {
    expect(cosineSimilarity(vec(1, 2, 3), vec(1, 2, 3))).toBeCloseTo(1, 6);
  });

  it('is scale-invariant: a vector and its positive multiple are ~1', () => {
    expect(cosineSimilarity(vec(1, 2, 3), vec(2, 4, 6))).toBeCloseTo(1, 6);
  });

  it('is ~0 for orthogonal vectors', () => {
    expect(cosineSimilarity(vec(1, 0), vec(0, 1))).toBeCloseTo(0, 6);
  });

  it('is ~-1 for opposite vectors', () => {
    expect(cosineSimilarity(vec(1, 2, 3), vec(-1, -2, -3))).toBeCloseTo(-1, 6);
  });

  it('returns 0 (never NaN) when either vector has zero magnitude', () => {
    expect(cosineSimilarity(vec(0, 0, 0), vec(1, 2, 3))).toBe(0);
    expect(cosineSimilarity(vec(1, 2, 3), vec(0, 0, 0))).toBe(0);
    expect(cosineSimilarity(vec(0, 0), vec(0, 0))).toBe(0);
  });

  it('throws on a dimension mismatch (vectors from different models are not comparable)', () => {
    expect(() => cosineSimilarity(vec(1, 2, 3), vec(1, 2))).toThrow();
  });
});

interface StubItem {
  readonly id: string;
  readonly label: string;
}
const item = (id: string): StubItem => ({ id, label: `label-${id}` });
const hit = (value: StubItem, score: number): SemanticHit<StubItem> => ({ item: value, score });
const ids = (merged: readonly MergedResult<StubItem>[]): string[] => merged.map((m) => m.item.id);

describe('mergeSemanticAndExact (AC-29 — extends exact search, never regresses it)', () => {
  it('AC-29: preserves every exact result, in exact order, ahead of semantic-only items', () => {
    const merged = mergeSemanticAndExact([item('e1'), item('e2')], [hit(item('s1'), 0.9)]);
    expect(ids(merged)).toEqual(['e1', 'e2', 's1']);
    expect(merged.map((m) => m.origin)).toEqual(['exact', 'exact', 'semantic']);
  });

  it('AC-29: an exact result is never demoted below a higher-scoring semantic-only item', () => {
    // s1 has a near-perfect score, but the exact match e1 must still rank first.
    const merged = mergeSemanticAndExact([item('e1')], [hit(item('s1'), 0.99)]);
    expect(ids(merged)).toEqual(['e1', 's1']);
  });

  it('lists an item present in BOTH exactly once, at its exact position, tagged both + score', () => {
    const shared = item('shared');
    const merged = mergeSemanticAndExact(
      [shared, item('e2')],
      [hit(shared, 0.8), hit(item('s1'), 0.7)],
    );
    expect(ids(merged)).toEqual(['shared', 'e2', 's1']);
    expect(merged.filter((m) => m.item.id === 'shared')).toHaveLength(1);
    const sharedResult = merged.find((m) => m.item.id === 'shared');
    expect(sharedResult?.origin).toBe('both');
    expect(sharedResult?.score).toBeCloseTo(0.8);
    // exact-only results carry no semantic score.
    expect(merged.find((m) => m.item.id === 'e2')?.score).toBeNull();
  });

  it('orders semantic-only items by similarity desc, deterministically (id asc on ties)', () => {
    const merged = mergeSemanticAndExact(
      [],
      [hit(item('b'), 0.5), hit(item('a'), 0.9), hit(item('c'), 0.5)],
    );
    expect(ids(merged)).toEqual(['a', 'b', 'c']);
    expect(merged.every((m) => m.origin === 'semantic')).toBe(true);
  });

  it('is deterministic regardless of the semantic input order', () => {
    const a = hit(item('a'), 0.9);
    const b = hit(item('b'), 0.5);
    const c = hit(item('c'), 0.5);
    expect(ids(mergeSemanticAndExact([], [a, b, c]))).toEqual(
      ids(mergeSemanticAndExact([], [c, b, a])),
    );
  });

  it('AC-29: caps the total with `limit` but NEVER drops an exact result', () => {
    const exact = [item('e1'), item('e2'), item('e3')];
    const semantic = [hit(item('s1'), 0.9), hit(item('s2'), 0.8)];
    // A limit smaller than the exact count still returns every exact result.
    expect(ids(mergeSemanticAndExact(exact, semantic, { limit: 2 }))).toEqual(['e1', 'e2', 'e3']);
  });

  it('fills the remaining slots up to `limit` with the top semantic-only items', () => {
    const exact = [item('e1')];
    const semantic = [hit(item('s1'), 0.9), hit(item('s2'), 0.8), hit(item('s3'), 0.7)];
    expect(ids(mergeSemanticAndExact(exact, semantic, { limit: 3 }))).toEqual(['e1', 's1', 's2']);
  });

  it('drops semantic-only items below `minScore`, but keeps exact results regardless', () => {
    const merged = mergeSemanticAndExact(
      [item('e1')],
      [hit(item('s1'), 0.9), hit(item('s2'), 0.2)],
      { minScore: 0.5 },
    );
    expect(ids(merged)).toEqual(['e1', 's1']);
  });

  it('keeps an exact/both item even when its semantic score is below minScore', () => {
    const shared = item('shared');
    const merged = mergeSemanticAndExact([shared], [hit(shared, 0.1)], { minScore: 0.5 });
    expect(ids(merged)).toEqual(['shared']);
    expect(merged[0]?.origin).toBe('both');
  });

  it('handles empty inputs', () => {
    expect(mergeSemanticAndExact<StubItem>([], [])).toEqual([]);
    expect(mergeSemanticAndExact([item('e1')], [])).toEqual([
      { item: item('e1'), origin: 'exact', score: null },
    ]);
  });

  it('de-duplicates repeated semantic hits for the same id (keeps the max score)', () => {
    const merged = mergeSemanticAndExact([], [hit(item('a'), 0.3), hit(item('a'), 0.8)]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.score).toBeCloseTo(0.8);
  });
});
