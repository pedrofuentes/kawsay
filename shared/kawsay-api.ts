/**
 * The entire renderer-facing capability surface exposed on `window.kawsayAPI`
 * by the preload bridge — one method per IPC channel (plus the one event
 * subscription), with no catch-all `send` (ARCHITECTURE §1.3, §2.3). The
 * renderer depends only on this type and never touches Node, Electron, the
 * filesystem, the database, or the network.
 */
import type {
  CategorizationStartResultDTO,
  CategorizationStatusDTO,
  CategorizationCorrectionDTO,
  ItemCategoriesDTO,
  LibrarySummaryDTO,
  SearchResultDTO,
  SettingsDTO,
  SuggestionsViewDTO,
  TimelinePageDTO,
  TranscriptionSnapshotDTO,
  TranscriptionStartResultDTO,
  TranscriptViewDTO,
} from '@shared/ipc/schemas';
import type {
  CategorizationProgressEvent,
  ImportProgressEvent,
  ModelDownloadProgressEvent,
  TranscriptionProgressEvent,
} from '@shared/ipc/events';
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

  /**
   * Fetch a bounded thumbnail for ONE memory by its opaque catalog id (U4).
   * Resolves with a self-contained image `data:` URL, or null when the item is
   * non-visual or can't be rendered. The renderer passes only the id (never a
   * path); the main process resolves + confines the original and caps the bytes,
   * so nothing filesystem- or network-bound crosses the bridge (AC-4).
   */
  getThumbnail(input: { id: string; size?: number }): Promise<string | null>;

  /**
   * Read ONE item's transcript by its opaque catalog id (#136). Resolves the
   * renderer-safe {@link TranscriptViewDTO}: the item's `status` and, when `done`,
   * the spoken `text`, the detected `language` (for the `lang` attribute so a
   * screen reader pronounces it, AC-13), and ms-timed `segments`. The renderer
   * passes only the id (never a path); no audio byte or filesystem path crosses
   * back (AC-4). Audio/video only — callers gate on the item's media type.
   */
  getTranscript(input: { id: string }): Promise<TranscriptViewDTO>;

  /**
   * Set (or clear) one memory's favourite flag by its opaque catalog id (#434,
   * favourite-toggle slice — part of #434). CALLER-INITIATED from the item view's
   * heart toggle only. The renderer passes only the id (never a path); resolves
   * the RESOLVED `isFavourite` so the toggle always reflects what is now
   * persisted on disk, surviving an app restart.
   */
  setFavourite(input: { id: string; favourite: boolean }): Promise<{ isFavourite: boolean }>;

  /**
   * Start an off-thread import; resolves with the new job id AND the `sourceId` this
   * run writes against, so the renderer can later offer an "undo this import" (#429).
   */
  startImport(input: {
    sourceType: SourceType;
    inputPath: string;
  }): Promise<{ jobId: string; sourceId: string }>;
  /** Cooperatively cancel an in-flight import. */
  cancelImport(input: { jobId: string }): Promise<{ cancelled: boolean }>;

  /**
   * Undo an import (#429, AC-14 / P4b): remove EXACTLY what one import added and
   * nothing else. The renderer passes only that import's opaque `sourceId` (never a
   * path); the main process removes that source's occurrences, drops the memories
   * left with no other source, and reclaims only those orphans' copied files — a
   * memory that also came from another source (and its file) survives. Resolves the
   * counts removed. CALLER-INITIATED from the confirm-gated post-import UndoBanner.
   */
  undoImport(input: {
    sourceId: string;
  }): Promise<{ itemsRemoved: number; occurrencesRemoved: number }>;

  /**
   * Open a native folder picker (W2). Resolves with the absolute path the user
   * chose, or `null` if they cancelled. The dialog runs entirely in the main
   * process; only the chosen path string crosses back.
   */
  openDirectory(options?: DialogOpenOptions): Promise<string | null>;
  /** Open a native single-file picker (e.g. an export archive); see openDirectory. */
  openFile(options?: DialogOpenOptions): Promise<string | null>;

  /** Subscribe to the import progress stream; returns an unsubscribe function. */
  onImportProgress(listener: (event: ImportProgressEvent) => void): () => void;

  /**
   * Start the opt-in transcription-model download (AC-17 / ADR-0027). This is the
   * gated capability only — it is CALLER-INITIATED (the consent UI is card #132)
   * and never auto-runs. Resolves as soon as the work is scheduled: `started`
   * means a download is now in flight, `already-present` means a verified model
   * is already on disk. Byte progress and the terminal result arrive via
   * {@link onModelDownloadProgress}; the file never leaves a checksum-verified,
   * atomically-installed state.
   */
  downloadTranscriptionModel(): Promise<{ status: 'started' | 'already-present' }>;

  /**
   * Whether the transcription model is present AND integrity-verified — the
   * capability gate the UI reads before offering transcription.
   */
  isTranscriptionModelReady(): Promise<boolean>;

  /**
   * Subscribe to the model-download progress + terminal stream; returns an
   * unsubscribe function. Mirrors {@link onImportProgress}.
   */
  onModelDownloadProgress(listener: (event: ModelDownloadProgressEvent) => void): () => void;

  /**
   * Start the gated transcription run over the library's audio/video (#157). This
   * is the CALLER-INITIATED capability only — it is DOUBLY gated (refuses unless
   * the user opted in AND the model is present-and-verified) and never auto-runs.
   * Idempotent: items already transcribed are skipped. Resolves with whether a run
   * `started`, there was nothing to do (`idle`), or it was `refused` (with a typed
   * reason) plus the corpus counts. Per-item progress arrives via
   * {@link onTranscriptionProgress}; originals are never touched (AC-14) and the
   * whole run makes no network call (AC-4).
   */
  startTranscription(): Promise<TranscriptionStartResultDTO>;

  /**
   * Query the overall transcription run state (idle/running/complete + counts +
   * the last settled item), so the UI can reflect it on launch.
   */
  getTranscriptionStatus(): Promise<TranscriptionSnapshotDTO>;

  /**
   * Cooperatively cancel the in-flight transcription run; resolves whether one was
   * running. Whatever already completed stays persisted.
   */
  cancelTranscription(): Promise<{ cancelled: boolean }>;

  /**
   * Subscribe to the per-item transcription progress stream; returns an
   * unsubscribe function. Mirrors {@link onImportProgress}.
   */
  onTranscriptionProgress(listener: (event: TranscriptionProgressEvent) => void): () => void;

  /**
   * The smart-search capability snapshot the (opt-in) UI reads (M4-1b / ADR-0029):
   * whether the user `optedIn`, whether the embedder model is present-and-verified
   * (`modelReady`), and whether the feature is even `offered` yet — true ONLY when a
   * real model is published AND this platform can install it. While `offered` is
   * false the whole opt-in surface stays hidden and search remains exact FTS.
   */
  getSmartSearchStatus(): Promise<{ optedIn: boolean; modelReady: boolean; offered: boolean }>;

  /**
   * Opt in to smart search and start the embedder-model download (M4-1b / ADR-0029).
   * CALLER-INITIATED only (the opt-in UI is a later slice) — never auto-runs. Resolves
   * as soon as the work is scheduled: `download-started` means a fetch is now in
   * flight, `already-present` means a verified model is already on disk, and
   * `unsupported-platform` means there is nowhere to install it (search stays exact
   * FTS). Byte progress and the terminal result arrive via
   * {@link onSmartSearchModelDownloadProgress}; the file never leaves a
   * checksum-verified, atomically-installed state.
   */
  enableSmartSearch(): Promise<{
    outcome: 'download-started' | 'already-present' | 'unsupported-platform';
  }>;

  /**
   * Subscribe to the smart-search model-download progress + terminal stream; returns
   * an unsubscribe function. A channel SEPARATE from {@link onModelDownloadProgress}
   * (transcription) so the two downloads never cross-talk, though it reuses the same
   * {@link ModelDownloadProgressEvent} payload shape.
   */
  onSmartSearchModelDownloadProgress(
    listener: (event: ModelDownloadProgressEvent) => void,
  ): () => void;

  /**
   * The opt-in categorization gate snapshot the UI reads (M4-2h / ADR-0030):
   * whether the user `optedIn`, and whether the feature is even `offered` yet —
   * true ONLY when the gazetteer asset is bundled. While `offered` is false the
   * whole opt-in surface stays hidden; while `optedIn` is false NO chips show and
   * no category_status ever transitions (default-off, AC-33).
   */
  getCategorizationStatus(): Promise<CategorizationStatusDTO>;

  /**
   * Persist the categorization opt-in (M4-2h). CALLER-INITIATED from the consent
   * toggle only — never auto-set. Echoes the resolved `{ optedIn }` so the UI can
   * reflect the durable state. Turning it off stops all future chip rendering and
   * status transitions; existing user corrections stay on disk (AC-30).
   */
  setCategorizationConsent(input: { optedIn: boolean }): Promise<{ optedIn: boolean }>;

  /**
   * List ONE item's explainable category chips by its opaque catalog id (#270).
   * Resolves the item's category groupings with their provenance (source/signal/
   * confidence/explanation), USER decisions winning over AUTO. Each chip's `kind` is
   * a {@link CategoryKindDTO} — `person`, `place`, or `theme` per the categories
   * CHECK domain, though the shipped categorizer produces place & theme only. The
   * renderer passes only the id (never a path); returns `[]` when the feature is off
   * or the item is uncategorized. No path or vector crosses back (AC-4).
   */
  listItemCategories(input: { itemId: string }): Promise<ItemCategoriesDTO>;

  /**
   * Apply a user correction — confirm, remove, reassign, or rename — and resolve
   * the item's REFRESHED chips (#270). The user's decision is written as a `user`
   * assignment that a later re-cluster can never clobber (provenance durability,
   * AC-30). Ids are opaque; a malformed correction is rejected at the boundary.
   */
  applyCategoryCorrection(input: CategorizationCorrectionDTO): Promise<ItemCategoriesDTO>;

  /**
   * Start the gated categorization run over the library (#270 / ADR-0030). This is
   * the CALLER-INITIATED capability only — it refuses unless the user opted in AND
   * there is at least one usable signal (the `no-signal` refusal is kind-agnostic —
   * today's signals derive place & theme), and it never auto-runs. Idempotent. Resolves the
   * run result (`completed`/`idle`/`cancelled`/`busy`/`refused` + counts); per-item
   * progress arrives via {@link onCategorizationProgress}. Originals are never
   * touched and the run makes no network call (AC-4).
   */
  startCategorization(): Promise<CategorizationStartResultDTO>;

  /**
   * Cooperatively cancel the in-flight categorization run; resolves whether one was
   * running. Whatever already settled stays persisted.
   */
  cancelCategorization(): Promise<{ cancelled: boolean }>;

  /**
   * Subscribe to the per-item categorization progress stream; returns an
   * unsubscribe function. Mirrors {@link onImportProgress}.
   */
  onCategorizationProgress(listener: (event: CategorizationProgressEvent) => void): () => void;

  /**
   * List the pending SUGGESTED collections for the review tray (#273 / AC-32): each
   * derived place/theme grouping with its proposed name, effective member count, and
   * a few example items, plus the real collections a merge may target. READ-ONLY —
   * calling this creates NO collection, so the main list stays byte-identical until
   * the user explicitly accepts. The DEFAULT-OFF emptiness is enforced RENDERER-side:
   * `useSuggestions` never calls this while the feature is off (opted out or not yet
   * offered) and drops any prior view — the channel itself is a pure projection of
   * whatever the local catalog derives, not a consent self-check. No path or vector
   * crosses back (AC-4).
   */
  listSuggestions(): Promise<SuggestionsViewDTO>;

  /**
   * Accept a suggestion — materialise it into a real collection, optionally renamed
   * first (the tray's edit-before-accept). Resolves the REFRESHED tray view (the
   * accepted suggestion is gone; the new collection appears among the merge targets).
   * Idempotent per category. Ids are opaque; a malformed payload is rejected.
   */
  acceptSuggestion(input: { categoryId: string; name?: string }): Promise<SuggestionsViewDTO>;

  /**
   * Merge a suggestion into an existing collection — its members move into the
   * survivor and the source category is tombstoned so it is not re-proposed (AC-32).
   * Resolves the refreshed tray view.
   */
  mergeSuggestion(input: {
    categoryId: string;
    intoCollectionId: string;
  }): Promise<SuggestionsViewDTO>;

  /**
   * Dismiss a suggestion — drop a durable tombstone so the derivation never
   * re-proposes it, even after a relaunch (AC-32). Resolves the refreshed tray view.
   * Idempotent per category.
   */
  dismissSuggestion(input: { categoryId: string; name?: string }): Promise<SuggestionsViewDTO>;

  /**
   * Read the persisted app-wide UX settings (AC-13 / Journey G, #433): the
   * text-size step and the reduced-motion override. Resolves the durable
   * snapshot the Settings view reads on mount and the app root applies
   * IMMEDIATELY (src/lib/settings.tsx) — no reload needed.
   */
  getSettings(): Promise<SettingsDTO>;

  /**
   * Persist a PARTIAL settings update — just the field a control changed — and
   * resolve the RESOLVED full snapshot, so the caller reconciles with what is
   * actually durable rather than trusting its own optimistic guess. Mirrors
   * `setCategorizationConsent`'s echo-the-truth shape.
   */
  setSettings(input: { textSize?: SettingsDTO['textSize']; reducedMotion?: boolean }): Promise<SettingsDTO>;
}

/**
 * The only options a renderer may influence on a native open dialog: a friendly
 * title and an optional starting directory. Everything else (file-vs-folder mode,
 * filters, …) is fixed in the main process and never accepted from the renderer.
 */
export interface DialogOpenOptions {
  title?: string;
  defaultPath?: string;
}

// Re-exported for the renderer (U1/U2/U3), which imports these DTOs by name.
export type {
  ItemCardDTO,
  ItemCategoryDTO,
  ItemCategoriesDTO,
  CategoryKindDTO,
  AssignmentSourceDTO,
  AssignmentSignalDTO,
  CategorizationCorrectionDTO,
  CategorizationStatusDTO,
  CategorizationCountsDTO,
  CategorizationSnapshotDTO,
  CategorizationStartResultDTO,
  CategorizationRefusalReasonDTO,
  SuggestionsViewDTO,
  SuggestionDTO,
  SuggestionExampleDTO,
  SuggestionMergeTargetDTO,
  SuggestionKindDTO,
  LibrarySummaryDTO,
  SearchResultDTO,
  SettingsDTO,
  TextSizeDTO,
  TimelinePageDTO,
  ImportSummaryDTO,
  SkippedItemDTO,
  TranscriptionSnapshotDTO,
  TranscriptionStartResultDTO,
  TranscriptionCountsDTO,
  TranscriptionRunStateDTO,
  TranscriptionItemStatusDTO,
  TranscriptionRefusalReasonDTO,
  TranscriptViewDTO,
  TranscriptStatusDTO,
  TranscriptSegmentDTO,
} from '@shared/ipc/schemas';
export type { ImportProgressEvent } from '@shared/ipc/events';
export type { ModelDownloadProgressEvent } from '@shared/ipc/events';
export type { TranscriptionProgressEvent } from '@shared/ipc/events';
export type { CategorizationProgressEvent } from '@shared/ipc/events';
export type { SourceType, MediaType } from '@shared/catalog';
