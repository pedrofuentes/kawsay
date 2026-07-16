// Test doubles for the renderer suites: a configurable in-memory KawsayAPI plus
// small DTO builders. The fake never touches Electron/IPC — it just records calls
// and lets a test drive the import-progress stream synchronously via emitProgress.
import { vi } from 'vitest';
import type {
  CategorizationProgressEvent,
  CollectionItemsPageDTO,
  CollectionsListDTO,
  CollectionSummaryDTO,
  ImportProgressEvent,
  ImportSummaryDTO,
  ItemCardDTO,
  ItemCategoryDTO,
  KawsayAPI,
  LibrarySummaryDTO,
  ModelDownloadProgressEvent,
  SearchResultDTO,
  SettingsDTO,
  SuggestionDTO,
  SuggestionsViewDTO,
  TranscriptionProgressEvent,
  TranscriptViewDTO,
} from '@shared/kawsay-api';

/** A stable, valid-looking job id used across import tests. */
export const FAKE_JOB_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
/** A stable, valid-looking source id an import writes against (undo handle, #429). */
export const FAKE_SOURCE_ID = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';

let itemCardSeq = 0;
let itemCategorySeq = 0;
let suggestionSeq = 0;

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

/** Build a persisted UX-settings snapshot (AC-13 / Journey G, #433). Defaults to
 *  the calm baseline (default text size, no reduced-motion override). */
export function makeSettings(over: Partial<SettingsDTO> = {}): SettingsDTO {
  return {
    textSize: 'default',
    reducedMotion: false,
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

/**
 * Build an explainable category chip (the `categorize:listForItem` element, #270).
 * Defaults to an AUTO place assignment near Cusco with a GPS signal + confidence, so
 * a chip test sees a realistic "Auto — near Cusco, Perú (photo GPS) · 0.92" tooltip;
 * the `categoryId` is unique per call so list-key tests get distinct rows — pass
 * `over` (e.g. `{ categoryId }`) to pin any field a test asserts on.
 */
export function makeItemCategory(over: Partial<ItemCategoryDTO> = {}): ItemCategoryDTO {
  itemCategorySeq += 1;
  return {
    categoryId: `10000000-0000-4000-8000-${String(itemCategorySeq).padStart(12, '0')}`,
    kind: 'place',
    name: 'Cusco, Perú',
    source: 'auto',
    signal: 'gps',
    confidence: 0.92,
    explanation: 'Near Cusco, Perú (from photo GPS)',
    ...over,
  };
}

/**
 * Build a suggested-collection card DTO (the `suggestions:list` element, #273).
 * Defaults to a place grouping near Cusco with 12 members and one photo example,
 * so a tray test sees a realistic card; the `categoryId` is unique per call so
 * list-key tests get distinct rows — pass `over` to pin any field a test asserts on.
 */
export function makeSuggestion(over: Partial<SuggestionDTO> = {}): SuggestionDTO {
  suggestionSeq += 1;
  return {
    categoryId: `20000000-0000-4000-8000-${String(suggestionSeq).padStart(12, '0')}`,
    kind: 'place',
    name: 'Cusco, Perú',
    memberCount: 12,
    examples: [
      {
        id: `21000000-0000-4000-8000-${String(suggestionSeq).padStart(12, '0')}`,
        mediaType: 'photo',
        title: 'A quiet afternoon',
        hasThumbnail: true,
      },
    ],
    ...over,
  };
}

/** Build a suggestions-tray view (the `suggestions:list` response, #273). Empty by default. */
export function makeSuggestionsView(over: Partial<SuggestionsViewDTO> = {}): SuggestionsViewDTO {
  return {
    suggestions: over.suggestions ?? [],
    collections: over.collections ?? [],
  };
}

let collectionSeq = 0;

/**
 * Build a collection summary tile (the collections browser view, #437). The id
 * is unique per call so list-key tests get distinct rows; pass `over` (e.g.
 * `{ id }`) to pin any field — including a deterministic id — when a test
 * asserts on it.
 */
export function makeCollectionSummary(over: Partial<CollectionSummaryDTO> = {}): CollectionSummaryDTO {
  collectionSeq += 1;
  return {
    id: `30000000-0000-4000-8000-${String(collectionSeq).padStart(12, '0')}`,
    name: 'A summer by the lake',
    itemCount: 3,
    coverItemId: null,
    ...over,
  };
}

/** Build a `catalog:listCollections` response. Empty by default. */
export function makeCollectionsListView(over: Partial<CollectionsListDTO> = {}): CollectionsListDTO {
  return { collections: over.collections ?? [] };
}

/** Build a `catalog:getCollection` response page; `total` defaults to the
 *  number of items given (a single, un-paginated page). */
export function makeCollectionItemsPage(
  over: Partial<CollectionItemsPageDTO> = {},
): CollectionItemsPageDTO {
  const items = over.items ?? [];
  return {
    collection: over.collection ?? makeCollectionSummary(),
    items,
    total: over.total ?? items.length,
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
  /** Push a progress event to every onSmartSearchModelDownloadProgress subscriber. */
  emitSmartSearchModelDownloadProgress(event: ModelDownloadProgressEvent): void;
  /** Number of live smart-search-model-download subscribers (asserts clean unsubscribe). */
  smartSearchModelSubscriberCount(): number;
  /** Push a transcription progress snapshot to every onTranscriptionProgress subscriber. */
  emitTranscriptionProgress(event: TranscriptionProgressEvent): void;
  /** Number of live transcription-progress subscribers (asserts clean unsubscribe). */
  transcriptionSubscriberCount(): number;
  /** Push a categorization snapshot to every onCategorizationProgress subscriber. */
  emitCategorizationProgress(event: CategorizationProgressEvent): void;
  /** Number of live categorization-progress subscribers (asserts clean unsubscribe). */
  categorizationSubscriberCount(): number;
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
  undoImport?: KawsayAPI['undoImport'];
  openDirectory?: KawsayAPI['openDirectory'];
  openFile?: KawsayAPI['openFile'];
  getThumbnail?: KawsayAPI['getThumbnail'];
  downloadTranscriptionModel?: KawsayAPI['downloadTranscriptionModel'];
  isTranscriptionModelReady?: KawsayAPI['isTranscriptionModelReady'];
  startTranscription?: KawsayAPI['startTranscription'];
  getTranscriptionStatus?: KawsayAPI['getTranscriptionStatus'];
  cancelTranscription?: KawsayAPI['cancelTranscription'];
  getTranscript?: KawsayAPI['getTranscript'];
  setFavourite?: KawsayAPI['setFavourite'];
  getSmartSearchStatus?: KawsayAPI['getSmartSearchStatus'];
  enableSmartSearch?: KawsayAPI['enableSmartSearch'];
  getSettings?: KawsayAPI['getSettings'];
  setSettings?: KawsayAPI['setSettings'];
  getCategorizationStatus?: KawsayAPI['getCategorizationStatus'];
  setCategorizationConsent?: KawsayAPI['setCategorizationConsent'];
  listItemCategories?: KawsayAPI['listItemCategories'];
  applyCategoryCorrection?: KawsayAPI['applyCategoryCorrection'];
  startCategorization?: KawsayAPI['startCategorization'];
  cancelCategorization?: KawsayAPI['cancelCategorization'];
  listSuggestions?: KawsayAPI['listSuggestions'];
  acceptSuggestion?: KawsayAPI['acceptSuggestion'];
  mergeSuggestion?: KawsayAPI['mergeSuggestion'];
  dismissSuggestion?: KawsayAPI['dismissSuggestion'];
  listCollections?: KawsayAPI['listCollections'];
  getCollection?: KawsayAPI['getCollection'];
  getCapabilities?: KawsayAPI['getCapabilities'];
}

/** A zero transcription tally (the calm default for status/start fakes). */
const ZERO_TRANSCRIPTION_COUNTS = {
  total: 0,
  transcribed: 0,
  failed: 0,
  skipped: 0,
  inFlight: 0,
} as const;

/** A zero categorization tally (the calm default for status/start fakes, #270). */
const ZERO_CATEGORIZATION_COUNTS = {
  categorized: 0,
  skipped: 0,
  failed: 0,
  inFlight: 0,
} as const;

/** Build a fully typed fake KawsayAPI whose methods are spies (vi.fn). */
export function makeFakeApi(opts: FakeApiOptions = {}): FakeApi {
  const listeners = new Set<(event: ImportProgressEvent) => void>();
  const modelListeners = new Set<(event: ModelDownloadProgressEvent) => void>();
  const smartSearchModelListeners = new Set<(event: ModelDownloadProgressEvent) => void>();
  const transcriptionListeners = new Set<(event: TranscriptionProgressEvent) => void>();
  const categorizationListeners = new Set<(event: CategorizationProgressEvent) => void>();
  const jobId = opts.jobId ?? FAKE_JOB_ID;

  return {
    getAppVersion: vi.fn(() => Promise.resolve(opts.appVersion ?? '0.1.0')),
    getCapabilities:
      opts.getCapabilities ??
      vi.fn(() =>
        Promise.resolve({
          ffmpeg: true,
          ffprobe: true,
          clusterWorker: true,
          embedder: true,
          gazetteer: true,
        }),
      ),
    createLibrary:
      opts.createLibrary ??
      vi.fn((input: { path: string; personName?: string }) =>
        Promise.resolve(
          makeLibrarySummary({ root: input.path, name: input.personName ?? 'Library' }),
        ),
      ),
    openLibrary:
      opts.openLibrary ??
      vi.fn((input: { path: string }) => Promise.resolve(makeLibrarySummary({ root: input.path }))),
    getTimeline: opts.getTimeline ?? vi.fn(() => Promise.resolve({ items: [], nextCursor: null })),
    searchCatalog: opts.searchCatalog ?? vi.fn(() => Promise.resolve({ items: [], total: 0 })),
    startImport:
      opts.startImport ?? vi.fn(() => Promise.resolve({ jobId, sourceId: FAKE_SOURCE_ID })),
    cancelImport: opts.cancelImport ?? vi.fn(() => Promise.resolve({ cancelled: true })),
    undoImport:
      opts.undoImport ?? vi.fn(() => Promise.resolve({ itemsRemoved: 0, occurrencesRemoved: 0 })),
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
    // Default echoes back whatever the caller asked for, mirroring the real main
    // process's resolved-state echo (#434); favourite-toggle tests inject their
    // own behaviour to exercise a failed save / a divergent echo.
    setFavourite:
      opts.setFavourite ??
      vi.fn((input: { id: string; favourite: boolean }) =>
        Promise.resolve({ isFavourite: input.favourite }),
      ),
    onTranscriptionProgress: (listener) => {
      transcriptionListeners.add(listener);
      return () => {
        transcriptionListeners.delete(listener);
      };
    },
    // Smart-search opt-in (M4-1b) — the renderer UI (UI-2) drives this the same way
    // the transcription card drives onModelDownloadProgress: a real subscriber set +
    // an emitter helper below. Defaults stay calm: not offered, nothing installed.
    getSmartSearchStatus:
      opts.getSmartSearchStatus ??
      vi.fn(() => Promise.resolve({ optedIn: false, modelReady: false, offered: false })),
    enableSmartSearch:
      opts.enableSmartSearch ??
      vi.fn(() => Promise.resolve({ outcome: 'unsupported-platform' as const })),
    onSmartSearchModelDownloadProgress: (listener) => {
      smartSearchModelListeners.add(listener);
      return () => {
        smartSearchModelListeners.delete(listener);
      };
    },
    // App-wide UX settings (AC-13 / Journey G, #433) — text size + reduced-motion
    // override. Defaults stay calm (default size, no override); `setSettings`
    // mirrors the real main process's merge-and-echo: it folds the patch onto
    // whatever was last read/written by THIS fake so a test's round trip behaves
    // like the durable store without needing its own state machine.
    getSettings: opts.getSettings ?? vi.fn(() => Promise.resolve(makeSettings())),
    setSettings:
      opts.setSettings ??
      vi.fn((patch: Partial<SettingsDTO>) => Promise.resolve(makeSettings(patch))),
    // Categorization opt-in (M4-2h / #270) — the explainable-chips + consent UI drive
    // these the same way transcription drives its run methods. Defaults stay calm and
    // DEFAULT-OFF: not offered, not opted in, no chips, an idle run, a no-op cancel.
    getCategorizationStatus:
      opts.getCategorizationStatus ??
      vi.fn(() => Promise.resolve({ optedIn: false, offered: false })),
    setCategorizationConsent:
      opts.setCategorizationConsent ??
      vi.fn((input: { optedIn: boolean }) => Promise.resolve({ optedIn: input.optedIn })),
    listItemCategories: opts.listItemCategories ?? vi.fn(() => Promise.resolve([])),
    applyCategoryCorrection: opts.applyCategoryCorrection ?? vi.fn(() => Promise.resolve([])),
    startCategorization:
      opts.startCategorization ??
      vi.fn(() =>
        Promise.resolve({
          outcome: 'idle' as const,
          reason: null,
          counts: { ...ZERO_CATEGORIZATION_COUNTS },
        }),
      ),
    cancelCategorization:
      opts.cancelCategorization ?? vi.fn(() => Promise.resolve({ cancelled: false })),
    onCategorizationProgress: (listener) => {
      categorizationListeners.add(listener);
      return () => {
        categorizationListeners.delete(listener);
      };
    },
    // Suggested-collections review tray (M4-3c / #273). Defaults stay calm and
    // DEFAULT-OFF: an empty tray (no suggestions, no merge targets), and curation
    // actions that echo an empty refreshed view. Tray tests inject their own view.
    listSuggestions:
      opts.listSuggestions ?? vi.fn(() => Promise.resolve({ suggestions: [], collections: [] })),
    acceptSuggestion:
      opts.acceptSuggestion ?? vi.fn(() => Promise.resolve({ suggestions: [], collections: [] })),
    mergeSuggestion:
      opts.mergeSuggestion ?? vi.fn(() => Promise.resolve({ suggestions: [], collections: [] })),
    dismissSuggestion:
      opts.dismissSuggestion ?? vi.fn(() => Promise.resolve({ suggestions: [], collections: [] })),
    // Collections browser view (#437) — both READ-ONLY. Defaults stay calm: an
    // empty collections list, and a not-found-shaped page (collections tests
    // inject their own list/page as needed).
    listCollections: opts.listCollections ?? vi.fn(() => Promise.resolve({ collections: [] })),
    getCollection:
      opts.getCollection ??
      vi.fn((input: { id: string; limit: number; offset?: number }) =>
        Promise.resolve({
          collection: makeCollectionSummary({ id: input.id, itemCount: 0 }),
          items: [],
          total: 0,
        }),
      ),
    emitProgress: (event) => {
      for (const listener of [...listeners]) listener(event);
    },
    subscriberCount: () => listeners.size,
    emitModelDownloadProgress: (event) => {
      for (const listener of [...modelListeners]) listener(event);
    },
    modelSubscriberCount: () => modelListeners.size,
    emitSmartSearchModelDownloadProgress: (event) => {
      for (const listener of [...smartSearchModelListeners]) listener(event);
    },
    smartSearchModelSubscriberCount: () => smartSearchModelListeners.size,
    emitTranscriptionProgress: (event) => {
      for (const listener of [...transcriptionListeners]) listener(event);
    },
    transcriptionSubscriberCount: () => transcriptionListeners.size,
    emitCategorizationProgress: (event) => {
      for (const listener of [...categorizationListeners]) listener(event);
    },
    categorizationSubscriberCount: () => categorizationListeners.size,
  };
}
