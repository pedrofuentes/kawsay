import { describe, expect, it, vi } from 'vitest';
import { createEventSender } from '../../electron/main/ipc/event-sender';
import { IMPORT_PROGRESS, type ImportProgressEvent } from '@shared/ipc/events';

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
    const emit = createEventSender(send);

    // A bad phase would otherwise reach React; the sender refuses to forward it.
    emit(IMPORT_PROGRESS, { ...validEvent, phase: 'teleporting' } as never);
    // An unknown key is rejected by the strict schema.
    emit(IMPORT_PROGRESS, { ...validEvent, rogue: true } as never);

    expect(send).not.toHaveBeenCalled();
  });
});
