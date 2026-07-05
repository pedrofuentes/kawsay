import type { CatalogDatabase } from '../db/connection';
import type { CategoryKind } from './categories-repo';

// Pure, READ-ONLY suggested-collection derivation (ADR-0030 Decision 5, milestone
// M4-3, card M4-3a, issue #271). It answers one question over the live catalog:
// which place/theme categories are big enough to be worth offering as a
// collection, and have NOT already been accepted or dismissed? It is the read
// half of suggested collections — the curation WRITES (accept / rename / merge /
// dismiss) are card M4-3b (#272), and the IPC/UI tray is M4-3c (#273).
//
// ── The headline invariant: it writes NOTHING ───────────────────────────────
// Suggestions are DERIVED, never pre-materialized (ADR-0030 Decision 5 / AC-32:
// "no collections row is ever created without an explicit user action"). This
// module issues a single read-only SELECT and returns candidates; it performs no
// INSERT / UPDATE / DELETE. A collections row appears only later, from an
// explicit user accept in the curation repo.
//
// ── Effective membership (the count that matters) ────────────────────────────
// A candidate's size is its count of EFFECTIVE members, defined exactly as
// `categories-repo`'s resolver: for each (item, category) the winning row is the
// USER row if one exists, else the AUTO row; the item is a member iff that
// winning row's state is 'assigned'. So a user 'removed' tombstone HIDES an auto
// membership (dropping the count), a user 'assigned' confirms it (without
// double-counting the coexisting auto row), and a user-only 'assigned' adds one.
// The SQL below reproduces the resolver's "user wins" precedence with a
// correlated NOT EXISTS (portable across SQLite versions, no window function),
// counting each item at most once per category.
//
// ── Exclusion (offered at most once) ─────────────────────────────────────────
// A category already linked from a `collections` row on `category_id` is dropped
// — whether it was ACCEPTED (origin='suggested', already a real collection) or
// DISMISSED (origin='dismissed', a durable tombstone). Hand-made user
// collections (origin='user', category_id NULL) never exclude anything. So each
// category is proposed at most once until its lifecycle state changes.
//
// ── Kind scope ───────────────────────────────────────────────────────────────
// Only 'place' and 'theme' categories are suggestible; 'person' (faces, M4-4) is
// out of scope (ADR-0030 Decision 5), regardless of member count.
//
// ── Determinism ──────────────────────────────────────────────────────────────
// The order depends only on DB state, never on row insertion order: effective
// member count DESCENDING, then category id ASCENDING. Category ids are unique,
// so the tie-break is total — the same catalog yields the identical list on
// every call (the same discipline `semantic.ts` applies to its merge).

/**
 * The default minimum EFFECTIVE-member count for a category to be offered as a
 * collection candidate (inclusive). Small enough to surface a real grouping
 * (a short trip, a handful of themed photos) yet large enough to skip trivial
 * 1–2 item noise. Callers may override it via {@link SuggestionDeriveOptions}.
 */
export const DEFAULT_MIN_MEMBERS = 3;

/** The suggestible category kinds — places and themes only ('person' is out of scope). */
export type SuggestionKind = Exclude<CategoryKind, 'person'>;

/** Options for {@link deriveSuggestionCandidates}. */
export interface SuggestionDeriveOptions {
  /**
   * Minimum EFFECTIVE-member count (inclusive) a category must reach to be a
   * candidate. Defaults to {@link DEFAULT_MIN_MEMBERS}.
   */
  readonly minMembers?: number;
}

/**
 * One derived suggestion: a place/theme category worth offering as a collection.
 * Carries the minimal, stable identity the M4-3b curation layer needs to
 * materialize it (the `categoryId`/`sourceKey` provenance link) and the M4-3c UI
 * needs to render the tray (the `name`, `kind`, and `memberCount`).
 */
export interface SuggestionCandidate {
  /** The source category's stable id (the provenance link a curation accept writes). */
  readonly categoryId: string;
  /** 'place' or 'theme' — never 'person' (out of scope). */
  readonly kind: SuggestionKind;
  /** The category's current display name (auto-derived or user-renamed). */
  readonly name: string;
  /** The stable natural key (`place:<geonameid>` / `theme:<sha256>`); null for a user category. */
  readonly sourceKey: string | null;
  /** The count of EFFECTIVE members (winning-row state === 'assigned'). */
  readonly memberCount: number;
}

interface RawCandidateRow {
  id: string;
  kind: SuggestionKind;
  name: string;
  source_key: string | null;
  effective_members: number;
}

// One read-only statement. The `effective` CTE counts, per category, the items
// whose WINNING assignment row is 'assigned' — the user row when present (the
// `source = 'user'` branch), else the auto row (the NOT EXISTS branch, taken
// only when no user row exists) — so each item is counted at most once and a
// user 'removed' tombstone (state != 'assigned') is excluded, mirroring
// `resolveAssignment`. The outer query keeps only place/theme categories that
// meet the threshold and are NOT already linked from a suggested/dismissed
// collection, ordered deterministically (count desc, id asc).
const DERIVE_SQL = `
  WITH effective AS (
    SELECT ic.category_id AS category_id, COUNT(*) AS effective_members
      FROM item_categories ic
     WHERE ic.state = 'assigned'
       AND (
         ic.source = 'user'
         OR NOT EXISTS (
           SELECT 1 FROM item_categories u
            WHERE u.item_id = ic.item_id
              AND u.category_id = ic.category_id
              AND u.source = 'user'
         )
       )
     GROUP BY ic.category_id
  )
  SELECT c.id AS id, c.kind AS kind, c.name AS name, c.source_key AS source_key,
         e.effective_members AS effective_members
    FROM effective e
    JOIN categories c ON c.id = e.category_id
   WHERE c.kind IN ('place', 'theme')
     AND e.effective_members >= @minMembers
     AND NOT EXISTS (
       SELECT 1 FROM collections col
        WHERE col.category_id = c.id
          AND col.origin IN ('suggested', 'dismissed')
     )
   ORDER BY e.effective_members DESC, c.id ASC
`;

/**
 * Derive the suggested-collection candidates from the current catalog state —
 * every place/theme category with at least `minMembers` EFFECTIVE members that
 * is not already accepted or dismissed — ordered by member count desc then id
 * asc. Pure and READ-ONLY: it never writes a row (AC-32); a suggestion becomes a
 * real collection only from an explicit user accept in the curation repo (M4-3b).
 */
export function deriveSuggestionCandidates(
  db: CatalogDatabase,
  options: SuggestionDeriveOptions = {},
): SuggestionCandidate[] {
  const minMembers = options.minMembers ?? DEFAULT_MIN_MEMBERS;
  const rows = db.prepare(DERIVE_SQL).all<RawCandidateRow>({ minMembers });
  return rows.map((row) => ({
    categoryId: row.id,
    kind: row.kind,
    name: row.name,
    sourceKey: row.source_key,
    memberCount: row.effective_members,
  }));
}
