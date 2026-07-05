// The host-side SUGGESTED-COLLECTIONS library port (M4-3c, #273 — ADR-0030) — the
// single seam the suggestions IPC handler calls into, mirroring the categorization
// library (#270). It composes the two already-merged, already-tested halves of the
// feature behind one renderer-facing projection:
//   • derivation (#271, READ-ONLY): which place/theme categories are worth
//     offering as collections, ordered count-desc / id-asc; and
//   • curation (#272, the ONLY write path): accept / merge / dismiss, each
//     idempotent per category.
// It adds only the thin glue the tray needs: a few EXAMPLE items per suggestion
// (so the card is recognisable) and the list of real collections a merge may
// target. It creates NO collections row itself — listing is pure derivation, so
// the main collections list stays byte-identical until the user explicitly acts
// (AC-32). Every mutation returns the REFRESHED view, so the acted-on suggestion
// simply drops out of the tray with no manual re-fetch (mirrors applyCorrection).

import type { CatalogDatabase } from '../db/connection';
import { createCurationRepo } from './curation-repo';
import { deriveSuggestionCandidates, type SuggestionDeriveOptions } from './suggestions-derive';
import { SUGGESTION_EXAMPLES_MAX } from '@shared/ipc/schemas';
import type {
  SuggestionDTO,
  SuggestionExampleDTO,
  SuggestionMergeTargetDTO,
  SuggestionsViewDTO,
} from '@shared/ipc/schemas';

/**
 * The suggested-collections curation port for one open library: read the pending
 * tray, then accept / merge / dismiss. Every method returns the refreshed {@link
 * SuggestionsViewDTO}. Ids are opaque catalog uuids — no path ever crosses here.
 */
export interface SuggestionsLibraryPort {
  /** The pending suggestions (with example items) + the real collections a merge may target. */
  list(): SuggestionsViewDTO;
  /** Accept a suggestion (optionally renamed) — materialises the collection; returns the refreshed tray. */
  accept(input: { categoryId: string; name?: string }): SuggestionsViewDTO;
  /** Merge a suggestion into an existing collection; returns the refreshed tray. */
  merge(input: { categoryId: string; intoCollectionId: string }): SuggestionsViewDTO;
  /** Dismiss a suggestion (durable tombstone — not re-proposed); returns the refreshed tray. */
  dismiss(input: { categoryId: string; name?: string }): SuggestionsViewDTO;
}

/** Construction options — the live catalog `db` plus optional derivation/example bounds. */
export interface CreateSuggestionsLibraryPortOptions extends SuggestionDeriveOptions {
  db: CatalogDatabase;
  /** How many example items to attach per suggestion (defaults to {@link SUGGESTION_EXAMPLES_MAX}). */
  exampleLimit?: number;
}

interface RawExampleRow {
  id: string;
  mediaType: SuggestionExampleDTO['mediaType'];
  title: string | null;
}

interface RawMergeTargetRow {
  id: string;
  name: string;
  origin: SuggestionMergeTargetDTO['origin'];
}

/** A media type renders a thumbnail iff it is visual (mirrors catalog-session's hint). */
function hasThumbnail(mediaType: SuggestionExampleDTO['mediaType']): boolean {
  return mediaType === 'photo' || mediaType === 'video';
}

export function createSuggestionsLibraryPort(
  options: CreateSuggestionsLibraryPortOptions,
): SuggestionsLibraryPort {
  const { db, exampleLimit = SUGGESTION_EXAMPLES_MAX, ...deriveOptions } = options;
  const curation = createCurationRepo(db);

  // Up to N EFFECTIVE members of a category — the SAME "user wins, tombstones
  // hidden" predicate the derivation counts and the curation copy reproduces — as
  // slim example tiles. Ordered by id so a card's examples are deterministic.
  const examplesStmt = db.prepare(`
    SELECT i.id AS id, i.media_type AS mediaType, i.title AS title
      FROM item_categories ic
      JOIN items i ON i.id = ic.item_id
     WHERE ic.category_id = @categoryId
       AND ic.state = 'assigned'
       AND (
         ic.source = 'user'
         OR NOT EXISTS (
           SELECT 1 FROM item_categories u
            WHERE u.item_id = ic.item_id
              AND u.category_id = ic.category_id
              AND u.source = 'user'
         )
       )
     ORDER BY i.id
     LIMIT @limit
  `);

  // The real, materialised collections a suggestion may merge INTO — hand-made
  // ('user') or already-accepted ('suggested'), never a 'dismissed' tombstone.
  const mergeTargetsStmt = db.prepare(`
    SELECT id, name, origin
      FROM collections
     WHERE origin IN ('user', 'suggested')
     ORDER BY name, id
  `);

  function examplesFor(categoryId: string): SuggestionExampleDTO[] {
    return examplesStmt.all<RawExampleRow>({ categoryId, limit: exampleLimit }).map((row) => ({
      id: row.id,
      mediaType: row.mediaType,
      title: row.title,
      hasThumbnail: hasThumbnail(row.mediaType),
    }));
  }

  function list(): SuggestionsViewDTO {
    const suggestions: SuggestionDTO[] = deriveSuggestionCandidates(db, deriveOptions).map(
      (candidate) => ({
        categoryId: candidate.categoryId,
        kind: candidate.kind,
        name: candidate.name,
        memberCount: candidate.memberCount,
        examples: examplesFor(candidate.categoryId),
      }),
    );
    const collections: SuggestionMergeTargetDTO[] = mergeTargetsStmt
      .all<RawMergeTargetRow>()
      .map((row) => ({ collectionId: row.id, name: row.name, origin: row.origin }));
    return { suggestions, collections };
  }

  return {
    list,
    accept(input) {
      curation.accept({ categoryId: input.categoryId, name: input.name });
      return list();
    },
    merge(input) {
      // Materialise the suggestion into its own 'suggested' collection, then fold
      // that into the chosen survivor: members move over and the source category is
      // tombstoned so it is not re-proposed (AC-32). Both steps are idempotent per
      // category, so a double-merge collapses onto the same transient collection.
      const fromCollectionId = curation.accept({ categoryId: input.categoryId });
      curation.merge({ fromCollectionId, intoCollectionId: input.intoCollectionId });
      return list();
    },
    dismiss(input) {
      curation.dismiss({ categoryId: input.categoryId, name: input.name });
      return list();
    },
  };
}
