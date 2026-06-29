import { describe, expect, it, vi } from 'vitest';
import { createEventSender } from '../../electron/main/ipc/event-sender';
import {
  IMPORT_PROGRESS,
  TRANSCRIPTION_PROGRESS,
  type ImportProgressEvent,
  type TranscriptionProgressEvent,
} from '@shared/ipc/events';

const UUID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

const validEvent: ImportProgressEvent = {
  jobId: UUID,
  phase: 'emit',
  processed: 1,
  total: 3,
  message: 'one',
  summary: null,
  error: null,
};

describe('createEventSender (main → renderer, validated before send)', () => {
  it('validates and forwards a well-formed event to the raw transport', () => {
    const send = vi.fn();
    const emit = createEventSender(send);

    emit(IMPORT_PROGRESS, validEvent);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(IMPORT_PROGRESS, validEvent);
  });

  it('drops a malformed event BEFORE it crosses to the renderer (never sends it)', () => {
    const send = vi.fn();
    const diagnostics = vi.fn();
    const emit = createEventSender(send, { onInvalidEvent: diagnostics });

    // A bad phase would otherwise reach React; the sender refuses to forward it.
    emit(IMPORT_PROGRESS, { ...validEvent, phase: 'teleporting' } as never);
    // An unknown key is rejected by the strict schema.
    emit(IMPORT_PROGRESS, { ...validEvent, rogue: true } as never);

    expect(send).not.toHaveBeenCalled();
    expect(diagnostics).toHaveBeenCalledTimes(2);
    expect(diagnostics.mock.calls[0]?.[0]).toMatchObject({ channel: IMPORT_PROGRESS });
    expect(diagnostics.mock.calls[0]?.[0].issues[0].path).toEqual(['phase']);
  });

  it('validates and forwards a transcription:progress snapshot (#157)', () => {
    const send = vi.fn();
    const emit = createEventSender(send);
    const snapshot: TranscriptionProgressEvent = {
      state: 'running',
      counts: { total: 2, transcribed: 1, failed: 0, skipped: 0, inFlight: 1 },
      lastItem: { id: UUID, status: 'transcribed' },
    };

    emit(TRANSCRIPTION_PROGRESS, snapshot);

    expect(send).toHaveBeenCalledWith(TRANSCRIPTION_PROGRESS, snapshot);
  });

  it('drops a malformed transcription:progress snapshot (bad item status)', () => {
    const send = vi.fn();
    const emit = createEventSender(send);

    emit(TRANSCRIPTION_PROGRESS, {
      state: 'running',
      counts: { total: 1, transcribed: 0, failed: 0, skipped: 0, inFlight: 1 },
      lastItem: { id: UUID, status: 'cancelled' },
    } as never);

    expect(send).not.toHaveBeenCalled();
  });
});
