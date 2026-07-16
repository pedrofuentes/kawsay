// Renderer-facing DTO schemas for the IPC surface (ARCHITECTURE §2.3, §2.6).
//
// These are deliberately a MINIMAL, sanitised projection of the internal
// domain types: no filesystem paths, no Node handles, no SQLite cursors — only
// plain JSON the renderer needs to paint the timeline. Every schema is a
// `strictObject` so an unknown key is a hard validation error in either
// direction, and bounded (`.max(...)`) so an adversarial payload cannot smuggle
// an unbounded string across the trust boundary.

import { z } from 'zod';
import { MEDIA_TYPES, SOURCE_TYPES } from '@shared/catalog';

/** Upper bounds shared by request schemas (defence-in-depth, not UX limits). */
export const PATH_MAX_LENGTH = 4096;
export const NAME_MAX_LENGTH = 200;
export const QUERY_MAX_LENGTH = 512;
export const CURSOR_MAX_LENGTH = 4096;
export const PAGE_LIMIT_MAX = 200;
export const ITEM_CARD_TITLE_MAX_LENGTH = 200;
export const ITEM_CARD_DESCRIPTION_MAX_LENGTH = 4096;

/**
 * Transcript bounds (#164, defence-in-depth — NOT a UX limit). A real recording's
 * words are legitimately large, but the read path must still refuse an adversarial
 * or corrupt payload: `TEXT_MAX_LENGTH` (8 MiB of chars ≈ many hours of dense
 * speech) caps the full text and any one segment's text, and `SEGMENTS_MAX` caps
 * the segment array (whisper emits a segment every few seconds, so 200k spans
 * tens of hours). Both leave generous headroom over any genuine transcript.
 */
export const TRANSCRIPT_TEXT_MAX_LENGTH = 8 * 1024 * 1024;
export const TRANSCRIPT_SEGMENTS_MAX = 200_000;

/**
 * Thumbnail bounds (U4). The renderer may only ask for a square edge within
 * `[MIN, MAX]` px; the main process clamps anything else. `MAX_BYTES` caps a
 * single rendition so an adversarial original can't balloon the response, and
 * `DATA_URL_MAX_LENGTH` bounds the base64 data: URL that carries it (a 512 KiB
 * image is ~699 KB of base64, so 1 MiB leaves headroom while still rejecting a
 * multi-megabyte payload outright). These are defence-in-depth caps, not UX knobs.
 */
export const THUMBNAIL_MIN_SIZE = 16;
export const THUMBNAIL_MAX_SIZE = 320;
export const THUMBNAIL_MAX_BYTES = 512 * 1024;
export const THUMBNAIL_DATA_URL_MAX_LENGTH = 1024 * 1024;

function isAbsoluteLocalPath(value: string): boolean {
  if (value.startsWith('\\\\')) {
    return false;
  }

  return value.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(value);
}

/** A non-empty, bounded absolute path supplied by the renderer. */
export const pathSchema = z.string().min(1).max(PATH_MAX_LENGTH).refine(isAbsoluteLocalPath);

/**
 * A bounded image `data:` URL (the entire thumbnail payload), or null when no
 * rendition exists. Only the three raster MIME types the main-side thumbnailers
 * emit are allowed and the body must be canonical base64 — so a `data:text/html`
 * smuggling attempt, a remote URL, or a filesystem path is rejected outright,
 * and no path or remote origin can ever ride back to the renderer (AC-4).
 */
export const thumbnailDataUrlSchema = z
  .string()
  .regex(/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/u)
  .max(THUMBNAIL_DATA_URL_MAX_LENGTH)
  .nullable();
export type ThumbnailDataUrl = z.infer<typeof thumbnailDataUrlSchema>;

export const sourceTypeSchema = z.enum(SOURCE_TYPES);
export const mediaTypeSchema = z.enum(MEDIA_TYPES);

/** How many media types exist — the upper bound on a search's any-of type filter. */
export const MEDIA_TYPE_COUNT = MEDIA_TYPES.length;

/**
 * A calendar day `YYYY-MM-DD`, the shape the Search date pickers emit and the catalog
 * compares capture dates against (#431). A strict format (a bounded, digits-only
 * pattern) so a free-form or adversarial string is refused at the trust boundary
 * rather than reaching a SQL comparison.
 */
export const searchDaySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);

/**
 * The library descriptor the renderer is allowed to see. NOTE the deliberate
 * absence of `catalogPath`: the on-disk SQLite location is an internal detail
 * and must never leak to the sandboxed renderer.
 */
export const librarySummarySchema = z.strictObject({
  root: z.string().min(1),
  name: z.string().min(1).max(NAME_MAX_LENGTH),
  createdAt: z.string().min(1),
  schemaVersion: z.number().int().nonnegative(),
});
export type LibrarySummaryDTO = z.infer<typeof librarySummarySchema>;

/**
 * A single timeline tile — a renderer-safe subset of the internal `ItemRow`
 * with every filesystem/content-addressing field (contentHash, originalExt,
 * fileSizeBytes, thumbStatus, …) stripped.
 */
export const itemCardSchema = z.strictObject({
  id: z.uuid(),
  mediaType: mediaTypeSchema,
  mimeType: z.string().max(NAME_MAX_LENGTH).nullable(),
  captureDate: z.string().max(NAME_MAX_LENGTH).nullable(),
  durationSec: z.number().nonnegative().nullable(),
  title: z.string().max(ITEM_CARD_TITLE_MAX_LENGTH).nullable(),
  description: z.string().max(ITEM_CARD_DESCRIPTION_MAX_LENGTH).nullable(),
  isFavourite: z.boolean(),
  width: z.number().int().nonnegative().nullable(),
  height: z.number().int().nonnegative().nullable(),
  // The connector this memory came from (AC-7). Null only for a deduped item
  // whose every provenance occurrence has been undone — normally a known source.
  source: sourceTypeSchema.nullable(),
  // Whether this memory is visually renderable (a photo or video) and so worth
  // asking `catalog:thumbnail` for. A pure hint — NOT a path or asset URL; the
  // renderer still receives only an opaque id and the bytes come back separately.
  hasThumbnail: z.boolean(),
});
export type ItemCardDTO = z.infer<typeof itemCardSchema>;

/** A page of timeline tiles plus the opaque cursor to fetch the next page. */
export const timelinePageSchema = z.strictObject({
  items: z.array(itemCardSchema),
  nextCursor: z.string().max(CURSOR_MAX_LENGTH).nullable(),
});
export type TimelinePageDTO = z.infer<typeof timelinePageSchema>;

/** A full-text search result page. */
export const searchResultSchema = z.strictObject({
  items: z.array(itemCardSchema),
  total: z.number().int().nonnegative(),
});
export type SearchResultDTO = z.infer<typeof searchResultSchema>;

/** A reported-not-thrown skip (AC-15), surfaced to the import UI verbatim. */
export const skippedItemSchema = z.strictObject({
  ref: z.string(),
  reason: z.string(),
  code: z.string().optional(),
});
export type SkippedItemDTO = z.infer<typeof skippedItemSchema>;

/**
 * The terminal tally of an import run — mirrors the engine's `IngestionSummary`
 * (counts + the skip list + the cooperative-cancel flag).
 */
export const importSummarySchema = z.strictObject({
  recordCount: z.number().int().nonnegative(),
  itemsTouched: z.number().int().nonnegative(),
  occurrencesAdded: z.number().int().nonnegative(),
  assetsAdded: z.number().int().nonnegative(),
  thumbnailFailures: z.number().int().nonnegative(),
  skipped: z.array(skippedItemSchema),
  cancelled: z.boolean(),
});
export type ImportSummaryDTO = z.infer<typeof importSummarySchema>;

// ── Transcription run (M2, #157 — ADR-0027 / AC-18·19·20) ─────────────────────
//
// The renderer-facing projection of a transcription run: an overall state, a live
// tally, and the last item that settled. The run itself executes off-thread (the
// #134 worker) and persists host-side (#135); these DTOs are all the sandboxed
// renderer (#136) ever sees — no paths, no transcripts, just calm progress.

/**
 * The per-item terminal status the UI may show on the last settled item. Only the
 * three RENDERABLE outcomes cross the boundary; the run-internal `cancelled` and
 * `pending` states are deliberately absent (a re-run picks them up) and so are
 * rejected by this enum.
 */
export const transcriptionItemStatusSchema = z.enum(['transcribed', 'failed', 'skipped']);
export type TranscriptionItemStatusDTO = z.infer<typeof transcriptionItemStatusSchema>;

/** The overall state of a transcription run, reflected by the UI on launch. */
export const transcriptionRunStateSchema = z.enum(['idle', 'running', 'complete']);
export type TranscriptionRunStateDTO = z.infer<typeof transcriptionRunStateSchema>;

/**
 * The live counts for a run. `total` is the whole transcribable corpus; the rest
 * are settled tallies plus `inFlight` (0 or 1 — the worker runs items serially, so
 * the schema bounds it to at most one). Every field is a non-negative integer, so
 * an adversarial negative (or an impossible second concurrent item) is refused.
 */
export const transcriptionCountsSchema = z.strictObject({
  total: z.number().int().nonnegative(),
  transcribed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  inFlight: z.number().int().min(0).max(1),
});
export type TranscriptionCountsDTO = z.infer<typeof transcriptionCountsSchema>;

/**
 * A snapshot of a transcription run — the payload of both `transcription:status`
 * and the `transcription:progress` event. `lastItem` is the most recently settled
 * item (id + renderable status) or null before anything has settled.
 */
export const transcriptionSnapshotSchema = z.strictObject({
  state: transcriptionRunStateSchema,
  counts: transcriptionCountsSchema,
  lastItem: z.strictObject({ id: z.uuid(), status: transcriptionItemStatusSchema }).nullable(),
});
export type TranscriptionSnapshotDTO = z.infer<typeof transcriptionSnapshotSchema>;

/**
 * Why a gated `transcription:start` was refused — a calm, branchable reason the UI
 * surfaces (never an exception): the user has not opted in, or the model is not
 * present-and-verified. Anything else is a hard validation error.
 */
export const transcriptionRefusalReasonSchema = z.enum(['not-opted-in', 'model-not-ready']);
export type TranscriptionRefusalReasonDTO = z.infer<typeof transcriptionRefusalReasonSchema>;

/**
 * The result of `transcription:start`: `started` (a run is now in flight), `idle`
 * (nothing to do — empty or everything already done), or `refused` (gated, with a
 * typed `reason`). A DISCRIMINATED UNION on `outcome` ties `reason` to the
 * outcome: only `refused` carries a refusal reason, while `started`/`idle` carry
 * `reason: null` — so `{outcome:'started',reason:'not-opted-in'}` is invalid.
 * `counts` reflects the corpus at the moment of the call.
 */
export const transcriptionStartResultSchema = z.discriminatedUnion('outcome', [
  z.strictObject({
    outcome: z.literal('started'),
    reason: z.null(),
    counts: transcriptionCountsSchema,
  }),
  z.strictObject({
    outcome: z.literal('idle'),
    reason: z.null(),
    counts: transcriptionCountsSchema,
  }),
  z.strictObject({
    outcome: z.literal('refused'),
    reason: transcriptionRefusalReasonSchema,
    counts: transcriptionCountsSchema,
  }),
]);
export type TranscriptionStartResultDTO = z.infer<typeof transcriptionStartResultSchema>;

// ── Per-item transcript view (M2, #136 — ADR-0027 / AC-13·19) ─────────────────
//
// The renderer-facing projection of ONE item's transcript, returned by
// `catalog:getTranscript`. The full text + ms-timed segments live host-side
// (#135); this read path is all the sandboxed item view ever sees — no file
// paths, no audio bytes, just the words and their detected language so a screen
// reader can pronounce Spanish/etc. correctly (the `lang` attribute, AC-13).

/**
 * The persisted transcription status of ONE item (mirrors `items.transcript_status`,
 * #135): `pending` (not transcribed yet, or in flight), `done` (words available),
 * `failed` (the run could not transcribe it), or `skipped` (nothing to capture).
 */
export const transcriptStatusSchema = z.enum(['pending', 'done', 'failed', 'skipped']);
export type TranscriptStatusDTO = z.infer<typeof transcriptStatusSchema>;

/**
 * One contiguous, millisecond-timed segment of a transcript. `startMs`/`endMs`
 * are non-negative integers (ms from the media start) and `text` is the words
 * spoken in that span. Carried so a future player could seek to a line; the UI
 * needs at least the full text to read.
 */
export const transcriptSegmentSchema = z.strictObject({
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().nonnegative(),
  text: z.string().max(TRANSCRIPT_TEXT_MAX_LENGTH),
});
export type TranscriptSegmentDTO = z.infer<typeof transcriptSegmentSchema>;

/**
 * The renderer-facing view of an item's transcript. `status` is always present;
 * `text` and `language` are non-null only once `status === 'done'` (`language` is
 * the whisper-detected tag, e.g. `es`, or null when undetected), and `segments`
 * is empty unless done. `text` and `segments` are bounded only by generous
 * defence-in-depth caps (#164) — a long recording's transcript is legitimately
 * large, and it crosses only as the words themselves, never as a path or handle.
 */
export const transcriptViewSchema = z.strictObject({
  status: transcriptStatusSchema,
  language: z.string().max(NAME_MAX_LENGTH).nullable(),
  text: z.string().max(TRANSCRIPT_TEXT_MAX_LENGTH).nullable(),
  segments: z.array(transcriptSegmentSchema).max(TRANSCRIPT_SEGMENTS_MAX),
});
export type TranscriptViewDTO = z.infer<typeof transcriptViewSchema>;

// ── Explainable categorization (M4-2h, #270 — ADR-0030 / AC-30·33) ────────────
//
// The renderer-facing projection of the categorizer (#264/#269): per-item
// explainable CHIPS (category groupings with WHY + HOW-SURE), the opt-in gate
// snapshot, and the run result/snapshot. Like the transcription DTOs these carry
// no paths, no vectors, no gazetteer bytes — only the calm, correctable facts the
// item view paints. The enums mirror the categories-repo CHECK domains exactly, so
// an adversarial payload with an unknown kind/source/signal is a hard error.

/** Defence-in-depth caps for the correctable label + its human explanation. */
export const CATEGORY_NAME_MAX_LENGTH = 200;
export const CATEGORY_EXPLANATION_MAX_LENGTH = 512;

/**
 * The category kinds (mirrors the categories.kind CHECK). `place` and `theme` are
 * what the shipped categorizer produces today; `person` is a valid kind in the CHECK
 * domain (paired with the `face-cluster` signal) but is not yet surfaced.
 */
export const categoryKindSchema = z.enum(['person', 'place', 'theme']);
export type CategoryKindDTO = z.infer<typeof categoryKindSchema>;

/** Assignment provenance — `user` always wins over `auto` (mirrors the source CHECK). */
export const assignmentSourceSchema = z.enum(['auto', 'user']);
export type AssignmentSourceDTO = z.infer<typeof assignmentSourceSchema>;

/** WHY an assignment was made — the machine reason (mirrors the signal CHECK). */
export const assignmentSignalSchema = z.enum(['gps', 'theme-cluster', 'face-cluster', 'user']);
export type AssignmentSignalDTO = z.infer<typeof assignmentSignalSchema>;

/**
 * ONE explainable assignment on an item: the category (id + kind + correctable
 * name) plus its provenance — the winning `source`, the machine `signal`, the
 * auto `confidence` in [0, 1] (null for a certain user decision), and the human
 * `explanation` the chip's tooltip shows.
 */
export const itemCategorySchema = z.strictObject({
  categoryId: z.uuid(),
  kind: categoryKindSchema,
  name: z.string().max(CATEGORY_NAME_MAX_LENGTH),
  source: assignmentSourceSchema,
  signal: assignmentSignalSchema.nullable(),
  confidence: z.number().min(0).max(1).nullable(),
  explanation: z.string().max(CATEGORY_EXPLANATION_MAX_LENGTH).nullable(),
});
export type ItemCategoryDTO = z.infer<typeof itemCategorySchema>;

/** The resolved chip list for one item (place before theme, name-ordered). */
export const itemCategoriesSchema = z.array(itemCategorySchema);
export type ItemCategoriesDTO = z.infer<typeof itemCategoriesSchema>;

/**
 * The opt-in gate snapshot the UI reads (M4-2h): whether the user `optedIn`, and
 * whether the feature is even `offered` yet — true ONLY when the gazetteer asset is
 * bundled. While `offered` is false the whole opt-in surface stays hidden; while
 * `optedIn` is false NO chips show and no category_status ever transitions (AC-33).
 */
export const categorizationStatusSchema = z.strictObject({
  optedIn: z.boolean(),
  offered: z.boolean(),
});
export type CategorizationStatusDTO = z.infer<typeof categorizationStatusSchema>;

/**
 * The live tally for a categorization run: settled items folded into ≥1 category
 * (`categorized`), signal-less items (`skipped`), failures, and the `inFlight`
 * corpus being clustered. Every field is a non-negative integer, so an adversarial
 * negative is refused. Mirrors the orchestrator's `CategorizationRunCounts` exactly.
 */
export const categorizationCountsSchema = z.strictObject({
  categorized: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  inFlight: z.number().int().nonnegative(),
});
export type CategorizationCountsDTO = z.infer<typeof categorizationCountsSchema>;

/** The terminal per-item status the UI may show on the last settled item. */
export const categorizationItemStatusSchema = z.enum(['categorized', 'skipped', 'failed']);
export type CategorizationItemStatusDTO = z.infer<typeof categorizationItemStatusSchema>;

/** The overall state of a categorization run. */
export const categorizationRunStateSchema = z.enum(['idle', 'running', 'complete']);
export type CategorizationRunStateDTO = z.infer<typeof categorizationRunStateSchema>;

/**
 * A snapshot of a categorization run — the payload of the `categorize:progress`
 * event. `lastItem` is the most recently settled item (id + status) or null before
 * anything settled. Mirrors the orchestrator's `CategorizationRunSnapshot`.
 */
export const categorizationSnapshotSchema = z.strictObject({
  state: categorizationRunStateSchema,
  counts: categorizationCountsSchema,
  lastItem: z.strictObject({ id: z.uuid(), status: categorizationItemStatusSchema }).nullable(),
});
export type CategorizationSnapshotDTO = z.infer<typeof categorizationSnapshotSchema>;

/**
 * Why a gated `categorize:start` refused — a calm, branchable reason: the user has
 * not opted in, or there is no usable signal at all (`no-signal` is kind-agnostic;
 * today's signals derive place & theme). Mirrors the orchestrator's
 * `CategorizationUnavailableReason`.
 */
export const categorizationRefusalReasonSchema = z.enum(['not-opted-in', 'no-signal']);
export type CategorizationRefusalReasonDTO = z.infer<typeof categorizationRefusalReasonSchema>;

/**
 * The result of `categorize:start`, a DISCRIMINATED UNION on `outcome` that ties
 * `reason` to the outcome: only `refused` carries a typed refusal reason; every
 * other outcome (`completed`/`idle`/`cancelled`/`busy`) carries `reason: null`. So
 * `{outcome:'completed',reason:'not-opted-in'}` is invalid. Mirrors the
 * orchestrator's `CategorizationRunResult` shape 1:1, so the handler just `.parse()`s
 * the raw result with no mapping.
 */
export const categorizationStartResultSchema = z.discriminatedUnion('outcome', [
  z.strictObject({
    outcome: z.literal('completed'),
    reason: z.null(),
    counts: categorizationCountsSchema,
  }),
  z.strictObject({
    outcome: z.literal('idle'),
    reason: z.null(),
    counts: categorizationCountsSchema,
  }),
  z.strictObject({
    outcome: z.literal('cancelled'),
    reason: z.null(),
    counts: categorizationCountsSchema,
  }),
  z.strictObject({
    outcome: z.literal('busy'),
    reason: z.null(),
    counts: categorizationCountsSchema,
  }),
  z.strictObject({
    outcome: z.literal('refused'),
    reason: categorizationRefusalReasonSchema,
    counts: categorizationCountsSchema,
  }),
]);
export type CategorizationStartResultDTO = z.infer<typeof categorizationStartResultSchema>;

/**
 * A user correction to apply — a DISCRIMINATED UNION on `kind`: `confirm` and
 * `remove` pin an (item, category); `reassign` moves an item from one category to
 * another; `rename` relabels the category. Ids are uuids (never paths) and a rename
 * `name` is non-empty and bounded, so a malformed correction is a hard error.
 */
export const categorizationCorrectionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('confirm'), itemId: z.uuid(), categoryId: z.uuid() }),
  z.strictObject({ kind: z.literal('remove'), itemId: z.uuid(), categoryId: z.uuid() }),
  z.strictObject({
    kind: z.literal('reassign'),
    itemId: z.uuid(),
    fromCategoryId: z.uuid(),
    toCategoryId: z.uuid(),
  }),
  z.strictObject({
    kind: z.literal('rename'),
    itemId: z.uuid(),
    categoryId: z.uuid(),
    name: z.string().min(1).max(CATEGORY_NAME_MAX_LENGTH),
  }),
]);
export type CategorizationCorrectionDTO = z.infer<typeof categorizationCorrectionSchema>;

// ── Suggested collections review tray (M4-3c, #273 — ADR-0030 / AC-32) ─────────
//
// The renderer-facing projection of the suggested-collection review TRAY: the
// derived place/theme candidates (proposed name + effective member count + a few
// example items), plus the real collections a candidate may be merged INTO.
// Suggestions are derived READ-ONLY (#271) and become a `collections` row ONLY on
// an explicit accept/merge via the curation repo (#272) — so nothing here is a
// path, a vector, or a silently-created collection. The enums mirror the
// derivation/curation domains exactly, so an adversarial payload with an
// out-of-scope kind/origin is a hard error.

/** How many example items a suggestion card carries (a "few" — a defence-in-depth cap). */
export const SUGGESTION_EXAMPLES_MAX = 4;

/** Defence-in-depth cap for a merge-target collection name (mirrors the collections.name budget). */
export const COLLECTION_NAME_MAX_LENGTH = 200;

/**
 * Generous defence-in-depth ceiling on the review-tray's two TOP-LEVEL arrays
 * (`suggestions` / `collections`). Both derive from a deterministic local SELECT
 * (one row per place/theme category, one per materialised collection), so this is
 * far above any realistic loved-one's archive — it never rejects a real library,
 * only a corrupt or adversarial response. Mirrors the sibling per-response caps
 * (e.g. {@link TRANSCRIPT_SEGMENTS_MAX}) so no array crosses the boundary unbounded.
 */
export const SUGGESTIONS_VIEW_MAX = 100_000;

/** The suggestible category kinds — places and themes only ('person' is out of scope). */
export const suggestionKindSchema = z.enum(['place', 'theme']);
export type SuggestionKindDTO = z.infer<typeof suggestionKindSchema>;

/**
 * One example member of a suggestion — the slim tile the tray card shows so the
 * user recognises the grouping. A renderer-safe subset of an item (id + media
 * type + title + a "worth a thumbnail" hint); no path or byte rides along — the
 * bytes, when any, come back separately via `catalog:thumbnail` (AC-4).
 */
export const suggestionExampleSchema = z.strictObject({
  id: z.uuid(),
  mediaType: mediaTypeSchema,
  title: z.string().max(ITEM_CARD_TITLE_MAX_LENGTH).nullable(),
  hasThumbnail: z.boolean(),
});
export type SuggestionExampleDTO = z.infer<typeof suggestionExampleSchema>;

/**
 * ONE suggested collection awaiting review: its source category (id + kind +
 * proposed name), the EFFECTIVE member count, and up to {@link
 * SUGGESTION_EXAMPLES_MAX} example items. Carries `categoryId` (the provenance an
 * accept records), never a collection id — a suggestion is not yet a collection.
 */
export const suggestionSchema = z.strictObject({
  categoryId: z.uuid(),
  kind: suggestionKindSchema,
  name: z.string().max(CATEGORY_NAME_MAX_LENGTH),
  memberCount: z.number().int().nonnegative(),
  examples: z.array(suggestionExampleSchema).max(SUGGESTION_EXAMPLES_MAX),
});
export type SuggestionDTO = z.infer<typeof suggestionSchema>;

/**
 * A real, materialised collection a suggestion may be merged INTO — a hand-made
 * ('user') or already-accepted ('suggested') collection. A 'dismissed' tombstone
 * is deliberately excluded (member-less, never a target), so an out-of-scope
 * origin is a hard error.
 */
export const suggestionMergeTargetSchema = z.strictObject({
  collectionId: z.uuid(),
  name: z.string().max(COLLECTION_NAME_MAX_LENGTH),
  origin: z.enum(['user', 'suggested']),
});
export type SuggestionMergeTargetDTO = z.infer<typeof suggestionMergeTargetSchema>;

/**
 * The whole review-tray payload: the pending `suggestions` and the real
 * `collections` a merge may target. Returned by `suggestions:list` and echoed
 * (refreshed) by every curation action, so the tray repaints from the response
 * with no manual re-fetch — the same shape `categorize:applyCorrection` uses.
 */
export const suggestionsViewSchema = z.strictObject({
  suggestions: z.array(suggestionSchema).max(SUGGESTIONS_VIEW_MAX),
  collections: z.array(suggestionMergeTargetSchema).max(SUGGESTIONS_VIEW_MAX),
});
export type SuggestionsViewDTO = z.infer<typeof suggestionsViewSchema>;
