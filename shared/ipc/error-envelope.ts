// The redaction contract for the INVOKE error path — shared by main (which builds
// the error the IPC registrar throws) and the renderer/preload (which unwraps it). A
// fault surfaced through this envelope must NEVER forward its raw `message`/`stack`
// to the renderer — those can carry a filesystem path, an opaque id, or item text
// (the #440 invariant). Instead the fault is reduced to a stable `code` (the renderer
// switches on it for calm copy) plus the error class `name`, and nothing else rides
// the envelope. (`projectError` is the single redaction projection reused by the
// logger too; other one-way event channels apply their own redaction — e.g. the
// import-progress error delivers a safe fixed string from the ingestion coordinator.
// This module is the invoke path's contract, not a blanket claim about every channel.)
//
// TRANSPORT NOTE: the safe {code, name} payload travels ENCODED IN `Error.message`.
// That is deliberate — `message` is the only error field that survives BOTH hops a
// rejection makes: Electron's `ipcMain.handle` → `ipcRenderer.invoke` serialization
// (which mangles a thrown plain object and drops custom own-properties) AND the
// preload→page `contextBridge` crossing (which clones the error, keeping `message`
// but stripping any custom subclass fields). So the envelope rides inside a tagged
// message and the `stack` is scrubbed — the message itself is built ONLY from the
// redacted {code, name}, so no raw text crosses via this envelope.
import { z } from 'zod';

/** Prefix that tags an `Error.message` as a redacted IPC error payload. */
export const IPC_ERROR_TAG = 'KAWSAY_IPC_ERR:';

/**
 * Stable, renderer-switchable error codes (`ERR_SCREAMING_SNAKE`, ARCHITECTURE
 * §naming). Codes — never raw messages — are what cross the boundary and drive copy.
 */
export const IPC_ERROR_CODES = {
  /** The sender origin failed the trust check (attacker-dropped HTML, wrong frame). */
  UNTRUSTED_SENDER: 'ERR_IPC_UNTRUSTED_SENDER',
  /** The request payload failed main's zod re-validation. */
  BAD_REQUEST: 'ERR_IPC_BAD_REQUEST',
  /** The handler's reply failed the response-schema validation. */
  BAD_RESPONSE: 'ERR_IPC_BAD_RESPONSE',
  /** The business handler threw (or rejected) — the catch-all fault code. */
  HANDLER_FAULT: 'ERR_IPC_HANDLER_FAULT',
} as const;

/** A stable IPC error code — one of {@link IPC_ERROR_CODES} or an errno-style code
 *  (e.g. `EACCES`, `ERR_NATIVE_MODULE`) the originating error carried. */
export type IpcErrorCode = (typeof IPC_ERROR_CODES)[keyof typeof IPC_ERROR_CODES] | string;

/** The privacy-safe projection of any thrown value: its class `name` and, when the
 *  value carried a string `code`, that code — NEVER the message/stack. */
export interface SafeError {
  readonly name: string;
  readonly code?: string;
}

/**
 * The single redaction projection (#440). Every logger emission and every IPC error
 * derives its safe shape HERE, so there is exactly one place that decides what an
 * error may reveal: only `name` (+ an optional string `code`). The raw
 * `message`/`stack` — which can carry a path, an id, or item text — are dropped and
 * never reconstructed.
 */
export function projectError(error: unknown): SafeError {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' && code.length > 0
      ? { name: error.name, code }
      : { name: error.name };
  }
  return { name: typeof error };
}

/**
 * The redacted wire payload: a stable `code` + the error class `name`. NEVER a
 * `message` or `stack`. `strict()` so a malformed/oversized payload can't slip
 * through the decode.
 *
 * `code` is ALSO charset-guarded (defense-in-depth, #481): every value it takes
 * today — a static {@link IPC_ERROR_CODES} entry (`ERR_SCREAMING_SNAKE`) or a
 * Node errno-style code an origin error carried (e.g. `EACCES`,
 * `ERR_NATIVE_MODULE`) — is uppercase ASCII letters/digits/underscore only, so a
 * decoded `code` outside that charset can never be one of ours; the guard just
 * makes that invariant explicit rather than relying on length alone. `name` is
 * NOT charset-guarded: it legitimately carries PascalCase error class names
 * (`CatalogSessionError`, `ZodError`, `TypeError`) that a fixed charset can't
 * predict.
 */
export const ipcErrorPayloadSchema = z
  .object({
    code: z
      .string()
      .min(1)
      .max(120)
      .regex(/^[A-Z0-9_]+$/),
    name: z.string().min(1).max(120),
  })
  .strict();
export type IpcErrorPayload = z.infer<typeof ipcErrorPayloadSchema>;

/** Encode a redacted payload into a tagged message string (the wire form). */
export function encodeIpcErrorMessage(payload: IpcErrorPayload): string {
  return `${IPC_ERROR_TAG}${JSON.stringify(payload)}`;
}

/**
 * Recover the redacted payload from a tagged message; `null` if it isn't one. The
 * tag is located by SEARCH, not prefix: Electron wraps a rejected `ipcRenderer.invoke`
 * message as `Error invoking remote method '<channel>': <name>: <message>`, so the
 * tagged JSON arrives EMBEDDED (at the tail), not at position 0. The JSON is always
 * the message tail, so we parse from the tag to the end.
 */
export function decodeIpcErrorMessage(message: unknown): IpcErrorPayload | null {
  if (typeof message !== 'string') return null;
  const at = message.indexOf(IPC_ERROR_TAG);
  if (at < 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(message.slice(at + IPC_ERROR_TAG.length));
  } catch {
    return null;
  }
  const result = ipcErrorPayloadSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

/**
 * Main-side redaction gate: build the `Error` to throw across `ipcMain.handle`. Its
 * `message` encodes ONLY the safe {code, name} (the value's own string `code` when
 * present — e.g. an errno — else the stable fallback), and its `stack` is scrubbed to
 * that same encoding so no incidental frame path crosses. The raw message/stack are
 * dropped HERE and never reconstructed.
 */
export function makeIpcError(error: unknown, fallbackCode: IpcErrorCode): Error {
  const { name, code } = projectError(error);
  const message = encodeIpcErrorMessage({ code: code ?? fallbackCode, name });
  const wireError = new Error(message);
  wireError.name = 'IpcError';
  wireError.stack = message;
  return wireError;
}

/**
 * The renderer/preload-side typed error. Carries the redacted `code` (switch on it
 * for copy) and the origin error class `name`. Its `message` is the SAME encoded
 * payload, so the code survives the `contextBridge` crossing into the page (where the
 * custom `code`/`originName` fields are stripped but `message` is preserved) — the
 * page recovers the code from the message. No raw main-side text is ever present.
 */
export class IpcError extends Error {
  readonly code: IpcErrorCode;
  /** The originating main-side error class name (redaction-safe — no message). */
  readonly originName: string;
  constructor(code: IpcErrorCode, originName: string) {
    super(encodeIpcErrorMessage({ code, name: originName }));
    this.name = 'IpcError';
    this.code = code;
    this.originName = originName;
    this.stack = this.message;
  }
}

/** True when `value` is an {@link IpcError} instance (same-world checks). */
export function isIpcError(value: unknown): value is IpcError {
  return value instanceof IpcError;
}

/**
 * Reconstruct the typed {@link IpcError} from ANY rejection — recovering {code, name}
 * from the tagged message when present (a main→preload OR preload→page rejection), or
 * falling back to `fallbackCode` + the error's class name for an untagged rejection.
 * Either way the result is REDACTED: no raw message/stack is ever surfaced.
 */
export function ipcErrorFrom(error: unknown, fallbackCode: IpcErrorCode): IpcError {
  if (error instanceof IpcError) return error;
  const payload = error instanceof Error ? decodeIpcErrorMessage(error.message) : null;
  if (payload) return new IpcError(payload.code, payload.name);
  return new IpcError(fallbackCode, error instanceof Error ? error.name : 'Error');
}

/** The stable code carried by any invoke rejection — from an {@link IpcError}
 *  instance or a tagged plain `Error` (post-`contextBridge`); `''` if none. */
export function ipcErrorCodeOf(error: unknown): string {
  if (error instanceof IpcError) return error.code;
  if (error instanceof Error) {
    const payload = decodeIpcErrorMessage(error.message);
    if (payload) return payload.code;
  }
  return '';
}
