// Test doubles for the renderer suites: a configurable in-memory KawsayAPI plus
// small DTO builders. The fake never touches Electron/IPC — it just records calls
// and lets a test drive the import-progress stream synchronously via emitProgress.
import { vi } from 'vitest';
import type {
  ImportProgressEvent,
  ImportSummaryDTO,
  ItemCardDTO,
  KawsayAPI,
  LibrarySummaryDTO,
  SearchResultDTO,
} from '@shared/kawsay-api';

/** A stable, valid-looking job id used across import tests. */
export const FAKE_JOB_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

let itemCardSeq = 0;

/**
 * Build a renderer-shaped timeline/search tile. The id is unique per call so
 * list-key and dedup tests get visibly distinct rows; pass `over` (e.g. `{ id }`)
 * to pin any field — including a deterministic id — when a test asserts on it.
 */
export function makeItemCard(over: Partial<ItemCardDTO> = {}): ItemCardDTO {
  itemCardSeq += 1;
  return {
    id: `00000000-0000-4000-8000-${String(itemCardSeq).padStart(12, '0')}`,
    mediaType: 'photo',
    mimeType: 'image/jpeg',
    captureDate: '2019-06-15T10:00:00.000Z',
    durationSec: null,
    title: 'A quiet afternoon',
    description: null,
    isFavourite: false,
    width: 1600,
    height: 1200,
    source: 'folder',
    ...over,
  };
}

/** Build a search-result page; `total` defaults to the number of items given. */
export function makeSearchResult(over: Partial<SearchResultDTO> = {}): SearchResultDTO {
  const items = over.items ?? [];
  return { items, total: over.total ?? items.length };
}

export function makeLibrarySummary(over: Partial<LibrarySummaryDTO> = {}): LibrarySummaryDTO {
  return {
    root: '/Users/elena/Documents/Kawsay — Elena',
    name: 'Elena',
    createdAt: '2026-06-24T12:00:00.000Z',
    schemaVersion: 1,
    ...over,
  };
}

export function makeImportSummary(over: Partial<ImportSummaryDTO> = {}): ImportSummaryDTO {
  return {
    recordCount: 347,
    itemsTouched: 347,
    occurrencesAdded: 347,
    assetsAdded: 320,
    thumbnailFailures: 0,
    skipped: [],
    cancelled: false,
    ...over,
  };
}

export function makeProgressEvent(over: Partial<ImportProgressEvent> = {}): ImportProgressEvent {
  return {
    jobId: FAKE_JOB_ID,
    phase: 'parse',
    processed: 0,
    total: null,
    message: null,
    summary: null,
    error: null,
    ...over,
  };
}

export interface FakeApi extends KawsayAPI {
  /** Push a progress event to every current onImportProgress subscriber. */
  emitProgress(event: ImportProgressEvent): void;
  /** Number of live import-progress subscribers (asserts clean unsubscribe). */
  subscriberCount(): number;
}

export interface FakeApiOptions {
  appVersion?: string;
  jobId?: string;
  createLibrary?: KawsayAPI['createLibrary'];
  openLibrary?: KawsayAPI['openLibrary'];
  getTimeline?: KawsayAPI['getTimeline'];
  searchCatalog?: KawsayAPI['searchCatalog'];
  startImport?: KawsayAPI['startImport'];
  cancelImport?: KawsayAPI['cancelImport'];
  openDirectory?: KawsayAPI['openDirectory'];
  openFile?: KawsayAPI['openFile'];
}

/** Build a fully typed fake KawsayAPI whose methods are spies (vi.fn). */
export function makeFakeApi(opts: FakeApiOptions = {}): FakeApi {
  const listeners = new Set<(event: ImportProgressEvent) => void>();
  const jobId = opts.jobId ?? FAKE_JOB_ID;

  return {
    getAppVersion: vi.fn(() => Promise.resolve(opts.appVersion ?? '0.1.0')),
    createLibrary:
      opts.createLibrary ??
      vi.fn((input: { path: string; personName?: string }) =>
        Promise.resolve(makeLibrarySummary({ root: input.path, name: input.personName ?? 'Library' })),
      ),
    openLibrary:
      opts.openLibrary ??
      vi.fn((input: { path: string }) =>
        Promise.resolve(makeLibrarySummary({ root: input.path })),
      ),
    getTimeline: opts.getTimeline ?? vi.fn(() => Promise.resolve({ items: [], nextCursor: null })),
    searchCatalog: opts.searchCatalog ?? vi.fn(() => Promise.resolve({ items: [], total: 0 })),
    startImport: opts.startImport ?? vi.fn(() => Promise.resolve({ jobId })),
    cancelImport: opts.cancelImport ?? vi.fn(() => Promise.resolve({ cancelled: true })),
    // Default to "cancelled" (null) so existing flows that never click Browse are
    // unaffected; tests that exercise the picker pass their own resolved path.
    openDirectory: opts.openDirectory ?? vi.fn(() => Promise.resolve(null)),
    openFile: opts.openFile ?? vi.fn(() => Promise.resolve(null)),
    onImportProgress: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emitProgress: (event) => {
      for (const listener of [...listeners]) listener(event);
    },
    subscriberCount: () => listeners.size,
  };
}
