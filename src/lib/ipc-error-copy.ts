// The renderer's single map from a redacted IPC error CODE → calm, reverent,
// non-technical copy (#440). On the invoke error path, a main-process fault is
// redacted to a stable {code, name} (the raw message/stack never crosses), so
// user-facing failure copy is derived HERE from the code, never from raw error
// text. (This map covers invoke rejections; the one-way import-progress error
// channel applies its own redaction — a safe fixed string — in the ingestion
// coordinator. It is not a claim that literally no channel anywhere crosses a raw
// message.) Tone mirrors the existing "Nothing was lost — please try again"
// reassurances (use-categorization / favourite).
import { IPC_ERROR_CODES, ipcErrorCodeOf } from '@shared/ipc/error-envelope';

/** The gentle catch-all: honest that the action didn't complete, calm that memories
 *  are safe, and an invitation to retry. */
const FALLBACK_COPY = 'Something interrupted that just now. Nothing was lost — please try again.';

const COPY_BY_CODE: Record<string, string> = {
  [IPC_ERROR_CODES.UNTRUSTED_SENDER]:
    "Kawsay couldn't verify that request. Please restart Kawsay and try again.",
  [IPC_ERROR_CODES.BAD_REQUEST]: FALLBACK_COPY,
  [IPC_ERROR_CODES.BAD_RESPONSE]: FALLBACK_COPY,
  [IPC_ERROR_CODES.HANDLER_FAULT]: FALLBACK_COPY,
};

/**
 * Map any thrown invoke error to reverent, user-facing copy VIA its stable code —
 * never the raw message (which no longer crosses). A non-{@link IpcError} (e.g. a
 * missing preload bridge, or an unexpected local throw) falls back to the same calm
 * catch-all, so no raw error text ever reaches the UI.
 */
export function ipcErrorCopy(error: unknown): string {
  // `ipcErrorCodeOf` recovers the code from an IpcError instance OR a tagged plain
  // Error (the contextBridge crossing into the page strips custom fields but keeps
  // the message that encodes the code). An untagged error yields '' → calm fallback.
  return COPY_BY_CODE[ipcErrorCodeOf(error)] ?? FALLBACK_COPY;
}
