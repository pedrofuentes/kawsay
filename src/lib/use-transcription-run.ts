// Drives the transcription RUN from the renderer (#136) — the calm controls that
// let a user start transcribing their recordings, watch gentle progress, and stop.
// Like useModelDownload it is CALLER-INITIATED: on mount it only *reads* the run
// state (so a reopened window reflects a run already going) and subscribes to the
// typed progress stream; nothing transcribes until start() is called. A gated
// refusal (not opted in / model not ready) comes back as a typed outcome the UI
// turns into kind guidance — never an exception, never a raw reason code.
import { useCallback, useEffect, useState } from 'react';
import type {
  TranscriptionCountsDTO,
  TranscriptionRefusalReasonDTO,
  TranscriptionSnapshotDTO,
  TranscriptionStartResultDTO,
} from '@shared/kawsay-api';
import { useKawsayApi } from './kawsay-api';

/** The calm screen the run controls show, derived from the live run state. */
export type TranscriptionRunFace =
  | 'intro' // resting: offer to start
  | 'running' // a run is in flight: gentle progress + stop
  | 'complete' // a run finished: what was gained, what couldn't be
  | 'refused' // gated: guide the user kindly (see `reason`)
  | 'empty' // tried, but there are no recordings to transcribe
  | 'all-done'; // tried, but every recording already has words

export interface UseTranscriptionRunResult {
  face: TranscriptionRunFace;
  /** The counts to display, drawn from the live run or the last start result. */
  counts: TranscriptionCountsDTO;
  /** Why a start was refused, when `face === 'refused'`; otherwise null. */
  reason: TranscriptionRefusalReasonDTO | null;
  /** True while a start() call is in flight (so the control can disable). */
  starting: boolean;
  /** The explicit opt-in to begin a run (nothing transcribes until this is called). */
  start: () => Promise<void>;
  /** Gently stop an in-flight run; the stream settles the final state. */
  cancel: () => Promise<void>;
}

const ZERO_COUNTS: TranscriptionCountsDTO = {
  total: 0,
  transcribed: 0,
  failed: 0,
  skipped: 0,
  inFlight: 0,
};

export function useTranscriptionRun(): UseTranscriptionRunResult {
  const api = useKawsayApi();
  // The latest run snapshot — seeded from getTranscriptionStatus() on mount, then
  // driven by the progress stream. Null until the first read resolves.
  const [snapshot, setSnapshot] = useState<TranscriptionSnapshotDTO | null>(null);
  // The most recent start() result — the only thing that distinguishes a resting
  // idle state (offer Start) from an idle state the user just *tried* (empty/done).
  const [lastOutcome, setLastOutcome] = useState<TranscriptionStartResultDTO | null>(null);
  const [starting, setStarting] = useState(false);

  // Subscribe once to the live progress stream; every tick is a full snapshot.
  useEffect(() => {
    if (api === undefined) {
      return undefined;
    }
    return api.onTranscriptionProgress((event) => {
      setSnapshot(event);
    });
  }, [api]);

  // Read the current run state once on mount so a reopened window reflects a run
  // already running or just completed. This NEVER starts a run. A progress tick
  // that beat us to it wins (we only seed when nothing has arrived yet).
  useEffect(() => {
    if (api === undefined) {
      return undefined;
    }
    let active = true;
    void api
      .getTranscriptionStatus()
      .then((snap) => {
        if (active) {
          setSnapshot((prev) => prev ?? snap);
        }
      })
      .catch(() => {
        // A failed status read is treated as "nothing running" — the resting intro
        // still offers Start, and the next start() reports the real state. There is
        // no renderer logger to route a diagnostic to, and it self-heals.
      });
    return () => {
      active = false;
    };
  }, [api]);

  const start = useCallback(async (): Promise<void> => {
    if (api === undefined) {
      return;
    }
    setStarting(true);
    try {
      const result = await api.startTranscription();
      setLastOutcome(result);
    } catch {
      // A rejected start leaves the resting intro in place rather than alarming the
      // user; they can simply try again.
    } finally {
      setStarting(false);
    }
  }, [api]);

  const cancel = useCallback(async (): Promise<void> => {
    if (api === undefined) {
      return;
    }
    try {
      await api.cancelTranscription();
    } catch {
      // The stream settles the final state regardless; nothing to surface here.
    }
  }, [api]);

  const face = computeFace(snapshot, lastOutcome);
  const counts = displayCounts(snapshot, lastOutcome);
  const reason = face === 'refused' ? (lastOutcome?.reason ?? null) : null;

  return { face, counts, reason, starting, start, cancel };
}

function computeFace(
  snapshot: TranscriptionSnapshotDTO | null,
  lastOutcome: TranscriptionStartResultDTO | null,
): TranscriptionRunFace {
  // A live run always wins, whether seen on mount or via the stream.
  if (snapshot?.state === 'running') {
    return 'running';
  }
  if (snapshot?.state === 'complete') {
    return 'complete';
  }
  // Otherwise the run is idle (or not yet read): the last start() the user made is
  // what tells the resting intro apart from a tried-but-nothing-to-do outcome.
  if (lastOutcome?.outcome === 'started') {
    return 'running'; // optimistic — the first progress tick confirms it
  }
  if (lastOutcome?.outcome === 'refused') {
    return 'refused';
  }
  if (lastOutcome?.outcome === 'idle') {
    return lastOutcome.counts.total === 0 ? 'empty' : 'all-done';
  }
  return 'intro';
}

function displayCounts(
  snapshot: TranscriptionSnapshotDTO | null,
  lastOutcome: TranscriptionStartResultDTO | null,
): TranscriptionCountsDTO {
  // A live/finished run reports the freshest tally; before the first tick (an
  // optimistic start) fall back to the counts the start call returned.
  if (snapshot?.state === 'running' || snapshot?.state === 'complete') {
    return snapshot.counts;
  }
  return lastOutcome?.counts ?? snapshot?.counts ?? ZERO_COUNTS;
}
