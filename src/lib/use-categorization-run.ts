// Drives the categorization RUN from the renderer — the calm controls that let a
// user start organizing their memories, watch gentle progress, and stop. It is
// CALLER-INITIATED: on mount it only subscribes to the typed progress stream;
// nothing organizes until start() is called. A gated refusal comes back as a
// typed outcome the UI turns into kind guidance — never an exception, never a raw
// reason code.
import { useCallback, useEffect, useState } from 'react';
import type {
  CategorizationCountsDTO,
  CategorizationRefusalReasonDTO,
  CategorizationSnapshotDTO,
  CategorizationStartResultDTO,
} from '@shared/kawsay-api';
import { useKawsayApi } from './kawsay-api';

/** The calm screen the run controls show, derived from the live run state. */
export type CategorizationRunFace =
  | 'intro' // resting: offer to organize
  | 'running' // a run is in flight: gentle live count + stop
  | 'complete' // a run finished: what was gathered
  | 'refused' // gated: guide kindly (see `reason`)
  | 'nothing' // idle outcome: nothing to organize right now
  | 'stopped'; // cancelled: what was gathered is saved

export interface UseCategorizationRunResult {
  face: CategorizationRunFace;
  counts: CategorizationCountsDTO;
  reason: CategorizationRefusalReasonDTO | null;
  starting: boolean;
  start: () => Promise<void>;
  cancel: () => Promise<void>;
}

const ZERO_COUNTS: CategorizationCountsDTO = {
  categorized: 0,
  skipped: 0,
  failed: 0,
  inFlight: 0,
};

export function useCategorizationRun(): UseCategorizationRunResult {
  const api = useKawsayApi();
  const [snapshot, setSnapshot] = useState<CategorizationSnapshotDTO | null>(null);
  const [lastOutcome, setLastOutcome] = useState<CategorizationStartResultDTO | null>(null);
  const [starting, setStarting] = useState(false);

  // Subscribe once to the live progress stream; every tick is a full snapshot.
  useEffect(() => {
    if (api === undefined) {
      return undefined;
    }
    return api.onCategorizationProgress(setSnapshot);
  }, [api]);

  const start = useCallback(async (): Promise<void> => {
    if (api === undefined) {
      return;
    }
    setStarting(true);
    try {
      setLastOutcome(await api.startCategorization());
    } catch (error) {
      console.warn('[kawsay] categorization start request failed; leaving controls at rest', error);
    } finally {
      setStarting(false);
    }
  }, [api]);

  const cancel = useCallback(async (): Promise<void> => {
    if (api === undefined) {
      return;
    }
    try {
      await api.cancelCategorization();
    } catch (error) {
      console.warn('[kawsay] categorization cancel request failed; waiting for stream state', error);
    }
  }, [api]);

  const face = computeFace(snapshot, lastOutcome, starting);
  const counts = displayCounts(snapshot, lastOutcome);
  const reason = face === 'refused' ? (lastOutcome?.reason ?? null) : null;

  return { face, counts, reason, starting, start, cancel };
}

function computeFace(
  snapshot: CategorizationSnapshotDTO | null,
  lastOutcome: CategorizationStartResultDTO | null,
  starting: boolean,
): CategorizationRunFace {
  if (starting) {
    return 'running';
  }
  if (snapshot?.state === 'running') {
    return 'running';
  }
  switch (lastOutcome?.outcome) {
    case 'completed':
      return 'complete';
    case 'refused':
      return 'refused';
    case 'idle':
      return 'nothing';
    case 'cancelled':
      return 'stopped';
    case 'busy':
      return 'running';
  }
  if (snapshot?.state === 'complete') {
    return 'complete';
  }
  return 'intro';
}

function displayCounts(
  snapshot: CategorizationSnapshotDTO | null,
  lastOutcome: CategorizationStartResultDTO | null,
): CategorizationCountsDTO {
  if (snapshot && (snapshot.state === 'running' || snapshot.state === 'complete')) {
    return snapshot.counts;
  }
  return lastOutcome?.counts ?? snapshot?.counts ?? ZERO_COUNTS;
}
