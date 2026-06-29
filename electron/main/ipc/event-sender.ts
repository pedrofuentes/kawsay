// Main-side event emitter for the one-way `import:progress` stream. It is the
// LAST guard before a payload crosses into the renderer: every event is
// validated against the event contract and a malformed one is DROPPED, never
// sent — symmetric with the preload subscriber, which re-validates on receipt.
// The raw transport (`webContents.send`) is injected so this stays pure and
// unit-testable without an Electron runtime.

import {
  ipcEventContract,
  type IpcEventChannel,
  type IpcEventPayload,
} from '@shared/ipc/events';
import type { z } from 'zod';

/** The underlying one-way transport (`webContents.send`), injected. */
export type RawEventSend = (channel: string, payload: unknown) => void;

export interface InvalidEventDiagnostic {
  channel: IpcEventChannel;
  issues: z.ZodIssue[];
}

export interface EventSenderOptions {
  onInvalidEvent?: (diagnostic: InvalidEventDiagnostic) => void;
}

/**
 * Build the validated `emit` helper the main process uses to stream events to
 * the renderer. A payload that fails its schema is dropped (a main-side bug
 * should never crash the relay nor push an unexpected shape at React).
 */
export function createEventSender(send: RawEventSend, options: EventSenderOptions = {}) {
  return function emit<C extends IpcEventChannel>(channel: C, payload: IpcEventPayload<C>): void {
    const schema = ipcEventContract[channel];
    const result = schema.safeParse(payload);
    if (result.success) {
      send(channel, result.data);
    } else {
      options.onInvalidEvent?.({ channel, issues: result.error.issues });
    }
  };
}
