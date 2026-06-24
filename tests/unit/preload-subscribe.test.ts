import { describe, expect, it, vi } from 'vitest';
import { createValidatedSubscribe } from '../../electron/preload/subscribe';
import { IMPORT_PROGRESS, type ImportProgressEvent } from '@shared/ipc/events';

const UUID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const validEvent: ImportProgressEvent = {
  jobId: UUID,
  phase: 'emit',
  processed: 1,
  total: 3,
  message: null,
  summary: null,
  error: null,
};

/** A raw event transport double: captures the channel listener and lets the
 *  test push payloads (as the main process would). */
function fakeTransport() {
  const listeners = new Map<string, (payload: unknown) => void>();
  let unsubscribed = 0;
  const rawSubscribe = (channel: string, listener: (payload: unknown) => void) => {
    listeners.set(channel, listener);
    return () => {
      unsubscribed += 1;
      listeners.delete(channel);
    };
  };
  return {
    rawSubscribe,
    push: (channel: string, payload: unknown) => listeners.get(channel)?.(payload),
    has: (channel: string) => listeners.has(channel),
    get unsubscribed() {
      return unsubscribed;
    },
  };
}

describe('createValidatedSubscribe (preload event guard)', () => {
  it('forwards a valid event payload to the listener', () => {
    const transport = fakeTransport();
    const subscribe = createValidatedSubscribe(transport.rawSubscribe);
    const received: ImportProgressEvent[] = [];

    subscribe(IMPORT_PROGRESS, (event) => received.push(event));
    transport.push(IMPORT_PROGRESS, validEvent);

    expect(received).toEqual([validEvent]);
  });

  it('DROPS a malformed event so it never reaches the renderer listener', () => {
    const transport = fakeTransport();
    const subscribe = createValidatedSubscribe(transport.rawSubscribe);
    const listener = vi.fn();

    subscribe(IMPORT_PROGRESS, listener);
    transport.push(IMPORT_PROGRESS, { ...validEvent, phase: 'teleporting' });
    transport.push(IMPORT_PROGRESS, { ...validEvent, rogue: true });
    transport.push(IMPORT_PROGRESS, 'not even an object');

    expect(listener).not.toHaveBeenCalled();
  });

  it('returns a working unsubscribe', () => {
    const transport = fakeTransport();
    const subscribe = createValidatedSubscribe(transport.rawSubscribe);

    const unsubscribe = subscribe(IMPORT_PROGRESS, () => {});
    expect(transport.has(IMPORT_PROGRESS)).toBe(true);
    unsubscribe();
    expect(transport.unsubscribed).toBe(1);
    expect(transport.has(IMPORT_PROGRESS)).toBe(false);
  });
});
