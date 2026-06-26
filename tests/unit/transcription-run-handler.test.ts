import { describe, expect, it, vi } from 'vitest';
import {
  handleCancelTranscription,
  handleStartTranscription,
  handleTranscriptionStatus,
  type TranscriptionRunController,
} from '../../electron/main/ipc/handlers/transcription-run';
import type { TranscriptionSnapshotDTO, TranscriptionStartResultDTO } from '@shared/ipc/schemas';

const ZERO = { total: 0, transcribed: 0, failed: 0, skipped: 0, inFlight: 0 };

function makeController(
  over: Partial<TranscriptionRunController> = {},
): TranscriptionRunController {
  const snapshot: TranscriptionSnapshotDTO = { state: 'idle', counts: ZERO, lastItem: null };
  return {
    start: vi.fn(() =>
      Promise.resolve({
        outcome: 'started',
        reason: null,
        counts: ZERO,
      } satisfies TranscriptionStartResultDTO),
    ),
    cancel: vi.fn(() => ({ cancelled: false })),
    status: vi.fn(() => snapshot),
    ...over,
  };
}

describe('transcription run IPC handlers (#157)', () => {
  it('handleStartTranscription delegates to the orchestrator and returns its validated result', async () => {
    const counts = { total: 3, transcribed: 1, failed: 0, skipped: 0, inFlight: 0 };
    const start = vi.fn(() =>
      Promise.resolve({
        outcome: 'started',
        reason: null,
        counts,
      } satisfies TranscriptionStartResultDTO),
    );
    const controller = makeController({ start });

    expect(await handleStartTranscription({ controller })).toEqual({
      outcome: 'started',
      reason: null,
      counts,
    });
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('handleStartTranscription surfaces a gated refusal with its reason', async () => {
    const controller = makeController({
      start: vi.fn(() =>
        Promise.resolve({
          outcome: 'refused',
          reason: 'not-opted-in',
          counts: ZERO,
        } satisfies TranscriptionStartResultDTO),
      ),
    });

    expect(await handleStartTranscription({ controller })).toEqual({
      outcome: 'refused',
      reason: 'not-opted-in',
      counts: ZERO,
    });
  });

  it('handleTranscriptionStatus returns the current snapshot (idle/running/complete + counts)', () => {
    const snapshot: TranscriptionSnapshotDTO = {
      state: 'running',
      counts: { total: 2, transcribed: 1, failed: 0, skipped: 0, inFlight: 1 },
      lastItem: { id: '11111111-1111-4111-8111-111111111111', status: 'transcribed' },
    };
    const controller = makeController({ status: vi.fn(() => snapshot) });

    expect(handleTranscriptionStatus({ controller })).toEqual(snapshot);
  });

  it('handleCancelTranscription returns whether a run was cancelled', () => {
    const controller = makeController({ cancel: vi.fn(() => ({ cancelled: true })) });
    expect(handleCancelTranscription({ controller })).toEqual({ cancelled: true });
  });
});
