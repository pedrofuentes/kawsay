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
  ModelDownloadProgressEvent,
  SearchResultDTO,
  TranscriptionProgressEvent,
  TranscriptViewDTO,
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
    // Default false so existing list/render tests trigger NO thumbnail fetch and
    // keep showing the media-type icon; thumbnail tests opt in with `true`.
    hasThumbnail: false,
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

/**
 * Build a transcription-model download progress event. Defaults to an in-flight
 * `downloading` tick whose `totalBytes` is the real `small` model size
 * (ADR-0027 Decision 4: 487,601,967 bytes ≈ 466 MiB); `error` is non-null only on
 * the `error` phase. Pass `over` to pin a phase, byte counts, or a typed failure.
 */
export function makeModelDownloadProgressEvent(
  over: Partial<ModelDownloadProgressEvent> = {},
): ModelDownloadProgressEvent {
  return {
    phase: 'downloading',
    bytesDownloaded: 0,
    totalBytes: 487_601_967,
    error: null,
    ...over,
  };
}

/**
 * Build a per-item transcript view (the `catalog:getTranscript` response, #136).
 * Defaults to a not-yet-transcribed item (`pending`, no text); pass `over` to pin
 * a `done` transcript with text + a detected `language`, or a `failed`/`skipped`
 * outcome.
 */
export function makeTranscriptView(over: Partial<TranscriptViewDTO> = {}): TranscriptViewDTO {
  return {
    status: 'pending',
    language: null,
    text: null,
    segments: [],
    ...over,
  };
}

export interface FakeApi extends KawsayAPI {
  /** Push a progress event to every current onImportProgress subscriber. */
  emitProgress(event: ImportProgressEvent): void;
  /** Number of live import-progress subscribers (asserts clean unsubscribe). */
  subscriberCount(): number;
  /** Push a model-download progress event to every onModelDownloadProgress subscriber. */
  emitModelDownloadProgress(event: ModelDownloadProgressEvent): void;
  /** Number of live model-download-progress subscribers (asserts clean unsubscribe). */
  modelSubscriberCount(): number;
  /** Push a transcription progress snapshot to every onTranscriptionProgress subscriber. */
  emitTranscriptionProgress(event: TranscriptionProgressEvent): void;
  /** Number of live transcription-progress subscribers (asserts clean unsubscribe). */
  transcriptionSubscriberCount(): number;
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
  getThumbnail?: KawsayAPI['getThumbnail'];
  downloadTranscriptionModel?: KawsayAPI['downloadTranscriptionModel'];
  isTranscriptionModelReady?: KawsayAPI['isTranscriptionModelReady'];
  startTranscription?: KawsayAPI['startTranscription'];
  getTranscriptionStatus?: KawsayAPI['getTranscriptionStatus'];
  cancelTranscription?: KawsayAPI['cancelTranscription'];
  getTranscript?: KawsayAPI['getTranscript'];
}

/** A zero transcription tally (the calm default for status/start fakes). */
const ZERO_TRANSCRIPTION_COUNTS = {
  total: 0,
  transcribed: 0,
  failed: 0,
  skipped: 0,
  inFlight: 0,
} as const;

/** Build a fully typed fake KawsayAPI whose methods are spies (vi.fn). */
export function makeFakeApi(opts: FakeApiOptions = {}): FakeApi {
  const listeners = new Set<(event: ImportProgressEvent) => void>();
  const modelListeners = new Set<(event: ModelDownloadProgressEvent) => void>();
  const transcriptionListeners = new Set<(event: TranscriptionProgressEvent) => void>();
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
    // Default to "no thumbnail" (null) so any tile rendered in an existing test
    // simply shows its media-type icon; thumbnail tests inject their own resolver.
    getThumbnail: opts.getThumbnail ?? vi.fn(() => Promise.resolve(null)),
    onImportProgress: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    // Default to "not ready" + "already-present" so transcription-agnostic tests
    // see no model state; #132's consent UI tests inject their own behaviour.
    downloadTranscriptionModel:
      opts.downloadTranscriptionModel ??
      vi.fn(() => Promise.resolve({ status: 'already-present' as const })),
    isTranscriptionModelReady:
      opts.isTranscriptionModelReady ?? vi.fn(() => Promise.resolve(false)),
    onModelDownloadProgress: (listener) => {
      modelListeners.add(listener);
      return () => {
        modelListeners.delete(listener);
      };
    },
    // Default to a calm "nothing to do": idle status, idle start, no-op cancel.
    // #136's transcription UI tests inject their own run behaviour.
    startTranscription:
      opts.startTranscription ??
      vi.fn(() =>
        Promise.resolve({
          outcome: 'idle' as const,
          reason: null,
          counts: { ...ZERO_TRANSCRIPTION_COUNTS },
        }),
      ),
    getTranscriptionStatus:
      opts.getTranscriptionStatus ??
      vi.fn(() =>
        Promise.resolve({
          state: 'idle' as const,
          counts: { ...ZERO_TRANSCRIPTION_COUNTS },
          lastItem: null,
        }),
      ),
    cancelTranscription:
      opts.cancelTranscription ?? vi.fn(() => Promise.resolve({ cancelled: false })),
    // Default to a not-yet-transcribed item so transcription-agnostic tests see a
    // calm "pending" view; #136's item-view tests inject their own transcript.
    getTranscript: opts.getTranscript ?? vi.fn(() => Promise.resolve(makeTranscriptView())),
    onTranscriptionProgress: (listener) => {
      transcriptionListeners.add(listener);
      return () => {
        transcriptionListeners.delete(listener);
      };
    },
    emitProgress: (event) => {
      for (const listener of [...listeners]) listener(event);
    },
    subscriberCount: () => listeners.size,
    emitModelDownloadProgress: (event) => {
      for (const listener of [...modelListeners]) listener(event);
    },
    modelSubscriberCount: () => modelListeners.size,
    emitTranscriptionProgress: (event) => {
      for (const listener of [...transcriptionListeners]) listener(event);
    },
    transcriptionSubscriberCount: () => transcriptionListeners.size,
  };
}
