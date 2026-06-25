import { z } from 'zod';
import {
  CURSOR_MAX_LENGTH,
  NAME_MAX_LENGTH,
  PAGE_LIMIT_MAX,
  QUERY_MAX_LENGTH,
  THUMBNAIL_MAX_SIZE,
  THUMBNAIL_MIN_SIZE,
  librarySummarySchema,
  pathSchema,
  searchResultSchema,
  sourceTypeSchema,
  thumbnailDataUrlSchema,
  timelinePageSchema,
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
/** IPC channel: start an off-thread import; resolves with the new job id. */
export const IMPORT_START = 'import:start';
/** IPC channel: cooperatively cancel an in-flight import by job id. */
export const IMPORT_CANCEL = 'import:cancel';

/** IPC channel: open a native folder picker; resolves the chosen path or null. */
export const DIALOG_OPEN_DIRECTORY = 'dialog:openDirectory';
/** IPC channel: open a native single-file picker; resolves the chosen path or null. */
export const DIALOG_OPEN_FILE = 'dialog:openFile';

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
} as const;

export type IpcContract = typeof ipcContract;
export type IpcChannel = keyof IpcContract & string;
export type IpcRequest<C extends IpcChannel> = z.input<IpcContract[C]['request']>;
export type IpcResponse<C extends IpcChannel> = z.output<IpcContract[C]['response']>;
