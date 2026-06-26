import type {
  TranscribeItem,
  Transcriber,
  Transcript,
  TranscribeSkipReason,
} from './transcribe';

// The resilient BATCH RUNNER for M2 (ADR-0027 §2, issue #134). It drives the
// per-item executor over a list of media items SERIALLY — whisper.cpp saturates
// the GPU (Metal) or a few CPU cores per item, so concurrency would only thrash
// (ADR-0027) — streaming a per-item progress lifecycle the worker relays to the
// host (AC-18). It is the QUEUE policy layer, not the resilience boundary: the
// executor already turns every media-level failure into a typed skip, so the
// runner simply records each outcome and CARRIES ON — a bad item never aborts the
// batch (AC-20). A cooperative `AbortSignal` is forwarded to the in-flight
// executor (which KILLS the whisper-cli child mid-file) and then STOPS dispatch,
// marking the remaining items `cancelled` without doing any further work. Re-running
// is safe: a duplicate id within a run, or an item a `skipWhen` predicate reports as
// already done (the #135 transcript_status hook), is `skipped-existing`, never
// re-transcribed. It persists NOTHING (no DB, #135) and renders NOTHING (no UI, #136).

/** The terminal status of one item: transcribed, a typed executor skip, an idempotent skip, or cancelled. */
export type TranscriptionItemStatus = 'transcribed' | 'skipped-existing' | TranscribeSkipReason;

/** The outcome of a single item — its status and (only when transcribed) its transcript. */
export interface TranscriptionItemOutcome {
  id: string;
  status: TranscriptionItemStatus;
  transcript: Transcript | null;
}

/** A streamed progress event (structured-clone-safe so the worker can post it to the host). */
export type TranscriptionProgress =
  | { phase: 'item-start'; index: number; total: number; id: string }
  | { phase: 'item-done'; index: number; total: number; id: string; outcome: TranscriptionItemOutcome }
  | { phase: 'batch-done'; total: number; transcribed: number; skipped: number; cancelled: number };

/** The summary of a completed (or cancelled) batch. `total === transcribed + skipped + cancelled`. */
export interface TranscriptionBatchSummary {
  total: number;
  transcribed: number;
  skipped: number;
  cancelled: number;
  outcomes: TranscriptionItemOutcome[];
}

/** Options for {@link runTranscriptionBatch}. */
export interface RunTranscriptionBatchOptions {
  /** The per-item executor (from `createTranscriber`). */
  transcribe: Transcriber;
  /** The media items to process, in order. */
  items: readonly TranscribeItem[];
  /** Cooperative cancel: forwarded to the executor (kills the in-flight child), then stops dispatch. */
  signal?: AbortSignal;
  /** Streamed per-item + terminal progress (relayed to the host by the worker). */
  onProgress?: (progress: TranscriptionProgress) => void;
  /** Idempotence hook (#135): report an item as already transcribed to skip it without work. */
  skipWhen?: (item: TranscribeItem) => boolean | Promise<boolean>;
}

/**
 * Run the transcription executor over `items` serially, streaming progress and
 * returning a counted summary. Resilient (a failed item — or even an unexpected
 * throw — becomes a typed skip and the batch continues), cancellable (a fired
 * signal kills the in-flight child via the executor, then the rest are marked
 * cancelled without dispatch), and idempotent (a duplicate id within the run, or a
 * `skipWhen` hit, is `skipped-existing`). The `skipWhen` predicate (the #135
 * transcript_status hook) is consulted defensively: a throw/rejection is contained
 * and treated as "not done" so it can never abort the batch (#150).
 */
export async function runTranscriptionBatch(
  options: RunTranscriptionBatchOptions,
): Promise<TranscriptionBatchSummary> {
  const { transcribe, items, signal, onProgress, skipWhen } = options;
  const total = items.length;
  const outcomes: TranscriptionItemOutcome[] = [];
  const dispatched = new Set<string>();
  const emit = (progress: TranscriptionProgress): void => onProgress?.(progress);

  for (let index = 0; index < total; index++) {
    const item = items[index];
    emit({ phase: 'item-start', index, total, id: item.id });

    let outcome: TranscriptionItemOutcome;
    if (signal?.aborted) {
      // A cancel stops the QUEUE: the remaining items are reported, never worked.
      outcome = { id: item.id, status: 'cancelled', transcript: null };
    } else if (dispatched.has(item.id) || (await isAlreadyDone(skipWhen, item))) {
      // Already handled this id in-run, or the caller says it is already done.
      outcome = { id: item.id, status: 'skipped-existing', transcript: null };
    } else {
      dispatched.add(item.id);
      outcome = await transcribeOne(transcribe, item, signal);
    }

    outcomes.push(outcome);
    emit({ phase: 'item-done', index, total, id: item.id, outcome });
  }

  const transcribed = outcomes.filter((o) => o.status === 'transcribed').length;
  const cancelled = outcomes.filter((o) => o.status === 'cancelled').length;
  const skipped = total - transcribed - cancelled;
  emit({ phase: 'batch-done', total, transcribed, skipped, cancelled });
  return { total, transcribed, skipped, cancelled, outcomes };
}

/**
 * Evaluate the optional `skipWhen` idempotence predicate (#135) DEFENSIVELY. The
 * predicate is the transcript_status hook (a DB lookup), so it can throw or reject;
 * that must NEVER abort the batch (#150 — the 'batch never aborts' contract). A
 * throw is contained here and treated as "not done" (`false`), so the item is
 * processed normally and the run carries on. The `dispatched` short-circuit in the
 * caller means this is only consulted for ids not already handled in-run.
 */
async function isAlreadyDone(
  skipWhen: ((item: TranscribeItem) => boolean | Promise<boolean>) | undefined,
  item: TranscribeItem,
): Promise<boolean> {
  if (!skipWhen) return false;
  try {
    return await skipWhen(item);
  } catch (error) {
    // Fail-closed (treat as "not done") so a throwing predicate never aborts the
    // batch (#150), but leave a diagnostic so a PERSISTENTLY-throwing transcript_
    // status hook is observable rather than silently swallowed (#155).
    console.warn(
      `[kawsay] transcription skipWhen predicate threw for item ${item.id}; treating as not-done:`,
      error,
    );
    return false;
  }
}

/**
 * Transcribe one item, forwarding the cancel signal (so a fired cancel KILLS the
 * whisper-cli child) and translating the typed result into an outcome. The executor
 * never throws for a media-level failure, but an UNEXPECTED throw is still contained
 * here as a `whisper-failed` skip so a single rogue item can never abort the batch.
 */
async function transcribeOne(
  transcribe: Transcriber,
  item: TranscribeItem,
  signal: AbortSignal | undefined,
): Promise<TranscriptionItemOutcome> {
  try {
    const result = await transcribe(item, signal ? { signal } : undefined);
    return result.ok
      ? { id: result.id, status: 'transcribed', transcript: result.transcript }
      : { id: result.id, status: result.reason, transcript: null };
  } catch {
    return { id: item.id, status: 'whisper-failed', transcript: null };
  }
}
