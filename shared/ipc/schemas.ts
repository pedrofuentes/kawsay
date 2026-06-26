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

/** A non-empty, bounded absolute path supplied by the renderer. */
export const pathSchema = z.string().min(1).max(PATH_MAX_LENGTH);

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
  title: z.string().nullable(),
  description: z.string().nullable(),
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
 * are settled tallies plus `inFlight` (0 or 1 — the worker runs items serially).
 * Every field is a non-negative integer, so an adversarial negative is refused.
 */
export const transcriptionCountsSchema = z.strictObject({
  total: z.number().int().nonnegative(),
  transcribed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  inFlight: z.number().int().nonnegative(),
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
 * typed `reason`). `counts` reflects the corpus at the moment of the call.
 */
export const transcriptionStartResultSchema = z.strictObject({
  outcome: z.enum(['started', 'idle', 'refused']),
  reason: transcriptionRefusalReasonSchema.nullable(),
  counts: transcriptionCountsSchema,
});
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
  text: z.string(),
});
export type TranscriptSegmentDTO = z.infer<typeof transcriptSegmentSchema>;

/**
 * The renderer-facing view of an item's transcript. `status` is always present;
 * `text` and `language` are non-null only once `status === 'done'` (`language` is
 * the whisper-detected tag, e.g. `es`, or null when undetected), and `segments`
 * is empty unless done. The text is deliberately UNBOUNDED — a long recording's
 * transcript is legitimately large, and it crosses only as the words themselves,
 * never as a path or handle (consistent with itemCardSchema's unbounded title).
 */
export const transcriptViewSchema = z.strictObject({
  status: transcriptStatusSchema,
  language: z.string().max(NAME_MAX_LENGTH).nullable(),
  text: z.string().nullable(),
  segments: z.array(transcriptSegmentSchema),
});
export type TranscriptViewDTO = z.infer<typeof transcriptViewSchema>;
