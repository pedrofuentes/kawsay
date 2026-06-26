import { describe, expect, it } from 'vitest';
import { computeWer, normalizeForWer, tokenizeWords } from './wer';

// ── normalization (the documented, standard WER normalization) ──────────────
//
// AC-21 / ADR-0027: WER is measured on text normalized to a canonical form so
// the score reflects spoken-word errors, not punctuation/casing/Unicode noise.
// The documented normalization is: NFC-normalize → lowercase → strip everything
// that is not a Unicode letter/number/space → collapse whitespace → trim.
// Crucially it KEEPS accented letters (Spanish), ß/umlauts (German) and Cyrillic
// (Russian) — only punctuation and symbols are removed — so it is multilingual.
describe('normalizeForWer (lowercase, strip punctuation, collapse whitespace — multilingual)', () => {
  it('lowercases and strips punctuation', () => {
    expect(normalizeForWer('¡Hola, Mundo!')).toBe('hola mundo');
  });

  it('collapses runs of whitespace (incl. newlines/tabs) to single spaces and trims', () => {
    expect(normalizeForWer('  el   gato\tnegro\n duerme  ')).toBe('el gato negro duerme');
  });

  it('PRESERVES Spanish accents and ñ (does not strip diacritics)', () => {
    expect(normalizeForWer('La canción, ¿qué año?')).toBe('la canción qué año');
  });

  it('treats NFC and NFD spellings of the same accented word as equal', () => {
    // "canción" composed (U+00F3) vs decomposed (o + U+0301) must normalize equal.
    const composed = 'canción';
    const decomposed = 'cancio\u0301n';
    expect(composed).not.toBe(decomposed); // they differ byte-for-byte...
    expect(normalizeForWer(composed)).toBe(normalizeForWer(decomposed)); // ...but not after NFC.
  });

  it('PRESERVES German umlauts and ß', () => {
    expect(normalizeForWer('Das Gerücht über die Straße!')).toBe('das gerücht über die straße');
  });

  it('PRESERVES Cyrillic (Russian) letters', () => {
    expect(normalizeForWer('Привет, мир!')).toBe('привет мир');
  });

  it('keeps digits as tokens', () => {
    expect(normalizeForWer('Son las 18 horas.')).toBe('son las 18 horas');
  });

  it('reduces punctuation-only input to the empty string', () => {
    expect(normalizeForWer('¿?¡!… —,.')).toBe('');
  });
});

describe('tokenizeWords', () => {
  it('splits normalized text into word tokens', () => {
    expect(tokenizeWords('¡Hola,   mundo!')).toEqual(['hola', 'mundo']);
  });

  it('returns an empty array for empty / whitespace / punctuation-only input', () => {
    expect(tokenizeWords('')).toEqual([]);
    expect(tokenizeWords('   ')).toEqual([]);
    expect(tokenizeWords('—¿!')).toEqual([]);
  });
});

// ── word error rate (S + D + I) / N over normalized word tokens ─────────────
describe('computeWer (standard word error rate over normalized tokens)', () => {
  it('is 0 for an identical transcript', () => {
    const r = computeWer('el gato negro duerme', 'el gato negro duerme');
    expect(r.wer).toBe(0);
    expect(r.errorCount).toBe(0);
    expect(r.substitutions).toBe(0);
    expect(r.deletions).toBe(0);
    expect(r.insertions).toBe(0);
    expect(r.hits).toBe(4);
    expect(r.referenceWordCount).toBe(4);
  });

  it('ignores case and punctuation (via normalization) when scoring', () => {
    const r = computeWer('Hola, mundo.', 'hola mundo');
    expect(r.wer).toBe(0);
  });

  it('counts a single substitution', () => {
    const r = computeWer('el gato negro', 'el perro negro');
    expect(r.substitutions).toBe(1);
    expect(r.deletions).toBe(0);
    expect(r.insertions).toBe(0);
    expect(r.errorCount).toBe(1);
    expect(r.wer).toBeCloseTo(1 / 3, 10);
  });

  it('counts a single deletion (missing word in the hypothesis)', () => {
    const r = computeWer('el gato negro', 'el negro');
    expect(r.deletions).toBe(1);
    expect(r.substitutions).toBe(0);
    expect(r.insertions).toBe(0);
    expect(r.errorCount).toBe(1);
    expect(r.wer).toBeCloseTo(1 / 3, 10);
  });

  it('counts a single insertion (extra word in the hypothesis)', () => {
    const r = computeWer('el gato', 'el gato negro');
    expect(r.insertions).toBe(1);
    expect(r.substitutions).toBe(0);
    expect(r.deletions).toBe(0);
    expect(r.errorCount).toBe(1);
    expect(r.wer).toBeCloseTo(1 / 2, 10);
  });

  it('can exceed 1.0 when there are more insertions than reference words', () => {
    const r = computeWer('hola', 'hola hola hola');
    expect(r.insertions).toBe(2);
    expect(r.wer).toBe(2);
  });

  it('treats two empty strings as a perfect (0) score', () => {
    expect(computeWer('', '').wer).toBe(0);
  });

  it('scores an empty reference against a non-empty hypothesis as fully wrong (guard)', () => {
    const r = computeWer('', 'una dos');
    expect(r.referenceWordCount).toBe(0);
    expect(r.insertions).toBe(2);
    expect(r.errorCount).toBe(2);
    expect(r.wer).toBe(1);
  });
});
