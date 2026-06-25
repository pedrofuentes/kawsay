import { z } from 'zod';
import {
  CURSOR_MAX_LENGTH,
  PAGE_LIMIT_MAX,
  QUERY_MAX_LENGTH,
  librarySummarySchema,
  pathSchema,
  searchResultSchema,
  sourceTypeSchema,
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
/** IPC channel: start an off-thread import; resolves with the new job id. */
export const IMPORT_START = 'import:start';
/** IPC channel: cooperatively cancel an in-flight import by job id. */
export const IMPORT_CANCEL = 'import:cancel';

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
} as const;

export type IpcContract = typeof ipcContract;
export type IpcChannel = keyof IpcContract & string;
export type IpcRequest<C extends IpcChannel> = z.input<IpcContract[C]['request']>;
export type IpcResponse<C extends IpcChannel> = z.output<IpcContract[C]['response']>;
