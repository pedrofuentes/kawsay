import { EMBED_MODEL_ID } from '../search/embed-cli';
import { decodeVector } from '../db/embeddings-repo';
import type { CatalogDatabase } from '../db/connection';
import type { AutoAssignmentInput, CategoriesRepo } from './categories-repo';
import type { Gazetteer } from './gazetteer';
import type { GpsPoint, PlacesClusterOptions, PlacesClusterResult } from './places-cluster';
import type {
  ThemeClusterItem,
  ThemeClusteringOptions,
  ThemeClusteringResult,
} from './themes-cluster';
import {
  deriveThemeLabels,
  type DeriveThemeLabelsOptions,
  type ThemeLabelCorpusItem,
} from './theme-labels';

// The categorization ORCHESTRATOR (T-M4-2g, ADR-0030) — the integration point of the
// M4-2 auto-categorizer. It drains items whose `category_status = 'pending'`, groups
// them into PLACE categories (GPS → DBSCAN clusters → gazetteer reverse-geocode) and
// THEME categories (embeddings → cosine agglomeration → salient-term labels), upserts
// each category by its stable `source_key`, and writes AUTO assignments with a machine
// `signal`, a `confidence`, and a human `explanation`.
//
// It MIRRORS the embedding orchestrator's shape exactly — NEVER auto-starts, GATED by a
// typed UNAVAILABLE sentinel (refuse with NO side effects when categorization is not
// opted-in OR no signal/asset is present), RESILIENT (a per-item / per-cluster / whole-
// pass failure is recorded and the run carries on — one bad item never aborts the
// drain), COOPERATIVELY CANCELLABLE (a fired cancel/AbortSignal stops between items;
// whatever already settled stays saved, the rest stay `pending`), SINGLE-FLIGHT (a
// second concurrent run is a calm no-op), and ZERO-EGRESS (every collaborator is local;
// originals are never touched — only catalogued GPS + already-computed embeddings are
// read). Every collaborator is injected (the store, the categories repo, the gazetteer
// reader, the cluster transport, the progress sink, an optional cancel signal) so it
// unit-tests with fakes + a real in-memory DB, no Electron runtime.
//
// COMPOSITION with the embedding drain is EMBED-FIRST, CATEGORIZE-SECOND: only rows the
// embedding orchestrator already flipped to `embed_status = 'done'` contribute a vector
// to the themes pass — a still-pending embed is simply not yet themeable.
//
// OFF-THREAD (ADR-0030 Decision 6): the two CPU-bound cluster passes (haversine DBSCAN
// + cosine agglomeration) run through the injected {@link ClusterTransport}, which in
// production marshals them to a worker_thread (see `categorization-worker.ts`); tests
// inject an inline transport so no real thread is spawned. Theme LABELLING stays on the
// main thread — it needs the corpus text, which never has to cross the thread boundary.

// ── The opt-in gate (mirrors the parameterized transcription consent store) ───

/**
 * The consent-store key for the categorization feature opt-in. A SEPARATE key ⇒ a
 * SEPARATE opt-in from transcription/embedding; default OPTED-OUT for an absent or
 * corrupt config. The opt-in UI + IPC wiring is the successor slice (#270).
 */
export const CATEGORIZATION_CONSENT_KEY = 'categorizationOptedIn';

/** Human-readable label for the categorization opt-in (surfaced by the #270 UI). */
export const CATEGORIZATION_CONSENT_LABEL = 'categorization';

/** WHY categorization refused to run — the typed UNAVAILABLE sentinel reason. */
export type CategorizationUnavailableReason = 'not-opted-in' | 'no-signal';

/**
 * The gate result, shaped exactly like `embed-cli`'s `EmbedderStatus`: available, or
 * unavailable with a typed reason. An unavailable status makes {@link run} REFUSE with
 * no side effects (no read, no write, no drain).
 */
export type CategorizationStatus =
  { available: true } | { available: false; reason: CategorizationUnavailableReason };

/**
 * Resolve the gate from the opt-in flag and which signals/assets are present. Refuses
 * `not-opted-in` when the user has not consented, `no-signal` when opted-in but neither
 * a place signal (GPS + gazetteer asset) nor a theme signal (embeddings) is available.
 * Pure — the production caller reads the consent store + asset checks and passes booleans.
 */
export function resolveCategorizationStatus(input: {
  optedIn: boolean;
  placesAvailable: boolean;
  themesAvailable: boolean;
}): CategorizationStatus {
  if (!input.optedIn) return { available: false, reason: 'not-opted-in' };
  if (!input.placesAvailable && !input.themesAvailable) {
    return { available: false, reason: 'no-signal' };
  }
  return { available: true };
}

// ── The off-thread cluster transport contract ────────────────────────────────

/** One round-trip of clustering work: whichever passes have input for this run. */
export interface ClusterRequest {
  /** The places DBSCAN pass over items with catalogued GPS. */
  places?: { points: GpsPoint[]; options?: PlacesClusterOptions };
  /** The themes cosine-agglomeration pass over items with a done embedding. */
  themes?: { items: ThemeClusterItem[]; options?: ThemeClusteringOptions };
}

/** The clustered reply — one result per requested pass. */
export interface ClusterResponse {
  places?: PlacesClusterResult;
  themes?: ThemeClusteringResult;
}

/**
 * The seam the orchestrator drives to run the CPU-bound cluster passes off the main
 * thread. Production marshals to a worker_thread; tests run it inline. A rejected
 * promise is treated as a whole-pass failure (every read item → `error`).
 */
export interface ClusterTransport {
  run(request: ClusterRequest): Promise<ClusterResponse>;
}

// ── The category_status store (a structural subset of the catalog) ────────────

/** One categorizable item: its GPS (nullable), its label text, and its done embedding (nullable). */
export interface CategorizableItem {
  id: string;
  gpsLat: number | null;
  gpsLon: number | null;
  description: string | null;
  searchMeta: string | null;
  /** The decoded embedding vector — present ONLY when `embed_status = 'done'`. */
  embedding: Float32Array | null;
}

/** The `category_status` drain the orchestrator drives (mirrors the EmbeddingStore subset). */
export interface CategorizationStore {
  /**
   * The next pending items after `afterId` (exclusive) in ascending id order — a
   * KEYSET page. Clustering is GLOBAL, so the orchestrator accumulates every page
   * BEFORE marking any item (unlike the embedding drain's page-and-settle loop).
   */
  listPendingCategorization(afterId: string | null, limit: number): CategorizableItem[];
  /** Mark an item DONE (category_status → 'done') — folded into every applicable cluster. */
  markCategorized(itemId: string): void;
  /**
   * Mark an item's drain FAILED (category_status → 'error'). Semi-terminal:
   * `error` items leave the pending set (the pending keyset lists only
   * `category_status='pending'`) and no drain path resets them, so a subsequent
   * run does NOT re-drive them (mirrors the embedding-orchestrator convention).
   * An explicit reset (successor slice) is required to retry.
   */
  markCategoryFailed(itemId: string): void;
  /** Mark an item SKIPPED (category_status → 'skipped') — no GPS and no embedding. */
  markCategorySkipped(itemId: string): void;
}

// ── Run tallies / snapshot / outcome (mirrors the embedding orchestrator) ─────

/** How many pending items are pulled per keyset page. */
export const DEFAULT_CATEGORIZE_BATCH_SIZE = 500;

/**
 * The auto-confidence for a GPS place assignment. HIGH and deliberately above a theme
 * label's confidence: a gazetteer place is a crisp geographic fact, whereas a theme is
 * a fuzzy salient-term guess (ADR-0030 Decision 4). In [0, 1] per the assignment CHECK.
 */
export const PLACE_ASSIGNMENT_CONFIDENCE = 0.9;

/** The terminal status a single item settles as within a run. */
export type CategorizationItemStatus = 'categorized' | 'skipped' | 'failed';

/** Running totals for a drain. */
export interface CategorizationRunCounts {
  /** Items folded into ≥1 category (category_status → 'done'). */
  categorized: number;
  /** Items with no GPS and no embedding (category_status → 'skipped'). */
  skipped: number;
  /** Items whose categorization failed (category_status → 'error'). */
  failed: number;
  /** Items currently being clustered (the in-flight corpus); 0 outside the pass. */
  inFlight: number;
}

/** A calm progress snapshot streamed to the renderer (the #270 IPC wires the sink). */
export interface CategorizationRunSnapshot {
  state: 'idle' | 'running' | 'complete';
  counts: CategorizationRunCounts;
  lastItem: { id: string; status: CategorizationItemStatus } | null;
}

/** The outcome of a {@link CategorizationOrchestrator.run}. */
export type CategorizationRunOutcome =
  /** Drained ≥1 item to a terminal status. */
  | 'completed'
  /** Nothing was pending — a calm no-op. */
  | 'idle'
  /** A cooperative cancel stopped the drain; partial work persisted. */
  | 'cancelled'
  /** Categorization is UNAVAILABLE (opted-out / no signal) — refused with no side effects. */
  | 'refused'
  /** A run was already in flight — single-flight guard. */
  | 'busy';

/** The result of a run: its outcome, a refusal `reason` (only when refused), and the tally. */
export interface CategorizationRunResult {
  outcome: CategorizationRunOutcome;
  reason: CategorizationUnavailableReason | null;
  counts: CategorizationRunCounts;
}

/** Collaborators for {@link createCategorizationOrchestrator} (all injected for testability). */
export interface CategorizationOrchestratorOptions {
  /** The category_status drain (the catalog store in production). */
  store: CategorizationStore;
  /** The categories + assignments repo (upsert category, write auto assignment). */
  categories: CategoriesRepo;
  /** The reverse-geocoder for place clusters (degrades to no label when the asset is absent). */
  gazetteer: Gazetteer;
  /** The off-thread cluster transport (worker_thread in prod, inline in tests). */
  transport: ClusterTransport;
  /**
   * Resolves the gate fresh at run(). An UNAVAILABLE result (opted-out / no signal)
   * makes the run REFUSE with no side effects.
   */
  getStatus: () => CategorizationStatus;
  /** Pending items per keyset page. */
  batchSize?: number;
  /** Tuning for the places DBSCAN pass. */
  placesOptions?: PlacesClusterOptions;
  /** Tuning for the themes agglomeration pass. */
  themesOptions?: ThemeClusteringOptions;
  /** Tuning for theme-label derivation. */
  labelOptions?: DeriveThemeLabelsOptions;
  /** Sinks a progress snapshot (the renderer event sender in prod; #270 wires it). */
  onProgress?: (snapshot: CategorizationRunSnapshot) => void;
  /** An external cooperative cancel; the built-in {@link CategorizationOrchestrator.cancel} also stops the run. */
  signal?: AbortSignal;
}

export interface CategorizationOrchestrator {
  /** Drain every pending item into its place/theme categories (gated, resilient, cancellable). */
  run(): Promise<CategorizationRunResult>;
  /** Cooperatively cancel the in-flight run (it stops before the next item). */
  cancel(): { cancelled: boolean };
  /** The current run snapshot (state + counts + last settled item). */
  status(): CategorizationRunSnapshot;
}

/**
 * Build the label text of an item: the non-empty parts of its `description` and
 * `searchMeta`, joined. Returns `null` when the item has NO text (both null/blank) —
 * the theme corpus then carries an empty string for it, and it still clusters purely by
 * its vector. Mirrors the embedding orchestrator's `buildPassageText`.
 */
export function buildCategorizeText(item: {
  description: string | null;
  searchMeta: string | null;
}): string | null {
  const parts = [item.description, item.searchMeta]
    .map((part) => (part === null ? '' : part.trim()))
    .filter((part) => part.length > 0);
  return parts.length === 0 ? null : parts.join('\n');
}

function zeroCounts(): CategorizationRunCounts {
  return { categorized: 0, skipped: 0, failed: 0, inFlight: 0 };
}

/** A coordinate label fallback when the gazetteer yields an empty display string. */
function coordLabel(centroid: { lat: number; lon: number }): string {
  return `${centroid.lat.toFixed(4)}, ${centroid.lon.toFixed(4)}`;
}

/** Clamp a cosine similarity ([-1, 1]) into the assignment confidence range [0, 1]. */
function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/**
 * A privacy-preserving diagnostic projection of an error for a LOCAL console line
 * (no telemetry, no egress): only the error `name` and an optional errno `code` —
 * never the raw `message`/`stack`, which can carry a file path or item text. Mirrors
 * the transcription orchestrator's helper so the two orchestrators log worker faults
 * the same shape.
 */
function diagnosticError(error: unknown): { code?: string; name: string } {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === undefined ? { name: error.name } : { name: error.name, code };
  }
  return { name: typeof error };
}

export function createCategorizationOrchestrator(
  options: CategorizationOrchestratorOptions,
): CategorizationOrchestrator {
  const { store, categories, gazetteer, transport, getStatus, onProgress, signal } = options;
  const batchSize = Math.max(1, options.batchSize ?? DEFAULT_CATEGORIZE_BATCH_SIZE);
  const placesOptions = options.placesOptions;
  const themesOptions = options.themesOptions;
  const labelOptions = options.labelOptions;

  let counts = zeroCounts();
  let lastItem: CategorizationRunSnapshot['lastItem'] = null;
  let running = false;
  let cancelled = false;
  let completed = false;

  function isCancelled(): boolean {
    return cancelled || signal?.aborted === true;
  }

  function computeState(): CategorizationRunSnapshot['state'] {
    if (running) return 'running';
    return completed ? 'complete' : 'idle';
  }

  function snapshot(): CategorizationRunSnapshot {
    return {
      state: computeState(),
      counts: { ...counts },
      lastItem: lastItem === null ? null : { ...lastItem },
    };
  }

  function emit(): void {
    onProgress?.(snapshot());
  }

  function tally(id: string, status: CategorizationItemStatus): void {
    if (status === 'categorized') counts = { ...counts, categorized: counts.categorized + 1 };
    else if (status === 'failed') counts = { ...counts, failed: counts.failed + 1 };
    else counts = { ...counts, skipped: counts.skipped + 1 };
    lastItem = { id, status };
    emit();
  }

  /** Mark an item done and count it; even the marker write is contained (resilience). */
  function recordCategorized(id: string): void {
    try {
      store.markCategorized(id);
    } catch {
      // A marker write can itself throw (disk full); the run still carries on. The item
      // is COUNTED as settled so the run reaches a terminal state rather than stalling —
      // the on-disk status is left 'pending' for an idempotent retry on the next run.
    }
    tally(id, 'categorized');
  }

  /** Mark an item failed and count it; the marker write is contained. */
  function recordFailed(id: string): void {
    try {
      store.markCategoryFailed(id);
    } catch {
      // Contained for the same resilience reason as recordCategorized.
    }
    tally(id, 'failed');
  }

  /** Mark an item skipped and count it; the marker write is contained. */
  function recordSkipped(id: string): void {
    try {
      store.markCategorySkipped(id);
    } catch {
      // Contained for the same resilience reason as recordCategorized.
    }
    tally(id, 'skipped');
  }

  /** Read every pending item via the keyset (clustering needs the whole corpus at once). */
  function readAllPending(): CategorizableItem[] {
    const items: CategorizableItem[] = [];
    let afterId: string | null = null;
    for (;;) {
      const page = store.listPendingCategorization(afterId, batchSize);
      if (page.length === 0) break;
      for (const item of page) items.push(item);
      afterId = page[page.length - 1].id;
      if (page.length < batchSize) break;
    }
    return items;
  }

  /**
   * Turn the place clusters into a per-item assignment plan: reverse-geocode each
   * centroid, upsert a `place` category by its `place:<geonameid>` source key, and plan
   * a `gps` auto-assignment for every member. A cluster the gazetteer cannot label is
   * skipped (degrade); a category upsert that throws errors just that cluster's members.
   */
  function planPlaces(
    result: PlacesClusterResult | undefined,
    errored: Set<string>,
  ): Map<string, AutoAssignmentInput> {
    const plan = new Map<string, AutoAssignmentInput>();
    if (result === undefined) return plan;
    for (const cluster of result.clusters) {
      const geo = gazetteer.reverseGeocode(cluster.centroid);
      if (geo === null) continue; // no gazetteer asset / no label → cluster yields no place
      const label = geo.label !== '' ? geo.label : coordLabel(cluster.centroid);
      let categoryId: string;
      try {
        categoryId = categories.upsertCategory({
          kind: 'place',
          name: label,
          sourceKey: geo.sourceKey,
        });
      } catch {
        for (const id of cluster.memberIds) errored.add(id);
        continue;
      }
      const explanation = `Near ${label} (from photo GPS)`;
      for (const id of cluster.memberIds) {
        plan.set(id, {
          itemId: id,
          categoryId,
          signal: 'gps',
          confidence: PLACE_ASSIGNMENT_CONFIDENCE,
          explanation,
        });
      }
    }
    return plan;
  }

  /**
   * Turn the theme clusters into a per-item assignment plan: derive salient-term labels
   * from the corpus text (on THIS thread), upsert a `theme` category by its membership
   * `source_key`, and plan a `theme-cluster` auto-assignment per member (confidence =
   * the member's clamped cosine to the centroid). Labelling is best-effort — a corpus it
   * cannot label falls back to a size-based name and never aborts the run.
   */
  function planThemes(
    result: ThemeClusteringResult | undefined,
    items: readonly CategorizableItem[],
    errored: Set<string>,
  ): Map<string, AutoAssignmentInput> {
    const plan = new Map<string, AutoAssignmentInput>();
    if (result === undefined || result.clusters.length === 0) return plan;

    const corpus: ThemeLabelCorpusItem[] = items
      .filter((item) => item.embedding !== null)
      .map((item) => ({ id: item.id, text: buildCategorizeText(item) ?? '' }));
    const labelClusters = result.clusters.map((cluster) => ({
      sourceKey: cluster.sourceKey,
      memberIds: cluster.members.map((member) => member.id),
    }));
    let labelBySourceKey = new Map<string, string>();
    try {
      const { labels } = deriveThemeLabels(labelClusters, corpus, labelOptions);
      labelBySourceKey = new Map(labels.map((label) => [label.sourceKey, label.label]));
    } catch {
      // A labelling fault (a malformed corpus) never aborts categorization — the clusters
      // still upsert with a size-based fallback name and get their assignments.
    }

    for (const cluster of result.clusters) {
      const labelText = labelBySourceKey.get(cluster.sourceKey) ?? '';
      const name = labelText !== '' ? labelText : `${cluster.size} similar items`;
      let categoryId: string;
      try {
        categoryId = categories.upsertCategory({
          kind: 'theme',
          name,
          sourceKey: cluster.sourceKey,
        });
      } catch {
        for (const member of cluster.members) errored.add(member.id);
        continue;
      }
      const explanation =
        labelText !== ''
          ? `Grouped with ${cluster.size} similar items — ${labelText}`
          : `Grouped with ${cluster.size} similar items`;
      for (const member of cluster.members) {
        plan.set(member.id, {
          itemId: member.id,
          categoryId,
          signal: 'theme-cluster',
          confidence: clamp01(member.similarity),
          explanation,
        });
      }
    }
    return plan;
  }

  async function drain(): Promise<void> {
    // 1. Accumulate the whole pending corpus (clustering is global) before any write.
    const items = readAllPending();
    if (items.length === 0) return; // nothing pending → idle
    if (isCancelled()) return; // cancelled before any work → all stay pending

    // 2. Partition by available signal. Themes consume ONLY done embeddings, so the
    //    themes pass is inherently embed-first (a pending-embed item has no vector here).
    const gpsItems = items.filter((item) => item.gpsLat !== null && item.gpsLon !== null);
    const themeItems = items.filter((item) => item.embedding !== null);

    const request: ClusterRequest = {};
    if (gpsItems.length > 0) {
      request.places = {
        points: gpsItems.map((item) => ({
          id: item.id,
          lat: item.gpsLat as number,
          lon: item.gpsLon as number,
        })),
        ...(placesOptions !== undefined ? { options: placesOptions } : {}),
      };
    }
    if (themeItems.length > 0) {
      request.themes = {
        items: themeItems.map((item) => ({ id: item.id, vector: item.embedding as Float32Array })),
        ...(themesOptions !== undefined ? { options: themesOptions } : {}),
      };
    }

    // 3. Off-thread clustering — a single round-trip. Skip it entirely when no item
    //    carries a signal (the whole corpus then drains to 'skipped').
    let response: ClusterResponse = {};
    if (request.places !== undefined || request.themes !== undefined) {
      const distinct = new Set<string>();
      for (const item of gpsItems) distinct.add(item.id);
      for (const item of themeItems) distinct.add(item.id);
      counts = { ...counts, inFlight: distinct.size };
      emit();
      try {
        response = await transport.run(request);
      } catch (error) {
        // A whole-run clustering failure (worker crash / timeout) is the corpus-scale
        // analogue of the embedding drain's per-batch failure: mark every read item
        // 'error' and carry on. Semi-terminal — errors leave the pending set; an
        // explicit reset (successor slice) is required to retry. Leave a LOCAL
        // diagnostic (no telemetry) so the fault is not swallowed silently — a
        // field report can then distinguish a worker crash from a clean drain; the
        // raw error is projected to name/code only (never message/stack), so no
        // path or item text leaks off the log line (#374). Semgrep's unsafe-formatstring
        // (CWE-134) match on the message below is a false positive: a JS template literal
        // is not a printf format string, and `items.length` is an internal count (a
        // number), never user/attacker input (#406).
        console.warn(
          `[kawsay] categorization clustering pass failed; marking ${items.length} item(s) as error`, // nosemgrep: unsafe-formatstring
          diagnosticError(error),
        );
        counts = { ...counts, inFlight: 0 };
        for (const item of items) recordFailed(item.id);
        return;
      }
      counts = { ...counts, inFlight: 0 };
    }
    if (isCancelled()) return; // cancelled during clustering → nothing written, all stay pending

    // 4. Build per-item assignment plans (resilient per-cluster).
    const errored = new Set<string>();
    const placePlan = planPlaces(response.places, errored);
    const themePlan = planThemes(response.themes, items, errored);

    // 5. Drain each item to a terminal status (resilient per-item, cancel-checked).
    for (const item of items) {
      if (isCancelled()) return; // stop cleanly; the unprocessed rest stay 'pending'
      if (errored.has(item.id)) {
        recordFailed(item.id);
        continue;
      }
      const assignments: AutoAssignmentInput[] = [];
      const place = placePlan.get(item.id);
      if (place !== undefined) assignments.push(place);
      const theme = themePlan.get(item.id);
      if (theme !== undefined) assignments.push(theme);

      if (assignments.length > 0) {
        try {
          for (const assignment of assignments) categories.assignAuto(assignment);
        } catch {
          // A single item's assignment write failed — error just this item and carry on.
          recordFailed(item.id);
          continue;
        }
        recordCategorized(item.id);
      } else if ((item.gpsLat !== null && item.gpsLon !== null) || item.embedding !== null) {
        // Had a signal but joined no cluster (DBSCAN noise / below the theme threshold):
        // it is fully processed, so it drains to 'done' rather than looping next run.
        recordCategorized(item.id);
      } else {
        // No GPS and no embedding → nothing to categorize.
        recordSkipped(item.id);
      }
    }
  }

  return {
    async run() {
      // Single-flight: a second concurrent run is a calm no-op. Set synchronously before
      // the first await so a re-entrant call sees it.
      if (running) {
        return { outcome: 'busy', reason: null, counts: { ...counts } };
      }

      // Gate: resolve the status fresh. UNAVAILABLE (opted-out / no signal) → refuse with
      // NO side effects (no read, no write, no drain).
      const status = getStatus();
      if (!status.available) {
        return { outcome: 'refused', reason: status.reason, counts: zeroCounts() };
      }

      running = true;
      cancelled = false;
      completed = false;
      counts = zeroCounts();
      lastItem = null;
      emit(); // running, zero counts

      try {
        await drain();
      } finally {
        running = false;
      }

      const settledAny = counts.categorized + counts.failed + counts.skipped > 0;
      let outcome: CategorizationRunOutcome;
      if (isCancelled()) {
        outcome = 'cancelled';
      } else if (settledAny) {
        outcome = 'completed';
        completed = true;
      } else {
        outcome = 'idle';
      }
      emit(); // terminal snapshot (state: complete | idle)
      return { outcome, reason: null, counts: { ...counts } };
    },

    cancel() {
      if (!running) return { cancelled: false };
      // Cooperative: the drain loop checks isCancelled() between items and stops; whatever
      // already settled stays saved, the unprocessed rest stay 'pending'.
      cancelled = true;
      return { cancelled: true };
    },

    status() {
      return snapshot();
    },
  };
}

// ── The real store over the migrated catalog (co-located; no DB mocking in tests) ──

interface RawCategorizableRow {
  id: string;
  gps_lat: number | null;
  gps_lon: number | null;
  description: string | null;
  search_meta: string | null;
  embed_status: string;
  vector: Buffer | null;
}

/**
 * Build the {@link CategorizationStore} over an open, migrated catalog database. The
 * pending scan LEFT JOINs each item's embedding for `modelId` and yields a decoded
 * vector ONLY when `embed_status = 'done'` (embed-first composition); the keyset
 * `afterId` drives global-corpus paging. Each marker is one prepared UPDATE, mirroring
 * the embeddings-repo drain flips.
 */
export function createCategorizationStore(
  db: CatalogDatabase,
  options: { modelId?: string } = {},
): CategorizationStore {
  const modelId = options.modelId ?? EMBED_MODEL_ID;

  const listPendingFirstStmt = db.prepare(`
    SELECT i.id AS id, i.gps_lat AS gps_lat, i.gps_lon AS gps_lon,
           i.description AS description, i.search_meta AS search_meta,
           i.embed_status AS embed_status, e.vector AS vector
      FROM items i
      LEFT JOIN item_embeddings e ON e.item_id = i.id AND e.model_id = @modelId
     WHERE i.category_status = 'pending'
     ORDER BY i.id
     LIMIT @limit
  `);
  // Subsequent-page (seekable) statement — split from the first-page statement so
  // neither carries the `(@afterId IS NULL OR i.id > @afterId)` disjunction that
  // would defeat index use; the hot path (pages 2..N) then range-seeks on the id
  // cursor instead of re-scanning already-drained rows (#340). NOTE: migration 005's
  // partial `idx_items_category_queue` covers `(category_status)`, NOT `(id)`, so an
  // `ORDER BY id` may still take a temp B-tree sort on the first page — the split
  // narrows the scan, it does not guarantee a sort-free plan (a covering
  // `(category_status, id)` index would, but that is a migration and out of scope).
  // Ordering + boundaries match the first-page statement exactly; only the id-cursor
  // predicate differs.
  const listPendingAfterStmt = db.prepare(`
    SELECT i.id AS id, i.gps_lat AS gps_lat, i.gps_lon AS gps_lon,
           i.description AS description, i.search_meta AS search_meta,
           i.embed_status AS embed_status, e.vector AS vector
      FROM items i
      LEFT JOIN item_embeddings e ON e.item_id = i.id AND e.model_id = @modelId
     WHERE i.category_status = 'pending' AND i.id > @afterId
     ORDER BY i.id
     LIMIT @limit
  `);
  const markCategorizedStmt = db.prepare(`
    UPDATE items SET category_status = 'done', updated_at = datetime('now') WHERE id = @itemId
  `);
  const markFailedStmt = db.prepare(`
    UPDATE items SET category_status = 'error', updated_at = datetime('now') WHERE id = @itemId
  `);
  const markSkippedStmt = db.prepare(`
    UPDATE items SET category_status = 'skipped', updated_at = datetime('now') WHERE id = @itemId
  `);

  return {
    listPendingCategorization(afterId, limit) {
      const rows =
        afterId === null
          ? listPendingFirstStmt.all<RawCategorizableRow>({ modelId, limit })
          : listPendingAfterStmt.all<RawCategorizableRow>({ modelId, afterId, limit });
      return rows.map((row) => ({
        id: row.id,
        gpsLat: row.gps_lat,
        gpsLon: row.gps_lon,
        description: row.description,
        searchMeta: row.search_meta,
        embedding:
          row.embed_status === 'done' && row.vector !== null ? decodeVector(row.vector) : null,
      }));
    },
    markCategorized(itemId) {
      markCategorizedStmt.run({ itemId });
    },
    markCategoryFailed(itemId) {
      markFailedStmt.run({ itemId });
    },
    markCategorySkipped(itemId) {
      markSkippedStmt.run({ itemId });
    },
  };
}
