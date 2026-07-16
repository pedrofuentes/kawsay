import { z } from 'zod';
import {
  CATEGORY_NAME_MAX_LENGTH,
  CURSOR_MAX_LENGTH,
  NAME_MAX_LENGTH,
  PAGE_LIMIT_MAX,
  QUERY_MAX_LENGTH,
  THUMBNAIL_MAX_SIZE,
  THUMBNAIL_MIN_SIZE,
  categorizationCorrectionSchema,
  categorizationStartResultSchema,
  categorizationStatusSchema,
  itemCategoriesSchema,
  librarySummarySchema,
  mediaTypeSchema,
  MEDIA_TYPE_COUNT,
  pathSchema,
  searchResultSchema,
  searchDaySchema,
  sourceTypeSchema,
  suggestionsViewSchema,
  thumbnailDataUrlSchema,
  timelinePageSchema,
  transcriptViewSchema,
  transcriptionSnapshotSchema,
  transcriptionStartResultSchema,
} from './schemas';

/** IPC channel: request the running application version. */
export const APP_GET_VERSION = 'app:getVersion';

/** IPC channel: create a brand-new library at a chosen root directory. */
export const LIBRARY_CREATE = 'library:create';
/** IPC channel: open an existing library at a root directory. */
export const LIBRARY_OPEN = 'library:open';
/** IPC channel: fetch a keyset page of the timeline (newest first). */
export const CATALOG_TIMELINE = 'catalog:timeline';
/** IPC channel: full-text search the open catalog. */
export const CATALOG_SEARCH = 'catalog:search';
/**
 * IPC channel: fetch a bounded thumbnail for ONE catalog item by its opaque id.
 * The request carries only the id (and an optional size) — never a path — so the
 * main process does all original-resolution + confinement and answers with a
 * self-contained image `data:` URL or null (U4).
 */
export const CATALOG_THUMBNAIL = 'catalog:thumbnail';
/**
 * IPC channel: read ONE item's transcript by its opaque catalog id (#136). The
 * request carries only the id — never a path — and the response is a renderer-safe
 * {@link transcriptViewSchema}: a status plus, when done, the spoken words, the
 * whisper-detected language (for the `lang` attribute, AC-13), and ms-timed
 * segments. No filesystem path or audio byte crosses back (AC-4).
 */
export const CATALOG_GET_TRANSCRIPT = 'catalog:getTranscript';
/** IPC channel: start an off-thread import; resolves with the new job id. */
export const IMPORT_START = 'import:start';
/** IPC channel: cooperatively cancel an in-flight import by job id. */
export const IMPORT_CANCEL = 'import:cancel';

/** IPC channel: open a native folder picker; resolves the chosen path or null. */
export const DIALOG_OPEN_DIRECTORY = 'dialog:openDirectory';
/** IPC channel: open a native single-file picker; resolves the chosen path or null. */
export const DIALOG_OPEN_FILE = 'dialog:openFile';

/**
 * IPC channel: start the opt-in transcription-model download (AC-17). Caller-
 * initiated only — the renderer must explicitly invoke it (the consent UI is
 * card #132); it is NEVER auto-triggered. Resolves immediately with whether a
 * download was `started` or the model was `already-present`; byte-level progress
 * and the terminal result stream over {@link TRANSCRIPTION_MODEL_DOWNLOAD_PROGRESS}.
 */
export const TRANSCRIPTION_DOWNLOAD_MODEL = 'transcription:downloadModel';
/**
 * IPC channel: query whether the transcription model is present AND integrity-
 * verified (a capability gate for the UI). Resolves `{ ready }`.
 */
export const TRANSCRIPTION_MODEL_STATUS = 'transcription:modelStatus';

/**
 * IPC channel: start the gated transcription run over the library's audio/video
 * (#157 — ADR-0027 / AC-18·19·20). Caller-initiated only and DOUBLY gated: it
 * refuses unless the user has opted in AND the model is present-and-verified, and
 * it never auto-starts. Idempotent — items already `done` are skipped. Resolves
 * with whether a run `started`, there was nothing to do (`idle`), or it was
 * `refused` (with a typed reason); per-item progress streams over
 * {@link TRANSCRIPTION_PROGRESS}.
 */
export const TRANSCRIPTION_START = 'transcription:start';
/**
 * IPC channel: query the overall transcription run state (idle/running/complete +
 * counts) so the UI can reflect it on launch. Resolves a snapshot.
 */
export const TRANSCRIPTION_STATUS = 'transcription:status';
/**
 * IPC channel: cooperatively cancel an in-flight transcription run. The worker
 * SIGKILLs the in-flight child and the batch stops; whatever completed is already
 * persisted. Resolves `{ cancelled }` (false when nothing was running).
 */
export const TRANSCRIPTION_CANCEL = 'transcription:cancel';

/**
 * IPC channel: start the opt-in SMART-SEARCH embedder-model download (M4-1b /
 * ADR-0029). Caller-initiated only — the renderer must explicitly invoke it (the
 * opt-in UI is a LATER slice); it is NEVER auto-triggered. Resolves immediately with
 * the terminal `outcome`: `download-started` (a fetch is now in flight — watch the
 * progress event), `already-present` (a verified model is on disk, nothing to do), or
 * `unsupported-platform` (nowhere to install → smart search stays exact FTS). Byte
 * progress and the terminal result stream over
 * {@link SMART_SEARCH_MODEL_DOWNLOAD_PROGRESS} — a channel SEPARATE from the
 * transcription download so the two never cross-talk.
 */
export const SMART_SEARCH_DOWNLOAD_MODEL = 'smartSearch:downloadModel';
/**
 * IPC channel: query the smart-search capability snapshot the (opt-in) UI reads —
 * whether the user `optedIn`, whether the embedder model is present-and-verified
 * (`modelReady`), and whether the feature is even `offered` yet (a real model is
 * published AND this platform can install it). Resolves
 * `{ optedIn, modelReady, offered }`.
 */
export const SMART_SEARCH_MODEL_STATUS = 'smartSearch:modelStatus';

/**
 * IPC channels for the opt-in EXPLAINABLE CATEGORIZATION surface (M4-2h, #270 —
 * ADR-0030). All ADDITIVE — no existing channel or the contextBridge exposure model
 * changes. Each request/response is a strict zod schema, so a malformed payload is
 * rejected in either direction (AC-4).
 */
/** IPC channel: the opt-in gate snapshot `{ optedIn, offered }` the UI reads. */
export const CATEGORIZE_STATUS = 'categorize:status';
/** IPC channel: persist the categorization opt-in; echoes the resolved `{ optedIn }`. */
export const CATEGORIZE_SET_CONSENT = 'categorize:setConsent';
/** IPC channel: list ONE item's explainable category chips by its opaque id. */
export const CATEGORIZE_LIST_FOR_ITEM = 'categorize:listForItem';
/** IPC channel: apply a user correction (confirm/remove/reassign/rename); returns the refreshed chips. */
export const CATEGORIZE_APPLY_CORRECTION = 'categorize:applyCorrection';
/** IPC channel: start the gated categorization run; resolves the run result. Progress streams over the event. */
export const CATEGORIZE_START = 'categorize:start';
/** IPC channel: cooperatively cancel an in-flight categorization run; resolves `{ cancelled }`. */
export const CATEGORIZE_CANCEL = 'categorize:cancel';

/**
 * IPC channels for the SUGGESTED-COLLECTIONS review tray (M4-3c, #273 — ADR-0030).
 * All ADDITIVE — no existing channel or the contextBridge exposure model changes.
 * Each request/response is a strict zod schema, so a malformed payload is rejected
 * in either direction (AC-4). Suggestions are derived READ-ONLY (#271); a
 * `collections` row is created ONLY by an explicit curation action here (#272 /
 * AC-32), never by mere listing.
 */
/** IPC channel: list the pending suggestions + the real collections a merge may target. */
export const SUGGESTIONS_LIST = 'suggestions:list';
/** IPC channel: accept a suggestion (optionally renamed) — materialises the collection; echoes the refreshed tray. */
export const SUGGESTIONS_ACCEPT = 'suggestions:accept';
/** IPC channel: merge a suggestion into an existing collection; echoes the refreshed tray. */
export const SUGGESTIONS_MERGE = 'suggestions:merge';
/** IPC channel: dismiss a suggestion (durable tombstone — not re-proposed); echoes the refreshed tray. */
export const SUGGESTIONS_DISMISS = 'suggestions:dismiss';

/**
 * The renderer-controllable options for a native open dialog (W2). This is the
 * ENTIRE surface the sandboxed renderer may influence: a friendly title and an
 * optional starting directory — nothing else. `properties` (file vs directory),
 * `filters`, `securityScopedBookmarks`, and every other privileged Electron
 * dialog option are deliberately absent and, because this is a `strictObject`,
 * are rejected outright rather than forwarded (no arbitrary main-side passthrough).
 */
const dialogOpenRequestSchema = z.strictObject({
  title: z.string().min(1).max(NAME_MAX_LENGTH).optional(),
  defaultPath: pathSchema.optional(),
});

/**
 * The result of an open dialog: the single absolute path the user explicitly
 * chose, or `null` when they cancelled. A bare, bounded string — never an object
 * — so no extra filesystem detail can ride along to the renderer.
 */
const dialogOpenResponseSchema = pathSchema.nullable();

/**
 * The complete IPC contract. Every channel declares a zod schema for its
 * request and its response. The preload bridge validates before sending and
 * the main-process handler re-validates on receipt, so a malformed payload can
 * never cross the trust boundary in either direction (ARCHITECTURE §2.3, §2.6).
 *
 * Schemas are intentionally `strictObject` — unknown keys are rejected, not
 * silently stripped.
 */
export const ipcContract = {
  [APP_GET_VERSION]: {
    request: z.strictObject({}),
    response: z.strictObject({ version: z.string().min(1) }),
  },
  [LIBRARY_CREATE]: {
    request: z.strictObject({
      path: pathSchema,
      personName: z.string().min(1).max(200).optional(),
    }),
    response: librarySummarySchema,
  },
  [LIBRARY_OPEN]: {
    request: z.strictObject({ path: pathSchema }),
    response: librarySummarySchema,
  },
  [CATALOG_TIMELINE]: {
    request: z.strictObject({
      limit: z.number().int().min(1).max(PAGE_LIMIT_MAX),
      cursor: z.string().min(1).max(CURSOR_MAX_LENGTH).optional(),
    }),
    response: timelinePageSchema,
  },
  [CATALOG_SEARCH]: {
    request: z.strictObject({
      query: z.string().min(1).max(QUERY_MAX_LENGTH),
      limit: z.number().int().min(1).max(PAGE_LIMIT_MAX).default(50),
      offset: z.number().int().nonnegative().default(0),
      // Optional connector filter (AC-7) — narrows the match set to one source.
      // Omitted ⇒ every source, so the channel stays backward-compatible.
      source: sourceTypeSchema.optional(),
      // Optional media-type filter (any-of) applied server-side across the whole
      // library, not just the first page (#431). A bounded set of the known media
      // types (no duplicates would still validate, the repo treats it as a set);
      // omitted ⇒ every type.
      types: z.array(mediaTypeSchema).min(1).max(MEDIA_TYPE_COUNT).optional(),
      // Optional inclusive `YYYY-MM-DD` capture-date bounds, applied server-side
      // (#431). A strict day format so a free-form or adversarial string is refused
      // at the boundary; omitted ⇒ no bound on that side.
      fromDate: searchDaySchema.optional(),
      toDate: searchDaySchema.optional(),
    }),
    response: searchResultSchema,
  },
  [CATALOG_THUMBNAIL]: {
    request: z.strictObject({
      // An opaque catalog id — a uuid, so a path/traversal string never validates.
      id: z.uuid(),
      // The desired longest edge in px; the main process clamps, but bound it here
      // too so junk (0, 321, fractional) is refused at the boundary.
      size: z.number().int().min(THUMBNAIL_MIN_SIZE).max(THUMBNAIL_MAX_SIZE).optional(),
    }),
    response: thumbnailDataUrlSchema,
  },
  [CATALOG_GET_TRANSCRIPT]: {
    // The renderer names only an opaque catalog id — never a path — so a traversal
    // string can never validate, mirroring catalog:thumbnail.
    request: z.strictObject({ id: z.uuid() }),
    response: transcriptViewSchema,
  },
  [IMPORT_START]: {
    request: z.strictObject({
      sourceType: sourceTypeSchema,
      inputPath: pathSchema,
    }),
    response: z.strictObject({ jobId: z.uuid() }),
  },
  [IMPORT_CANCEL]: {
    request: z.strictObject({ jobId: z.uuid() }),
    response: z.strictObject({ cancelled: z.boolean() }),
  },
  [DIALOG_OPEN_DIRECTORY]: {
    request: dialogOpenRequestSchema,
    response: dialogOpenResponseSchema,
  },
  [DIALOG_OPEN_FILE]: {
    request: dialogOpenRequestSchema,
    response: dialogOpenResponseSchema,
  },
  [TRANSCRIPTION_DOWNLOAD_MODEL]: {
    request: z.strictObject({}),
    // `started` ⇒ a download is now in flight (watch the progress event);
    // `already-present` ⇒ a verified model is on disk, nothing to do.
    response: z.strictObject({ status: z.enum(['started', 'already-present']) }),
  },
  [TRANSCRIPTION_MODEL_STATUS]: {
    request: z.strictObject({}),
    response: z.strictObject({ ready: z.boolean() }),
  },
  [TRANSCRIPTION_START]: {
    request: z.strictObject({}),
    response: transcriptionStartResultSchema,
  },
  [TRANSCRIPTION_STATUS]: {
    request: z.strictObject({}),
    response: transcriptionSnapshotSchema,
  },
  [TRANSCRIPTION_CANCEL]: {
    request: z.strictObject({}),
    response: z.strictObject({ cancelled: z.boolean() }),
  },
  [SMART_SEARCH_DOWNLOAD_MODEL]: {
    request: z.strictObject({}),
    // `download-started` ⇒ a fetch is now in flight (watch the progress event);
    // `already-present` ⇒ a verified model is on disk, nothing to do;
    // `unsupported-platform` ⇒ no install target here, so smart search stays FTS.
    response: z.strictObject({
      outcome: z.enum(['download-started', 'already-present', 'unsupported-platform']),
    }),
  },
  [SMART_SEARCH_MODEL_STATUS]: {
    request: z.strictObject({}),
    // `offered` gates the whole opt-in UI: true ONLY when a real model is published
    // AND this platform can install it (isEmbedModelPublished + a non-null downloader).
    response: z.strictObject({
      optedIn: z.boolean(),
      modelReady: z.boolean(),
      offered: z.boolean(),
    }),
  },
  [CATEGORIZE_STATUS]: {
    request: z.strictObject({}),
    response: categorizationStatusSchema,
  },
  [CATEGORIZE_SET_CONSENT]: {
    request: z.strictObject({ optedIn: z.boolean() }),
    response: z.strictObject({ optedIn: z.boolean() }),
  },
  [CATEGORIZE_LIST_FOR_ITEM]: {
    // The renderer names only an opaque catalog id — never a path — so a traversal
    // string can never validate, mirroring catalog:getTranscript.
    request: z.strictObject({ itemId: z.uuid() }),
    response: itemCategoriesSchema,
  },
  [CATEGORIZE_APPLY_CORRECTION]: {
    request: categorizationCorrectionSchema,
    response: itemCategoriesSchema,
  },
  [CATEGORIZE_START]: {
    request: z.strictObject({}),
    response: categorizationStartResultSchema,
  },
  [CATEGORIZE_CANCEL]: {
    request: z.strictObject({}),
    response: z.strictObject({ cancelled: z.boolean() }),
  },
  [SUGGESTIONS_LIST]: {
    request: z.strictObject({}),
    response: suggestionsViewSchema,
  },
  [SUGGESTIONS_ACCEPT]: {
    // An opaque category id — never a path — plus an optional edited name (the
    // "rename before accepting" affordance): a bounded, non-empty label or nothing.
    request: z.strictObject({
      categoryId: z.uuid(),
      name: z.string().min(1).max(CATEGORY_NAME_MAX_LENGTH).optional(),
    }),
    response: suggestionsViewSchema,
  },
  [SUGGESTIONS_MERGE]: {
    // Both ids are opaque uuids: the source suggestion's category and the survivor
    // collection it folds into. No path can ever validate.
    request: z.strictObject({
      categoryId: z.uuid(),
      intoCollectionId: z.uuid(),
    }),
    response: suggestionsViewSchema,
  },
  [SUGGESTIONS_DISMISS]: {
    request: z.strictObject({
      categoryId: z.uuid(),
      name: z.string().min(1).max(CATEGORY_NAME_MAX_LENGTH).optional(),
    }),
    response: suggestionsViewSchema,
  },
} as const;

export type IpcContract = typeof ipcContract;
export type IpcChannel = keyof IpcContract & string;
export type IpcRequest<C extends IpcChannel> = z.input<IpcContract[C]['request']>;
export type IpcResponse<C extends IpcChannel> = z.output<IpcContract[C]['response']>;
