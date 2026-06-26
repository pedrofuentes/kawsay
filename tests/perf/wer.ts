// Word Error Rate (WER) — the pure, CI-runnable core of the M2 offline accuracy
// harness (ADR-0027, PRD AC-21). This module computes a STANDARD word error rate
// over normalized word tokens; it touches no binary, model or filesystem, so it
// runs in normal CI while the heavy whisper measurement stays self-gated.
//
// Normalization (documented, and quoted verbatim in the fixtures NOTICES + the
// results doc so the metric is reproducible): NFC-normalize → lowercase → replace
// every run of non-(letter|number|space) characters with a single space → collapse
// whitespace → trim. It is deliberately MULTILINGUAL: `\p{L}` keeps Spanish
// accents (canción), German umlauts/ß (Gerücht, Straße) and Russian Cyrillic
// (Привет), removing ONLY punctuation/symbols. This mirrors a "basic"/Whisper-style
// text normalizer and is intentionally simple (no number-word expansion, no
// stemming) so the score reflects spoken-word substitutions/deletions/insertions.

/** The breakdown of a single WER computation (jiwer-style). */
export interface WerResult {
  /** Number of words in the (normalized) reference — the WER denominator. */
  readonly referenceWordCount: number;
  /** Reference words matched exactly in the aligned hypothesis. */
  readonly hits: number;
  /** Words present in both but different (one-for-one swaps). */
  readonly substitutions: number;
  /** Reference words missing from the hypothesis. */
  readonly deletions: number;
  /** Extra hypothesis words absent from the reference. */
  readonly insertions: number;
  /** `substitutions + deletions + insertions` — the edit distance. */
  readonly errorCount: number;
  /** `errorCount / referenceWordCount` (can exceed 1; see the empty-ref guard). */
  readonly wer: number;
}

/**
 * Normalize text for WER: NFC → lowercase → strip punctuation/symbols (keeping
 * letters of ANY script + digits) → collapse whitespace → trim. See the module
 * header for the rationale; this is the single, documented normalization the whole
 * harness (and the locked AC-21 threshold) is measured against.
 */
export function normalizeForWer(text: string): string {
  return text
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Normalize then split into word tokens (empty input → no tokens). */
export function tokenizeWords(text: string): string[] {
  const normalized = normalizeForWer(text);
  return normalized.length === 0 ? [] : normalized.split(' ');
}

/**
 * Compute the standard word error rate `(S + D + I) / N` between a reference
 * (ground-truth label) and a hypothesis (the model transcript), with the full
 * substitution/deletion/insertion breakdown from a Levenshtein alignment over the
 * normalized word tokens.
 *
 * Edge cases (documented + tested): two empty strings score 0; an empty reference
 * against a non-empty hypothesis is a degenerate guard that reports every
 * hypothesis word as an insertion and a WER of 1 (avoids divide-by-zero); a WER
 * above 1 is legitimate (more insertions than reference words).
 */
export function computeWer(reference: string, hypothesis: string): WerResult {
  const ref = tokenizeWords(reference);
  const hyp = tokenizeWords(hypothesis);
  const n = ref.length;
  const m = hyp.length;

  if (n === 0) {
    return {
      referenceWordCount: 0,
      hits: 0,
      substitutions: 0,
      deletions: 0,
      insertions: m,
      errorCount: m,
      wer: m > 0 ? 1 : 0,
    };
  }

  // dp[i][j] = edit distance between ref[0..i) and hyp[0..j).
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = 0; i <= n; i++) dp[i][0] = i; // i deletions
  for (let j = 0; j <= m; j++) dp[0][j] = j; // j insertions
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const substitutionCost = ref[i - 1] === hyp[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j - 1] + substitutionCost, // match / substitution (diagonal)
        dp[i - 1][j] + 1, // deletion (a reference word with no hypothesis match)
        dp[i][j - 1] + 1, // insertion (an extra hypothesis word)
      );
    }
  }

  // Backtrace from (n, m) to (0, 0), preferring diagonal then deletion then
  // insertion, to count hits / substitutions / deletions / insertions.
  let i = n;
  let j = m;
  let hits = 0;
  let substitutions = 0;
  let deletions = 0;
  let insertions = 0;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && ref[i - 1] === hyp[j - 1] && dp[i][j] === dp[i - 1][j - 1]) {
      hits++;
      i--;
      j--;
    } else if (i > 0 && j > 0 && dp[i][j] === dp[i - 1][j - 1] + 1) {
      substitutions++;
      i--;
      j--;
    } else if (i > 0 && dp[i][j] === dp[i - 1][j] + 1) {
      deletions++;
      i--;
    } else {
      insertions++;
      j--;
    }
  }

  const errorCount = substitutions + deletions + insertions;
  return {
    referenceWordCount: n,
    hits,
    substitutions,
    deletions,
    insertions,
    errorCount,
    wer: errorCount / n,
  };
}
