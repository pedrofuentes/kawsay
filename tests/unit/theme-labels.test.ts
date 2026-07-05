import { describe, expect, it } from 'vitest';
import {
  deriveThemeLabels,
  tokenizeThemeText,
  THEME_LABEL_CONFIDENCE,
  type ThemeLabelCluster,
  type ThemeLabelCorpusItem,
  type DeriveThemeLabelsResult,
} from '../../electron/main/categorize/theme-labels';

// Test ergonomics (mirrors themes-cluster.test.ts builders).
const cluster = (sourceKey: string, memberIds: string[]): ThemeLabelCluster => ({
  sourceKey,
  memberIds,
});
const doc = (id: string, text: string): ThemeLabelCorpusItem => ({ id, text });
const termNames = (result: DeriveThemeLabelsResult, index = 0): string[] =>
  result.labels[index].terms.map((term) => term.term);

describe('tokenizeThemeText — unicode61-compatible fold + split (ADR-0030 Decision 3)', () => {
  it('lowercases, folds diacritics, and splits on non-alphanumeric', () => {
    expect(tokenizeThemeText('Hello, WORLD! Niña — café 123')).toEqual([
      'hello',
      'world',
      'nina',
      'cafe',
      '123',
    ]);
  });

  it('drops punctuation, underscores, and emoji; returns [] for blank input', () => {
    expect(tokenizeThemeText('a_b.c!! 🎉')).toEqual(['a', 'b', 'c']);
    expect(tokenizeThemeText('')).toEqual([]);
    expect(tokenizeThemeText('   \n\t ')).toEqual([]);
  });

  it('folds Spanish/Portuguese diacritics exactly as FTS unicode61 does', () => {
    expect(tokenizeThemeText('São Paulo coração cumpleaños Perú')).toEqual([
      'sao',
      'paulo',
      'coracao',
      'cumpleanos',
      'peru',
    ]);
  });
});

describe('deriveThemeLabels — TF-in-cluster ÷ DF-in-corpus labelling (ADR-0030 Decision 3)', () => {
  it('returns no labels for empty clusters (graceful degrade, never crashes)', () => {
    expect(deriveThemeLabels([], [])).toEqual({ labels: [] });
    expect(deriveThemeLabels([], [doc('x', 'hello world')])).toEqual({ labels: [] });
  });

  it('derives a salient label from a cluster’s most distinctive terms', () => {
    const corpus = [
      doc('c1', 'beach beach sea the and'),
      doc('c2', 'beach sea the of'),
      doc('c3', 'beach the a'),
      doc('o1', 'birthday party the'),
      doc('o2', 'work the and'),
    ];
    const result = deriveThemeLabels([cluster('theme:beach', ['c1', 'c2', 'c3'])], corpus);

    expect(result.labels).toHaveLength(1);
    const label = result.labels[0];
    expect(label.sourceKey).toBe('theme:beach');
    expect(label.label).toBe('Beach sea');
    expect(label.confidence).toBe(THEME_LABEL_CONFIDENCE);
    expect(label.terms.map((t) => t.term)).toEqual(['beach', 'sea']);
    // beach: tf 2+1+1 = 4 across 3 member docs; df = 3 (only the cluster docs).
    expect(label.terms[0]).toMatchObject({ term: 'beach', tf: 4, df: 3 });
    expect(label.terms[0].score).toBeCloseTo(4 / 3, 10);
    // sea: tf 1+1 = 2; df = 2 (c1, c2).
    expect(label.terms[1]).toMatchObject({ term: 'sea', tf: 2, df: 2 });
    expect(label.terms[1].score).toBeCloseTo(1, 10);
  });

  it('penalizes corpus-common terms through DF (TF-IDF-ish distinctiveness)', () => {
    const corpus = [
      doc('c1', 'gamma gamma gamma alpha'),
      doc('o1', 'gamma'),
      doc('o2', 'gamma'),
      doc('o3', 'gamma'),
      doc('o4', 'gamma'),
      doc('o5', 'gamma'),
    ];
    const result = deriveThemeLabels([cluster('theme:g', ['c1'])], corpus);
    const label = result.labels[0];

    // alpha (tf 1 / df 1 = 1.0) outranks gamma (tf 3 / df 6 = 0.5) despite lower TF.
    expect(label.terms.map((t) => t.term)).toEqual(['alpha', 'gamma']);
    expect(label.terms[0]).toMatchObject({ term: 'alpha', tf: 1, df: 1 });
    // DF is a document count: gamma is in 6 docs (3 hits in c1 count as ONE doc).
    expect(label.terms[1]).toMatchObject({ term: 'gamma', tf: 3, df: 6 });
    expect(label.terms[1].score).toBeCloseTo(0.5, 10);
    expect(label.label).toBe('Alpha gamma');
  });

  it('breaks score ties alphabetically (deterministic, locale-independent)', () => {
    const result = deriveThemeLabels([cluster('theme:t', ['c1'])], [doc('c1', 'lambda kappa')]);
    // Equal score (tf 1 / df 1) → ascending term order: kappa before lambda.
    expect(termNames(result)).toEqual(['kappa', 'lambda']);
    expect(result.labels[0].label).toBe('Kappa lambda');
  });

  it('is deterministic regardless of corpus/cluster input order', () => {
    const corpus = [
      doc('c1', 'beach beach sea'),
      doc('c2', 'beach sea'),
      doc('d1', 'mountain mountain trail'),
      doc('d2', 'mountain trail'),
      doc('o1', 'random note'),
    ];
    const clusters = [
      cluster('theme:zeta', ['d1', 'd2']),
      cluster('theme:alpha', ['c1', 'c2']),
    ];
    const shuffledCorpus = [corpus[4], corpus[2], corpus[0], corpus[3], corpus[1]];
    const shuffledClusters = [clusters[1], clusters[0]];

    const run1 = deriveThemeLabels(clusters, corpus);
    const run2 = deriveThemeLabels(clusters, corpus);
    const run3 = deriveThemeLabels(shuffledClusters, shuffledCorpus);

    expect(run2).toEqual(run1);
    expect(run3).toEqual(run1);
    // Result labels are ordered by sourceKey ascending, independent of input order.
    expect(run1.labels.map((l) => l.sourceKey)).toEqual(['theme:alpha', 'theme:zeta']);
  });

  it('keys each label to its cluster sourceKey (map-friendly output)', () => {
    const corpus = [doc('c1', 'beach beach'), doc('d1', 'mountain mountain')];
    const result = deriveThemeLabels(
      [cluster('theme:mountain', ['d1']), cluster('theme:beach', ['c1'])],
      corpus,
    );
    const byKey = new Map(result.labels.map((l) => [l.sourceKey, l]));
    expect(byKey.get('theme:beach')?.label).toBe('Beach');
    expect(byKey.get('theme:mountain')?.label).toBe('Mountain');
  });

  it('honours maxLabelTerms (top-1 label but full ranked term list retained)', () => {
    const corpus = [
      doc('c1', 'beach beach sea the and'),
      doc('c2', 'beach sea the of'),
      doc('c3', 'beach the a'),
    ];
    const result = deriveThemeLabels([cluster('theme:beach', ['c1', 'c2', 'c3'])], corpus, {
      maxLabelTerms: 1,
    });
    expect(result.labels[0].label).toBe('Beach');
    expect(termNames(result)).toEqual(['beach', 'sea']);
  });

  it('marks text-derived labels with a low, sub-gazetteer confidence; empty when none', () => {
    // The label is a weak suggestion (user renames in M4-2h): strictly below a
    // precise gazetteer place label, which is a high-confidence geographic match.
    expect(THEME_LABEL_CONFIDENCE).toBeGreaterThan(0);
    expect(THEME_LABEL_CONFIDENCE).toBeLessThan(1);

    const corpus = [doc('c1', 'the and of a'), doc('c2', '   '), doc('c3', '🎉 !!! ---')];
    const result = deriveThemeLabels([cluster('theme:empty', ['c1', 'c2', 'c3'])], corpus);
    expect(result.labels[0].label).toBe('');
    expect(result.labels[0].terms).toEqual([]);
    expect(result.labels[0].confidence).toBe(0);
  });

  it('excludes English stopwords', () => {
    const corpus = [doc('c1', 'the beach and the sea'), doc('c2', 'a beach with the sea')];
    const result = deriveThemeLabels([cluster('theme:en', ['c1', 'c2'])], corpus);
    const terms = termNames(result);
    expect(terms).toContain('beach');
    expect(terms).toContain('sea');
    for (const stop of ['the', 'and', 'a', 'with']) {
      expect(terms).not.toContain(stop);
    }
  });

  it('excludes Spanish stopwords and labels the salient term', () => {
    const corpus = [
      doc('c1', 'la playa y el mar'),
      doc('c2', 'playa playa'),
      doc('c3', 'la playa con arena'),
      doc('o1', 'el mar'),
      doc('o2', 'la arena'),
      doc('o3', 'el mar'),
      doc('o4', 'la arena'),
    ];
    const result = deriveThemeLabels([cluster('theme:es', ['c1', 'c2', 'c3'])], corpus);
    const terms = termNames(result);
    expect(terms[0]).toBe('playa'); // distinctive: high TF, low corpus DF
    expect(result.labels[0].label).toBe('Playa arena mar');
    for (const stop of ['la', 'el', 'y', 'con']) {
      expect(terms).not.toContain(stop);
    }
  });

  it('excludes Portuguese stopwords (incl. diacritic “não”) and labels the salient term', () => {
    const corpus = [
      doc('c1', 'a praia e o mar não'),
      doc('c2', 'praia praia'),
      doc('c3', 'a praia com areia'),
      doc('o1', 'o mar'),
      doc('o2', 'a areia'),
      doc('o3', 'o mar'),
      doc('o4', 'a areia'),
    ];
    const result = deriveThemeLabels([cluster('theme:pt', ['c1', 'c2', 'c3'])], corpus);
    const terms = termNames(result);
    expect(terms[0]).toBe('praia');
    expect(result.labels[0].label).toBe('Praia areia mar');
    for (const stop of ['a', 'e', 'o', 'com', 'nao', 'não']) {
      expect(terms).not.toContain(stop);
    }
  });

  it('folds diacritics when counting yet preserves them in the display label', () => {
    const corpus = [doc('c1', 'Perú Perú'), doc('c2', 'peru')];
    const result = deriveThemeLabels([cluster('theme:peru', ['c1', 'c2'])], corpus);
    const label = result.labels[0];
    // Folded token merges the three surface spellings; TF = 3 over df = 2.
    expect(label.terms[0]).toMatchObject({ term: 'peru', display: 'perú', tf: 3, df: 2 });
    // Display restores the most common diacritic spelling; only the head is capitalized.
    expect(label.label).toBe('Perú');
  });

  it('does not throw when a cluster member is missing from the corpus', () => {
    const corpus = [doc('c1', 'beach beach sea')];
    const result = deriveThemeLabels([cluster('theme:beach', ['c1', 'ghost'])], corpus);
    expect(result.labels[0].label).toBe('Beach sea');
  });

  it('throws on a duplicate cluster sourceKey (ill-defined result)', () => {
    expect(() =>
      deriveThemeLabels(
        [cluster('theme:x', ['c1']), cluster('theme:x', ['c2'])],
        [doc('c1', 'alpha'), doc('c2', 'beta')],
      ),
    ).toThrow(/duplicate sourceKey/i);
  });

  it('throws on a duplicate corpus id (double-counted DF)', () => {
    expect(() =>
      deriveThemeLabels([cluster('theme:x', ['c1'])], [doc('c1', 'alpha'), doc('c1', 'beta')]),
    ).toThrow(/duplicate corpus id/i);
  });
});
