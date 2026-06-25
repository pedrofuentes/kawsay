/**
 * The entire renderer-facing capability surface exposed on `window.kawsayAPI`
 * by the preload bridge — one method per IPC channel (plus the one event
 * subscription), with no catch-all `send` (ARCHITECTURE §1.3, §2.3). The
 * renderer depends only on this type and never touches Node, Electron, the
 * filesystem, the database, or the network.
 */
import type {
  LibrarySummaryDTO,
  SearchResultDTO,
  TimelinePageDTO,
} from '@shared/ipc/schemas';
import type { ImportProgressEvent } from '@shared/ipc/events';
import type { SourceType } from '@shared/catalog';

export interface KawsayAPI {
  /** The running application version, validated end-to-end (channel `app:getVersion`). */
  getAppVersion(): Promise<string>;

  /** Create a new library at `path` and make it the open library. */
  createLibrary(input: { path: string; personName?: string }): Promise<LibrarySummaryDTO>;
  /** Open an existing library at `path` and make it the open library. */
  openLibrary(input: { path: string }): Promise<LibrarySummaryDTO>;

  /** Fetch one keyset page of the timeline (newest first). */
  getTimeline(input: { limit: number; cursor?: string }): Promise<TimelinePageDTO>;
  /** Full-text search the open catalog, optionally narrowed to one connector source. */
  searchCatalog(input: {
    query: string;
    limit?: number;
    offset?: number;
    source?: SourceType;
  }): Promise<SearchResultDTO>;

  /** Start an off-thread import; resolves with the new job id. */
  startImport(input: { sourceType: SourceType; inputPath: string }): Promise<{ jobId: string }>;
  /** Cooperatively cancel an in-flight import. */
  cancelImport(input: { jobId: string }): Promise<{ cancelled: boolean }>;

  /** Subscribe to the import progress stream; returns an unsubscribe function. */
  onImportProgress(listener: (event: ImportProgressEvent) => void): () => void;
}

// Re-exported for the renderer (U1/U2/U3), which imports these DTOs by name.
export type {
  ItemCardDTO,
  LibrarySummaryDTO,
  SearchResultDTO,
  TimelinePageDTO,
  ImportSummaryDTO,
} from '@shared/ipc/schemas';
export type { ImportProgressEvent } from '@shared/ipc/events';
export type { SourceType, MediaType } from '@shared/catalog';
