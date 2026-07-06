// Schema bounds for the SUGGESTED-COLLECTIONS review-tray response (#351 #4). The
// per-element bounds are already enforced (name .max(200), examples .max(4), …);
// this pins the DEFENCE-IN-DEPTH ceiling on the two TOP-LEVEL arrays, so a corrupt
// or adversarial `suggestions:*` response can never be unbounded — consistent with
// the sibling `transcriptViewSchema.segments` cap. The arrays derive from a
// deterministic local SELECT, so the ceiling is generous: it never rejects a real
// library, only a pathological one.
import { describe, expect, it } from 'vitest';
import { suggestionsViewSchema, SUGGESTIONS_VIEW_MAX } from '@shared/ipc/schemas';

const MERGE_TARGET = {
  collectionId: '30000000-0000-4000-8000-000000000001',
  name: 'Our trips',
  origin: 'user' as const,
};

const SUGGESTION = {
  categoryId: '20000000-0000-4000-8000-000000000001',
  kind: 'place' as const,
  name: 'Cusco, Perú',
  memberCount: 5,
  examples: [],
};

describe('suggestionsViewSchema — top-level array bounds (#351 #4)', () => {
  it('accepts an empty tray and a small, realistic tray', () => {
    expect(suggestionsViewSchema.safeParse({ suggestions: [], collections: [] }).success).toBe(
      true,
    );
    expect(
      suggestionsViewSchema.safeParse({
        suggestions: [SUGGESTION],
        collections: [MERGE_TARGET],
      }).success,
    ).toBe(true);
  });

  it('exposes a generous ceiling far above any realistic local library', () => {
    expect(SUGGESTIONS_VIEW_MAX).toBeGreaterThanOrEqual(10_000);
  });

  it('rejects a suggestions array longer than the ceiling', () => {
    const overLimit = {
      suggestions: Array.from({ length: SUGGESTIONS_VIEW_MAX + 1 }, () => SUGGESTION),
      collections: [],
    };
    expect(suggestionsViewSchema.safeParse(overLimit).success).toBe(false);
  });

  it('rejects a collections array longer than the ceiling', () => {
    const overLimit = {
      suggestions: [],
      collections: Array.from({ length: SUGGESTIONS_VIEW_MAX + 1 }, () => MERGE_TARGET),
    };
    expect(suggestionsViewSchema.safeParse(overLimit).success).toBe(false);
  });
});
