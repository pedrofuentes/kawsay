// The transcription RUN orchestrator (M2, #157 — ADR-0027 / AC-18·19·20). This is
// the keystone that turns the already-merged pieces into a working feature: it
// drives the off-thread worker (#134) over the library's audio/video items
// (catalog enumeration), applies the #135 idempotence predicate HOST-SIDE (the
// worker can't reach the DB), PERSISTS each outcome host-side (a transcript on
// success, a `failed`/`skipped` status otherwise), and streams a calm progress
// snapshot to the renderer (#136 wires the UI).
//
// It is DOUBLY GATED and NEVER auto-starts: `start()` refuses unless the user has
// opted in (AC-22) AND the model is present-and-verified (#131). It is RESILIENT
// (AC-20): a per-item failure — or even a persistence throw — is recorded and the
// run carries on. It makes ZERO network calls (AC-4): every collaborator is local.
//
// Every collaborator is injected (the gate, the library port, the worker port, the
// job-config resolver, the progress sink), so the whole thing unit-tests with fakes
// and no real thread, DB, or Electron runtime. Production wiring lives in index.ts.

import type { TranscriptionJobSpec } from './queue/protocol';
import type { TranscriptionCoordinatorEvent } from './queue/coordinator';
import type { TranscriptionItemOutcome, TranscriptionItemStatus } from './transcribe-batch';
import type {
  TranscriptionCountsDTO,
  TranscriptionItemStatusDTO,
  TranscriptionSnapshotDTO,
  TranscriptionStartResultDTO,
} from '@shared/ipc/schemas';

/** One transcript segment with millisecond offsets (structurally the worker's). */
export interface TranscriptionSegment {
  startMs: number;
  endMs: number;
  text: string;
}

/** A transcript to persist on a successful item (forwarded to the #135 repo). */
export interface TranscriptionSaveInput {
  itemId: string;
  text: string;
  language: string | null;
  segments: TranscriptionSegment[];
}

/** A transcribable media item, resolved to its local source path (AC-14). */
export interface TranscriptionLibraryItem {
  id: string;
  sourcePath: string;
  durationSec?: number | null;
  language?: string;
}

/**
 * The host-side persistence + enumeration seam over the open catalog. The
 * orchestrator never touches SQLite directly — it lists the corpus, asks whether
 * an item is already done (the #135 idempotence hook), and records each outcome.
 */
export interface TranscriptionLibraryPort {
  /** Every audio/video item with a resolvable local original, in stable order. */
  listItems(): TranscriptionLibraryItem[];
  /** True iff the item is already transcribed (`transcript_status = 'done'`). */
  isTranscribed(id: string): boolean;
  /** Persist a transcript on success (attach to the item, mark it done). */
  saveTranscript(input: TranscriptionSaveInput): void;
  /** Record a non-success terminal status without writing a transcript. */
  recordStatus(id: string, status: 'failed' | 'skipped'): void;
}

/** The two host-resolved gate predicates (kept separate so each refusal branch is
 *  independently testable). `isModelReady` may be async (it stat+verifies a file). */
export interface TranscriptionGate {
  isOptedIn(): boolean;
  isModelReady(): boolean | Promise<boolean>;
}

/** The off-thread worker the orchestrator drives (the #134 coordinator in prod). */
export interface TranscriptionWorkerPort {
  start(job: TranscriptionJobSpec): void;
  cancel(jobId: string): boolean;
}

/** The host-resolved, run-invariant job parameters (model + binaries + scratch). */
export interface TranscriptionJobConfig {
  modelPath: string;
  whisperCliPath: string;
  /** Absolute path of the resolved per-arch `ffmpeg` binary (audio extraction). */
  ffmpegPath: string;
  scratchDir: string;
  language?: string;
}

/** Resolves the job config at start() (needs app/electron globals in prod). */
export type ResolveJobConfig = () => TranscriptionJobConfig;

export interface TranscriptionOrchestratorOptions {
  gate: TranscriptionGate;
  /** Yields the library port for the OPEN library (called once per start()). */
  getLibrary: () => TranscriptionLibraryPort;
  worker: TranscriptionWorkerPort;
  resolveJobConfig: ResolveJobConfig;
  /** Sinks a validated progress snapshot to the renderer (the event sender in prod). */
  emitProgress: (snapshot: TranscriptionSnapshotDTO) => void;
  /** Job-id factory (injectable for deterministic tests). */
  newJobId?: () => string;
}

export interface TranscriptionOrchestrator {
  /** Gated, idempotent start of a run over the library's audio/video items. */
  start(): Promise<TranscriptionStartResultDTO>;
  /** Cooperatively cancel the in-flight run (the worker kills its child). */
  cancel(): { cancelled: boolean };
  /** The current run snapshot (state + counts + last settled item). */
  status(): TranscriptionSnapshotDTO;
  /** Fold one coordinator event (relayed worker progress / terminal) into state. */
  handleWorkerEvent(event: TranscriptionCoordinatorEvent): void;
}

type LastItem = { id: string; status: TranscriptionItemStatusDTO } | null;

function zeroCounts(): TranscriptionCountsDTO {
  return { total: 0, transcribed: 0, failed: 0, skipped: 0, inFlight: 0 };
}

/** Map a worker item status onto the host action: persist a transcript, record a
 *  failed/skipped status, or ignore (cancelled stays pending; an idempotent
 *  skipped-existing was already done and must not be overwritten). */
function classify(
  status: TranscriptionItemStatus,
): 'transcribed' | 'failed' | 'skipped' | 'ignored' {
  if (status === 'transcribed') return 'transcribed';
  if (status === 'no-speech' || status === 'no-audio-stream') return 'skipped';
  if (status === 'cancelled' || status === 'skipped-existing') return 'ignored';
  // model-unavailable | decode-failed | extract-timed-out | scratch-io |
  // whisper-failed | whisper-timed-out — a typed, reportable failure.
  return 'failed';
}

export function createTranscriptionOrchestrator(
  options: TranscriptionOrchestratorOptions,
): TranscriptionOrchestrator {
  const { gate, getLibrary, worker, resolveJobConfig, emitProgress } = options;
  const newJobId = options.newJobId ?? (() => globalThis.crypto.randomUUID());

  let counts = zeroCounts();
  let lastItem: LastItem = null;
  let activeJobId: string | null = null;
  let library: TranscriptionLibraryPort | null = null;

  function computeState(): TranscriptionSnapshotDTO['state'] {
    if (activeJobId !== null) return 'running';
    const settled = counts.transcribed + counts.failed + counts.skipped;
    if (counts.total > 0 && settled >= counts.total) return 'complete';
    return 'idle';
  }

  function snapshot(): TranscriptionSnapshotDTO {
    return {
      state: computeState(),
      counts: { ...counts },
      lastItem: lastItem === null ? null : { ...lastItem },
    };
  }

  function emit(): void {
    emitProgress(snapshot());
  }

  function settleItem(outcome: TranscriptionItemOutcome): void {
    if (library === null) return;
    const action = classify(outcome.status);

    // The terminal, COUNTABLE status this item settles as — or null for an action
    // that records nothing: 'ignored' (cancelled / skipped-existing), or a
    // 'transcribed' action with no transcript payload to persist.
    let settled: TranscriptionItemStatusDTO | null = null;
    if (action === 'transcribed' && outcome.transcript !== null) settled = 'transcribed';
    else if (action === 'failed') settled = 'failed';
    else if (action === 'skipped') settled = 'skipped';
    if (settled === null) return;

    try {
      if (settled === 'transcribed' && outcome.transcript !== null) {
        library.saveTranscript({
          itemId: outcome.id,
          text: outcome.transcript.text,
          language: outcome.transcript.language,
          segments: outcome.transcript.segments,
        });
      } else if (settled === 'failed') {
        library.recordStatus(outcome.id, 'failed');
      } else {
        library.recordStatus(outcome.id, 'skipped');
      }
    } catch {
      // AC-20 resilience: a persistence failure on ONE item must never abort the
      // run. The on-disk status is left unchanged (retried, idempotently, on the
      // next run). We still COUNT it as settled below so the terminal snapshot
      // reaches 'complete' rather than stalling one short at 'idle' (#160).
    }

    // Tally + lastItem update happen whether or not the persist threw: for
    // run-progress an item is settled once its outcome is known, even if its DB
    // write failed.
    if (settled === 'transcribed') counts = { ...counts, transcribed: counts.transcribed + 1 };
    else if (settled === 'failed') counts = { ...counts, failed: counts.failed + 1 };
    else counts = { ...counts, skipped: counts.skipped + 1 };
    lastItem = { id: outcome.id, status: settled };
  }

  function toJobItems(items: TranscriptionLibraryItem[]): TranscriptionJobSpec['items'] {
    return items.map((item) => ({
      id: item.id,
      sourcePath: item.sourcePath,
      durationSec: item.durationSec ?? null,
      ...(item.language !== undefined ? { language: item.language } : {}),
    }));
  }

  return {
    async start() {
      // A run is already in flight — never dispatch a second worker (serial engine).
      if (activeJobId !== null) {
        return { outcome: 'started', reason: null, counts: { ...counts } };
      }

      // Gate #1: explicit opt-in (AC-22). Checked FIRST so a not-opted-in refusal
      // never even probes the model.
      if (!gate.isOptedIn()) {
        return { outcome: 'refused', reason: 'not-opted-in', counts: zeroCounts() };
      }
      // Gate #2: the model is present AND integrity-verified (#131).
      if (!(await gate.isModelReady())) {
        return { outcome: 'refused', reason: 'model-not-ready', counts: zeroCounts() };
      }

      const lib = getLibrary();
      const allItems = lib.listItems();
      // Idempotence (#135): only items NOT already `done` are dispatched; the rest
      // are pre-counted as transcribed so `total` reflects the whole corpus.
      const pending = allItems.filter((item) => !lib.isTranscribed(item.id));
      const alreadyDone = allItems.length - pending.length;
      const startCounts: TranscriptionCountsDTO = {
        total: allItems.length,
        transcribed: alreadyDone,
        failed: 0,
        skipped: 0,
        inFlight: 0,
      };

      library = lib;
      counts = startCounts;
      lastItem = null;

      if (pending.length === 0) {
        // Nothing to do: an empty library, or everything already transcribed.
        activeJobId = null;
        return { outcome: 'idle', reason: null, counts: { ...startCounts } };
      }

      const config = resolveJobConfig();
      const jobId = newJobId();
      const jobSpec: TranscriptionJobSpec = {
        jobId,
        items: toJobItems(pending),
        modelPath: config.modelPath,
        whisperCliPath: config.whisperCliPath,
        ffmpegPath: config.ffmpegPath,
        scratchDir: config.scratchDir,
        ...(config.language !== undefined ? { language: config.language } : {}),
      };

      activeJobId = jobId;
      try {
        worker.start(jobSpec);
      } catch (error) {
        activeJobId = null;
        counts = { ...counts, inFlight: 0 };
        console.warn('[kawsay] transcription worker failed to start; run left idle for retry', error);
        throw error;
      }
      emit();
      return { outcome: 'started', reason: null, counts: { ...startCounts } };
    },

    cancel() {
      if (activeJobId === null) return { cancelled: false };
      // Cooperative: the worker aborts, SIGKILLs the in-flight child, and stops
      // dispatch; the partial summary arrives later as a normal `done` event.
      return { cancelled: worker.cancel(activeJobId) };
    },

    status() {
      return snapshot();
    },

    handleWorkerEvent(event) {
      // Ignore stray events from a previous (already-settled) job.
      if (activeJobId === null || event.jobId !== activeJobId) return;
      if (event.kind === 'progress') {
        const { progress } = event;
        if (progress.phase === 'item-start') {
          counts = { ...counts, inFlight: 1 };
          emit();
        } else if (progress.phase === 'item-done') {
          counts = { ...counts, inFlight: 0 };
          settleItem(progress.outcome);
          emit();
        }
        // 'batch-done' is redundant with the coordinator's terminal `done` event.
        return;
      }
      // Terminal: the batch settled (done) or the worker faulted (error). Either
      // way the run is no longer active; whatever completed is already persisted.
      counts = { ...counts, inFlight: 0 };
      activeJobId = null;
      emit();
    },
  };
}
