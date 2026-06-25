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
