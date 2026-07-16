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
  /** Minimum level to emit. Defaults to dev→`debug`, packaged/prod→`warn`. */
  readonly level?: LogLevel;
  /** Where emissions go. Defaults to the native `console`. */
  readonly sink?: LogSink;
}

/** Dev is chattier than prod, but BOTH redact: the projected form of an Error never
 *  carries message/stack regardless of level. Prod stays quiet below `warn`. */
function defaultLevel(): LogLevel {
  return process.env.NODE_ENV === 'production' ? 'warn' : 'debug';
}

/** Project any `Error` argument to its safe {name, code} shape; leave already-safe
 *  (non-Error) diagnostics untouched. THE redaction point for log arguments. */
function redactArg(arg: unknown): unknown {
  return arg instanceof Error ? projectError(arg) : arg;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const sink = options.sink ?? console;
  const threshold = LEVEL_ORDER[options.level ?? defaultLevel()];

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

/** The shared main-process logger singleton. */
export const log: Logger = createLogger();
