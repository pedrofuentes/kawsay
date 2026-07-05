import { STOPWORDS_ALL } from './stopwords';

// Pure, dependency-free THEME-LABEL derivation (ADR-0030 Decision 3, milestone
// M4-2, card M4-2f). A theme cluster (from `themes-cluster.ts`) has no inherent
// name, so we derive a human-readable one from the most SALIENT terms across its
// members' text (`description` / `search_meta` / transcript, concatenated by the
// caller). Like `semantic.ts` / `themes-cluster.ts`, this module has NO database,
// model, or filesystem dependency: text is dependency-injected as plain arguments,
// so it is exhaustively unit-tested with synthetic fixtures and wired to real
// item text by the categorization orchestrator (a later card, #269).
//
// ── Tokenization ─────────────────────────────────────────────────────────────
// We match the FTS5 `unicode61` tokenizer (`001_initial.sql:150`) as closely as
// practical so labels are drawn from the same token space search uses: lowercase,
// fold diacritics, split on non-alphanumeric. `unicode61`'s diacritic folding is
// reproduced by Unicode NFD normalization + stripping combining marks (\p{M}) —
// verified equivalent for the ES/EN/PT Latin set (Perú→peru, café→cafe,
// cumpleaños→cumpleanos, São→sao, coração→coracao). There is no existing reusable
// JS tokenizer in the codebase (the FTS path lets SQLite fold internally), so this
// is hand-rolled, in the ADR-0014/0015 "no new NLP dependency" ethos.
//
// ── Ranking: TF-in-cluster ÷ DF-in-corpus ────────────────────────────────────
// A term's salience is its raw term frequency SUMMED across the cluster's member
// documents, divided by its document frequency across the WHOLE corpus of items
// given. A term that is frequent inside the cluster but rare across the corpus
// (distinctive) outranks one that is merely common everywhere (high DF) — the
// TF-IDF-ish distinctiveness the ADR calls for. Stopwords (a small hand-rolled
// ES/EN/PT list) are dropped before ranking.
//
// ── Determinism ──────────────────────────────────────────────────────────────
// Output depends only on the inputs, never their order (mirrors `themes-cluster`):
// terms sort by score DESCENDING with a locale-independent ascending term
// tie-break (`<`, never `localeCompare`); result labels sort by `sourceKey`
// ascending; the display surface form is the most-frequent spelling with the same
// ascending tie-break. Same input ⇒ same labels, terms, and confidence.

/** A theme cluster to label: its stable re-cluster key + its member item ids. */
export interface ThemeLabelCluster {
  /** The cluster's deterministic signature from `themeSourceKey` (`theme:<sha256>`). */
  readonly sourceKey: string;
  /** Ids of the cluster's member items (looked up in `corpus`; absent ids are skipped). */
  readonly memberIds: readonly string[];
}

/** One corpus document: an item id and its label-relevant text (may be empty). */
export interface ThemeLabelCorpusItem {
  readonly id: string;
  /** `description` / `search_meta` / transcript text, concatenated by the caller. */
  readonly text: string;
}

/** A ranked candidate term for a cluster's label. */
export interface RankedTerm {
  /** The folded (lowercased, diacritic-stripped) token — the canonical ranking unit. */
  readonly term: string;
  /**
   * A human-facing surface form: the most common ORIGINAL spelling that folds to
   * `term`, lowercased but with diacritics preserved (e.g. `perú` for token `peru`).
   */
  readonly display: string;
  /** Total occurrences of `term` summed across the cluster's member documents. */
  readonly tf: number;
  /** Number of corpus documents containing `term` at least once (document frequency). */
  readonly df: number;
  /** Distinctiveness score = `tf / df` (higher ⇒ more salient to this cluster). */
  readonly score: number;
}

/** A derived label for one theme cluster, keyed by its `sourceKey`. */
export interface ThemeLabel {
  /** The originating cluster's `sourceKey` (so the caller maps label → category). */
  readonly sourceKey: string;
  /** The top 1–3 salient terms as a display string (e.g. `Beach`, `Cusco trip`);
   *  `''` when the cluster yields no salient term. */
  readonly label: string;
  /** Every non-stopword candidate term, ranked (descending score, ascending tie-break). */
  readonly terms: readonly RankedTerm[];
  /** Label confidence — {@link THEME_LABEL_CONFIDENCE} when a label exists, else 0. */
  readonly confidence: number;
}

/** The result of a labelling pass: one label per cluster, ordered by `sourceKey`. */
export interface DeriveThemeLabelsResult {
  readonly labels: readonly ThemeLabel[];
}

/** Tunables for {@link deriveThemeLabels}; omitted fields use {@link THEME_LABEL_DEFAULTS}. */
export interface DeriveThemeLabelsOptions {
  /** How many top terms compose the label string (coerced to an integer ≥ 1). */
  readonly maxLabelTerms?: number;
}

/** Documented default: a label is the top 1–3 terms. */
export const THEME_LABEL_DEFAULTS = {
  maxLabelTerms: 3,
} as const satisfies Required<DeriveThemeLabelsOptions>;

/**
 * The fixed confidence attached to a (non-empty) text-derived theme label.
 * Deliberately LOW and strictly below a gazetteer place label: a place label is a
 * precise geographic match (nearest gazetteer point, ADR-0030 Decision 2) and so
 * warrants high confidence, whereas a theme label is a fuzzy, salient-term guess
 * the user is expected to rename (M4-2h). Kept as a single documented constant so
 * the ordering "theme < place" is explicit and easy to tune. In [0, 1] to match
 * the `item_categories.confidence` CHECK (ADR-0030 Decision 1).
 */
export const THEME_LABEL_CONFIDENCE = 0.5;

/** Matches maximal runs of Unicode letters/numbers — the `unicode61` token shape. */
const TOKEN_PATTERN = /[\p{L}\p{N}]+/gu;

/** Combining marks left behind by NFD decomposition (the diacritics to strip). */
const COMBINING_MARK_PATTERN = /\p{M}+/gu;

/**
 * Fold one raw token to its canonical form: NFD-decompose, strip combining marks
 * (diacritics), then lowercase — reproducing FTS `unicode61` folding for the Latin
 * script (`Perú` → `peru`, `Café` → `cafe`, `São` → `sao`).
 */
function foldToken(token: string): string {
  return token.normalize('NFD').replace(COMBINING_MARK_PATTERN, '').toLowerCase();
}

/**
 * Tokenize free text the way theme labelling does: split on non-alphanumeric,
 * fold each token (lowercase + diacritic strip). Numeric tokens are kept (a year
 * like `2019` can be salient); punctuation, underscores, and emoji are separators.
 * Pure and stopword-agnostic — stopword filtering happens during {@link deriveThemeLabels}.
 */
export function tokenizeThemeText(text: string): string[] {
  const matches = text.match(TOKEN_PATTERN);
  if (matches === null) return [];
  const tokens: string[] = [];
  for (const match of matches) {
    const folded = foldToken(match);
    if (folded !== '') tokens.push(folded);
  }
  return tokens;
}

/** The folded stopword lookup, normalized identically to tokens (single source of truth). */
const STOPWORD_SET: ReadonlySet<string> = new Set(STOPWORDS_ALL.map(foldToken));

/**
 * Derive a human-readable label for each theme cluster from its members' text,
 * ranking terms by TF-in-cluster ÷ DF-in-corpus (see the module header). Pure and
 * deterministic: the output depends only on the inputs, never their order. Empty
 * `clusters` degrades to an empty result. A cluster whose members contribute no
 * non-stopword term yields an empty label with confidence 0 (never a crash). A
 * member id absent from `corpus` simply contributes no text. Throws on a duplicate
 * `sourceKey` or a duplicate corpus id, since each would make the result ill-defined.
 */
export function deriveThemeLabels(
  clusters: readonly ThemeLabelCluster[],
  corpus: readonly ThemeLabelCorpusItem[],
  options: DeriveThemeLabelsOptions = {},
): DeriveThemeLabelsResult {
  const rawMax = options.maxLabelTerms ?? THEME_LABEL_DEFAULTS.maxLabelTerms;
  const maxLabelTerms = Math.max(
    1,
    Math.trunc(Number.isFinite(rawMax) ? rawMax : THEME_LABEL_DEFAULTS.maxLabelTerms),
  );

  // ── Index the corpus once: per-doc term counts, corpus DF, surface spellings ──
  const docTermCounts = new Map<string, Map<string, number>>();
  const documentFrequency = new Map<string, number>();
  const surfaceForms = new Map<string, Map<string, number>>();
  const seenDocIds = new Set<string>();

  for (const item of corpus) {
    if (seenDocIds.has(item.id)) {
      throw new Error(`deriveThemeLabels: duplicate corpus id ${item.id} (ids must be unique)`);
    }
    seenDocIds.add(item.id);

    const counts = new Map<string, number>();
    const matches = (item.text ?? '').match(TOKEN_PATTERN);
    if (matches !== null) {
      for (const surface of matches) {
        const term = foldToken(surface);
        if (term === '' || STOPWORD_SET.has(term)) continue;
        counts.set(term, (counts.get(term) ?? 0) + 1);
        recordSurfaceForm(surfaceForms, term, surface.toLowerCase());
      }
    }
    docTermCounts.set(item.id, counts);
    for (const term of counts.keys()) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }

  // ── Rank each cluster's terms and build its label ─────────────────────────────
  const labels: ThemeLabel[] = [];
  const seenSourceKeys = new Set<string>();

  for (const cluster of clusters) {
    if (seenSourceKeys.has(cluster.sourceKey)) {
      throw new Error(
        `deriveThemeLabels: duplicate sourceKey ${cluster.sourceKey} (clusters must be unique)`,
      );
    }
    seenSourceKeys.add(cluster.sourceKey);

    const clusterTf = new Map<string, number>();
    for (const memberId of cluster.memberIds) {
      const counts = docTermCounts.get(memberId);
      if (counts === undefined) continue; // member has no text in the corpus
      for (const [term, count] of counts) {
        clusterTf.set(term, (clusterTf.get(term) ?? 0) + count);
      }
    }

    const terms: RankedTerm[] = [];
    for (const [term, tf] of clusterTf) {
      const df = documentFrequency.get(term) ?? 0;
      terms.push({
        term,
        display: representativeSurfaceForm(surfaceForms, term),
        tf,
        df,
        score: df === 0 ? 0 : tf / df,
      });
    }
    terms.sort((left, right) => right.score - left.score || compareAsc(left.term, right.term));

    const label = buildLabel(terms.slice(0, maxLabelTerms));
    labels.push({
      sourceKey: cluster.sourceKey,
      label,
      terms,
      confidence: label === '' ? 0 : THEME_LABEL_CONFIDENCE,
    });
  }

  labels.sort((left, right) => compareAsc(left.sourceKey, right.sourceKey));
  return { labels };
}

// ── Internals ──────────────────────────────────────────────────────────────────

/** Tally one lowercased surface spelling under its folded term. */
function recordSurfaceForm(
  surfaceForms: Map<string, Map<string, number>>,
  term: string,
  surface: string,
): void {
  let spellings = surfaceForms.get(term);
  if (spellings === undefined) {
    spellings = new Map();
    surfaceForms.set(term, spellings);
  }
  spellings.set(surface, (spellings.get(surface) ?? 0) + 1);
}

/**
 * The representative display spelling for a folded term: the most frequent surface
 * form, with a locale-independent ascending tie-break. Falls back to the folded
 * term when no surface was recorded (defensive — a scored term always has one).
 */
function representativeSurfaceForm(
  surfaceForms: Map<string, Map<string, number>>,
  term: string,
): string {
  const spellings = surfaceForms.get(term);
  if (spellings === undefined) return term;
  let best: string | null = null;
  let bestCount = -1;
  for (const [surface, count] of spellings) {
    if (
      best === null ||
      count > bestCount ||
      (count === bestCount && compareAsc(surface, best) < 0)
    ) {
      best = surface;
      bestCount = count;
    }
  }
  return best ?? term;
}

/**
 * Join the top terms' display forms with spaces and capitalize the first character
 * only (e.g. `Beach`, `Cusco trip`, `Perú`). Empty term list ⇒ empty label.
 */
function buildLabel(topTerms: readonly RankedTerm[]): string {
  if (topTerms.length === 0) return '';
  const body = topTerms.map((term) => term.display).join(' ');
  if (body === '') return '';
  return body.charAt(0).toUpperCase() + body.slice(1);
}

/** Total, locale-independent ascending order on raw strings (matches themes-cluster). */
function compareAsc(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
