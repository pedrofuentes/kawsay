import {
  EMBED_DIM,
  EMBED_MODEL_ID,
  withPassagePrefix,
  type EmbedUnavailableReason,
  type EmbedderStatus,
} from './embed-cli';
import type { PendingEmbeddingItem } from '../db/embeddings-repo';

// The embedding-generation ORCHESTRATOR (M4-1b-seam-2, ADR-0029 Decision 1) — the
// WRITE PATH of smart search. It drains items whose `embed_status = 'pending'`, turns
// each item's text into a `passage:`-prefixed embedding via the seam-1 `embed-cli`
// embedder, and stores it through the EmbeddingsRepo (which flips the flag to `done`).
//
// It MIRRORS the M2 transcription orchestrator's shape — NEVER auto-starts, RESILIENT
// (a per-item or per-batch failure is recorded and the run carries on; one bad item
// never aborts the drain, AC-20 analogue), COOPERATIVELY CANCELLABLE (a fired
// cancel/AbortSignal stops between batches; whatever already succeeded stays saved),
// and ZERO-EGRESS (AC-4: every collaborator is local; originals are never touched —
// only the already-catalogued text is read). It is SIMPLER than transcription: the
// heavy compute is the `embed-cli` subprocess (already off the event loop), so there
// is no separate worker thread — the drain loop runs in the MAIN process (never the
// renderer). Every collaborator is injected (the store, the embedder resolver, the
// progress sink, an optional cancel signal) so it unit-tests with fakes and a real
// in-memory DB, no Electron runtime.
//
// GRACEFUL DEGRADATION is the governing contract: the embedding binary + model are
// bundled in a LATER packaging slice and do not exist yet, so `getEmbedder()` yields a
// typed UNAVAILABLE sentinel. The orchestrator then REFUSES with no side effects
// (no throw, no DB write, no drain) — exactly as live search falls back to exact FTS
// (AC-7). Wiring this into IPC / the read path is seam-3; this slice is additive.

/** The write-side of the EmbeddingsRepo the orchestrator drives (a structural subset). */
export interface EmbeddingStore {
  /** The next items awaiting embedding (embed_status = 'pending'), in stable id order. */
  listPendingEmbeddings(limit: number): PendingEmbeddingItem[];
  /** Store an item's vector for `modelId` and flip its drain flag to `done`. */
  upsertEmbedding(itemId: string, modelId: string, vector: Float32Array): void;
  /** Mark an item's drain FAILED (embed_status → 'error') without storing a vector. */
  markEmbedFailed(itemId: string): void;
  /** Mark an item's drain SKIPPED (embed_status → 'skipped') — no embeddable text. */
  markEmbedSkipped(itemId: string): void;
}

/** How many items are pulled per drain page AND embedded per subprocess call. */
export const DEFAULT_EMBED_BATCH_SIZE = 16;

/** The terminal status a single item settles as within a run. */
export type EmbeddingItemStatus = 'embedded' | 'failed' | 'skipped';

/** Running totals for a drain — the analogue of the transcription counts snapshot. */
export interface EmbeddingRunCounts {
  /** Items embedded and stored (embed_status → 'done'). */
  embedded: number;
  /** Items whose embed failed (embed_status → 'error'). */
  failed: number;
  /** Items with no embeddable text (embed_status → 'skipped'). */
  skipped: number;
  /** Items currently being embedded (the in-flight batch); 0 between batches. */
  inFlight: number;
}

/** A calm progress snapshot streamed to the renderer (seam-3 wires the sink). */
export interface EmbeddingRunSnapshot {
  state: 'idle' | 'running' | 'complete';
  counts: EmbeddingRunCounts;
  lastItem: { id: string; status: EmbeddingItemStatus } | null;
}

/** The outcome of a {@link EmbeddingOrchestrator.run}. */
export type EmbeddingRunOutcome =
  /** Drained ≥1 item to a terminal status. */
  | 'completed'
  /** Nothing was pending — a calm no-op. */
  | 'idle'
  /** A cooperative cancel stopped the drain; partial work persisted. */
  | 'cancelled'
  /** The embedder is UNAVAILABLE (binary/model absent) — degraded to FTS. */
  | 'refused'
  /** A run was already in flight — single-flight guard (no second drain). */
  | 'busy';

/** The result of a run: its outcome, a refusal `reason` (only when refused), and the tally. */
export interface EmbeddingRunResult {
  outcome: EmbeddingRunOutcome;
  /** The UNAVAILABLE reason when `outcome === 'refused'`, else null. */
  reason: EmbedUnavailableReason | null;
  counts: EmbeddingRunCounts;
}

/** Collaborators for {@link createEmbeddingOrchestrator} (all injected for testability). */
export interface EmbeddingOrchestratorOptions {
  /** The write-side embeddings store (the EmbeddingsRepo in production). */
  store: EmbeddingStore;
  /**
   * Resolves the embedder at run() (needs app/electron globals in prod). An
   * UNAVAILABLE result — the case until the packaging slice bundles the binary +
   * model — makes the run REFUSE with no side effects (degrade to exact FTS).
   */
  getEmbedder: () => EmbedderStatus;
  /** Items per drain page / embedder call (one subprocess spawn per batch). */
  batchSize?: number;
  /** Sinks a progress snapshot (the renderer event sender in prod; seam-3 wires it). */
  onProgress?: (snapshot: EmbeddingRunSnapshot) => void;
  /** An external cooperative cancel; the built-in {@link EmbeddingOrchestrator.cancel} also stops the run. */
  signal?: AbortSignal;
}

export interface EmbeddingOrchestrator {
  /** Drain every pending item into a stored embedding (gated, resilient, cancellable). */
  run(): Promise<EmbeddingRunResult>;
  /** Cooperatively cancel the in-flight run (it stops before the next batch). */
  cancel(): { cancelled: boolean };
  /** The current run snapshot (state + counts + last settled item). */
  status(): EmbeddingRunSnapshot;
}

/**
 * Build the passage text of a pending item: the non-empty parts of its `description`
 * and `searchMeta`, joined. Returns `null` when the item has NO embeddable text (both
 * parts null/blank) — the caller then marks it `skipped` rather than embedding an
 * empty string. The `embed-cli` sanitizer flattens any embedded newlines to one line
 * per text, so the join separator is immaterial to the N-in/N-out contract.
 */
export function buildPassageText(item: PendingEmbeddingItem): string | null {
  const parts = [item.description, item.searchMeta]
    .map((part) => (part === null ? '' : part.trim()))
    .filter((part) => part.length > 0);
  return parts.length === 0 ? null : parts.join('\n');
}

function zeroCounts(): EmbeddingRunCounts {
  return { embedded: 0, failed: 0, skipped: 0, inFlight: 0 };
}

export function createEmbeddingOrchestrator(
  options: EmbeddingOrchestratorOptions,
): EmbeddingOrchestrator {
  const { store, getEmbedder, onProgress, signal } = options;
  const batchSize = Math.max(1, options.batchSize ?? DEFAULT_EMBED_BATCH_SIZE);

  let counts = zeroCounts();
  let lastItem: EmbeddingRunSnapshot['lastItem'] = null;
  let running = false;
  let cancelled = false;
  let completed = false;

  /** Cancel is cooperative: either the built-in flag OR an external aborted signal. */
  function isCancelled(): boolean {
    return cancelled || signal?.aborted === true;
  }

  function computeState(): EmbeddingRunSnapshot['state'] {
    if (running) return 'running';
    return completed ? 'complete' : 'idle';
  }

  function snapshot(): EmbeddingRunSnapshot {
    return {
      state: computeState(),
      counts: { ...counts },
      lastItem: lastItem === null ? null : { ...lastItem },
    };
  }

  function emit(): void {
    onProgress?.(snapshot());
  }

  function tally(id: string, status: EmbeddingItemStatus): void {
    if (status === 'embedded') counts = { ...counts, embedded: counts.embedded + 1 };
    else if (status === 'failed') counts = { ...counts, failed: counts.failed + 1 };
    else counts = { ...counts, skipped: counts.skipped + 1 };
    lastItem = { id, status };
    emit();
  }

  /** Store a vector and count it embedded; a persistence throw is contained → failed. */
  function recordEmbedded(id: string, vector: Float32Array): void {
    try {
      store.upsertEmbedding(id, EMBED_MODEL_ID, vector);
    } catch {
      // A persistence failure on ONE item must never abort the run (resilience). The
      // upsert rolled back (item stays 'pending'), so mark it failed → it leaves the
      // pending set and is not re-drained this run; a later run can retry it.
      recordFailed(id);
      return;
    }
    tally(id, 'embedded');
  }

  /** Mark an item failed and count it; even the marker write is contained. */
  function recordFailed(id: string): void {
    try {
      store.markEmbedFailed(id);
    } catch {
      // A marker write can itself throw (disk full); the run still carries on. The
      // item is COUNTED as settled so the run reaches a terminal state rather than
      // stalling — the on-disk status is left for an idempotent retry on the next run.
    }
    tally(id, 'failed');
  }

  /** Mark an item skipped and count it; the marker write is contained. */
  function recordSkipped(id: string): void {
    try {
      store.markEmbedSkipped(id);
    } catch {
      // Contained for the same resilience reason as recordFailed.
    }
    tally(id, 'skipped');
  }

  /** Persist one batch's aligned vectors; a wrong-dimension vector is a per-item failure. */
  function settleBatch(
    items: readonly PendingEmbeddingItem[],
    vectors: readonly Float32Array[],
  ): void {
    // Defensive: the embedder is an N-in/N-out contract, so a count mismatch is a
    // broken batch — fail every item rather than mis-align vectors to ids.
    if (vectors.length !== items.length) {
      for (const item of items) recordFailed(item.id);
      return;
    }
    for (let i = 0; i < items.length; i += 1) {
      const vector = vectors[i];
      // A wrong-dimension vector (≠ EMBED_DIM) is a broken embed — mark it failed
      // and NEVER store it (a mixed-dimension corpus would break the cosine scan).
      if (vector.length === EMBED_DIM) recordEmbedded(items[i].id, vector);
      else recordFailed(items[i].id);
    }
  }

  async function drain(embed: EmbedderStatus & { available: true }): Promise<void> {
    // Progress guard: the id of every item we have already attempted this run. If a
    // page returns only already-attempted ids the drain is not advancing (a store
    // that failed to move them out of 'pending'), so we STOP rather than spin.
    const attempted = new Set<string>();

    for (;;) {
      if (isCancelled()) return;

      const page = store.listPendingEmbeddings(batchSize);
      if (page.length === 0) return; // fully drained
      if (page.every((item) => attempted.has(item.id))) return; // not advancing → stop
      for (const item of page) attempted.add(item.id);

      // Partition the page: items with embeddable text vs none (marked skipped now).
      const batch: PendingEmbeddingItem[] = [];
      const texts: string[] = [];
      for (const item of page) {
        const text = buildPassageText(item);
        if (text === null) recordSkipped(item.id);
        else {
          batch.push(item);
          texts.push(withPassagePrefix(text));
        }
      }
      if (batch.length === 0) continue; // whole page was text-less → next page

      // Re-check cancel before the expensive subprocess spawn.
      if (isCancelled()) return;

      counts = { ...counts, inFlight: batch.length };
      emit();

      let vectors: Float32Array[];
      try {
        // ONE subprocess call for the whole batch — never one spawn per item.
        vectors = await embed.embed(texts);
      } catch {
        // The whole batch's embed failed (subprocess error, timeout, malformed JSON,
        // wrong dim) — mark every item in it failed and CARRY ON; a bad batch never
        // aborts the run.
        counts = { ...counts, inFlight: 0 };
        for (const item of batch) recordFailed(item.id);
        continue;
      }

      counts = { ...counts, inFlight: 0 };
      settleBatch(batch, vectors);
    }
  }

  return {
    async run() {
      // Single-flight: a second concurrent run is a calm no-op (never double-drains).
      // Set synchronously before the first await so a re-entrant call sees it.
      if (running) {
        return { outcome: 'busy', reason: null, counts: { ...counts } };
      }

      // Gate: resolve the embedder fresh. UNAVAILABLE (binary/model absent — the case
      // until packaging) → refuse with NO side effects (no throw, no DB write, no
      // drain), exactly like live search degrading to exact FTS (AC-7).
      const embedder = getEmbedder();
      if (!embedder.available) {
        return { outcome: 'refused', reason: embedder.reason, counts: zeroCounts() };
      }

      running = true;
      cancelled = false;
      completed = false;
      counts = zeroCounts();
      lastItem = null;
      emit(); // running, zero counts

      try {
        await drain(embedder);
      } finally {
        running = false;
      }

      const settledAny = counts.embedded + counts.failed + counts.skipped > 0;
      let outcome: EmbeddingRunOutcome;
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
      // Cooperative: the drain loop checks isCancelled() between batches and stops;
      // the in-flight batch (if any) finishes and its successful work stays saved.
      cancelled = true;
      return { cancelled: true };
    },

    status() {
      return snapshot();
    },
  };
}
