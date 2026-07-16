// The ONE main-process logger (#440). Every ad-hoc `console.warn/error` diagnostic
// routes through here so redaction happens in exactly one place: any `Error` argument
// is projected to its safe {name, code} shape ({@link projectError}) BEFORE it reaches
// the console, so a diagnostic can never leak a raw message/stack (a path, an id, or
// item text). Local console ONLY — no telemetry, no egress (AC-4). Backed by the
// native console per level, so existing test spies on `console.warn/error` still work.
import { projectError } from '@shared/ipc/error-envelope';

/** Ordered log levels; a logger emits a level only if it is at/above its threshold. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/** The console-shaped sink a logger writes to (injected so it unit-tests without a
 *  real console, and so the redaction is observable). */
export type LogSink = Pick<Console, LogLevel>;

export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

export interface LoggerOptions {
  /** Minimum level to emit. When omitted, derived from {@link LoggerOptions.isPackaged}. */
  readonly level?: LogLevel;
  /** Where emissions go. Defaults to the native `console`. */
  readonly sink?: LogSink;
  /**
   * Whether this is a packaged (shipped) build. When `level` is omitted the default
   * threshold is derived from THIS — packaged → `warn`, unpackaged (dev) → `debug`.
   * It is INJECTED (from `app.isPackaged`, wired in `electron/main/index.ts`) rather
   * than read from `process.env.NODE_ENV` — which the packaged Electron app never
   * sets, so an env-based default would leave the shipped build chatty — and never
   * from a `require('electron')` here, so `log.ts` stays unit-testable off a runtime.
   */
  readonly isPackaged?: boolean;
}

/** Packaged (shipped) builds stay quiet below `warn`; dev is chattier. BOTH redact
 *  unconditionally — the level only gates verbosity, never leakage. */
function defaultLevel(isPackaged: boolean | undefined): LogLevel {
  return isPackaged ? 'warn' : 'debug';
}

/** Project any `Error` argument to its safe {name, code} shape; leave already-safe
 *  (non-Error) diagnostics untouched. THE redaction point for log arguments. */
function redactArg(arg: unknown): unknown {
  return arg instanceof Error ? projectError(arg) : arg;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const sink = options.sink ?? console;
  const threshold = LEVEL_ORDER[options.level ?? defaultLevel(options.isPackaged)];

  function emit(level: LogLevel, message: string, args: unknown[]): void {
    if (LEVEL_ORDER[level] < threshold) return;
    // Static dispatch (each console method called by its literal name) rather than a
    // computed `sink[level]` lookup: identical behaviour, but statically analysable —
    // no dynamic method resolution for a SAST pass to flag (unsafe-dynamic-method).
    const redacted = args.map(redactArg);
    switch (level) {
      case 'debug':
        sink.debug(message, ...redacted);
        return;
      case 'info':
        sink.info(message, ...redacted);
        return;
      case 'warn':
        sink.warn(message, ...redacted);
        return;
      case 'error':
        sink.error(message, ...redacted);
        return;
    }
  }

  return {
    debug: (message, ...args) => emit('debug', message, args),
    info: (message, ...args) => emit('info', message, args),
    warn: (message, ...args) => emit('warn', message, args),
    error: (message, ...args) => emit('error', message, args),
  };
}

// The shared main-process logger singleton. Its verbosity depends on packaged state,
// which is only known once the Electron `app` exists — so the singleton starts at the
// dev-safe default and `configureLog` re-derives the threshold at process start (from
// `app.isPackaged`, in `electron/main/index.ts`). Redaction is unconditional, so even
// before configuration nothing can leak; only the debug/info verbosity gate changes.
let active: Logger = createLogger();

/** Reconfigure the shared {@link log} — called once at startup with the injected
 *  packaged state so the shipped build's default threshold is `warn`, not `debug`. */
export function configureLog(options: LoggerOptions): void {
  active = createLogger(options);
}

export const log: Logger = {
  debug: (message, ...args) => active.debug(message, ...args),
  info: (message, ...args) => active.info(message, ...args),
  warn: (message, ...args) => active.warn(message, ...args),
  error: (message, ...args) => active.error(message, ...args),
};
