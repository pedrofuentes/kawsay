import * as dgram from 'node:dgram';
import dnsPromises from 'node:dns/promises';
import { createRequire } from 'node:module';
import * as net from 'node:net';
import nock from 'nock';

/**
 * AC-4 in-process egress spies (ARCHITECTURE §6.2 — the defense-in-depth layer).
 *
 * Installs deny-and-record interceptors over every Node outbound primitive so a
 * representative import/use flow can be asserted to make **zero** outbound
 * connections. The OS-level firewall (`.github/workflows/ac4-egress.yml`) is the
 * *authoritative* layer that also covers worker threads + the ffmpeg subprocess;
 * these spies are the legible, fast, defense-in-depth proof for the main process.
 *
 * Interception strategy: socket-based egress (`net.createConnection`/`net.connect`
 * and the TCP layer of `tls.connect` + `http2.connect`) all funnel through
 * `net.Socket.prototype.connect`, and UDP through `dgram.Socket.prototype.send` —
 * patching the shared prototype is observed regardless of ESM/CJS import style.
 * The `http(s)` client layer is denied with `nock.disableNetConnect()` (the tool
 * PRD AC-4 names). DNS is patched on the shared `node:dns` singleton + the
 * `node:dns/promises` object.
 */

const requireBuiltin = createRequire(import.meta.url);

export interface EgressAttempt {
  /** The intercepted API, e.g. `net.Socket.connect` or `dns.lookup`. */
  readonly api: string;
  /** Best-effort description of the outbound target. */
  readonly target: string;
}

/** The deny signal thrown by every spy the moment an outbound primitive is used. */
export class EgressBlockedError extends Error {
  constructor(
    readonly api: string,
    readonly target: string,
  ) {
    super(`[ac4] blocked outbound ${api} -> ${target}`);
    this.name = 'EgressBlockedError';
  }
}

export interface EgressSpyHandle {
  /** Every outbound attempt recorded since the spies were installed. */
  readonly attempts: readonly EgressAttempt[];
  /** Throw if any outbound attempt was recorded (the AC-4 assertion). */
  assertNoEgress(): void;
  /** Restore every patched primitive and re-enable real net connect. */
  restore(): void;
}

type UnknownFn = (...args: readonly unknown[]) => unknown;

function overrideMethod(holder: object, key: string, impl: UnknownFn): () => void {
  const record = holder as Record<string, unknown>;
  const original = record[key];
  Object.defineProperty(record, key, { configurable: true, writable: true, value: impl });
  return () => {
    Object.defineProperty(record, key, { configurable: true, writable: true, value: original });
  };
}

function describeSocketTarget(args: readonly unknown[]): string {
  const first = args[0];
  if (typeof first === 'number') {
    const host = typeof args[1] === 'string' ? args[1] : 'localhost';
    return `${host}:${String(first)}`;
  }
  if (typeof first === 'string') {
    return first;
  }
  if (first !== null && typeof first === 'object') {
    const opts = first as { host?: unknown; port?: unknown; path?: unknown };
    if (typeof opts.path === 'string') {
      return opts.path;
    }
    const host = typeof opts.host === 'string' ? opts.host : 'unknown-host';
    const port = opts.port === undefined ? '' : String(opts.port);
    return `${host}:${port}`;
  }
  return 'unknown';
}

function describeDatagramTarget(args: readonly unknown[]): string {
  const host = args.find((arg): arg is string => typeof arg === 'string');
  const port = args.find((arg): arg is number => typeof arg === 'number');
  return `${host ?? 'unknown-host'}:${port === undefined ? '' : String(port)}`;
}

function describeName(args: readonly unknown[]): string {
  const name = args.find((arg): arg is string => typeof arg === 'string');
  return name ?? 'unknown-name';
}

function describeHttpTarget(req: unknown): string {
  if (req !== null && typeof req === 'object') {
    const candidate = req as { href?: unknown; options?: { href?: unknown } };
    if (typeof candidate.href === 'string') {
      return candidate.href;
    }
    if (candidate.options && typeof candidate.options.href === 'string') {
      return candidate.options.href;
    }
  }
  return 'http-host';
}

export function installEgressSpies(): EgressSpyHandle {
  const attempts: EgressAttempt[] = [];
  const restorers: Array<() => void> = [];

  const deny = (api: string, target: string): never => {
    attempts.push({ api, target });
    throw new EgressBlockedError(api, target);
  };

  // Raw TCP — covers net.createConnection/net.connect and the TCP layer of
  // tls.connect + http2.connect, which all funnel through this prototype method.
  restorers.push(
    overrideMethod(net.Socket.prototype, 'connect', (...args: readonly unknown[]) =>
      deny('net.Socket.connect', describeSocketTarget(args)),
    ),
  );

  // UDP — dgram socket send + connected-send.
  const datagramProto = (dgram as unknown as { Socket: { prototype: object } }).Socket.prototype;
  restorers.push(
    overrideMethod(datagramProto, 'send', (...args: readonly unknown[]) =>
      deny('dgram.Socket.send', describeDatagramTarget(args)),
    ),
  );
  restorers.push(
    overrideMethod(datagramProto, 'connect', (...args: readonly unknown[]) =>
      deny('dgram.Socket.connect', describeDatagramTarget(args)),
    ),
  );

  // DNS — the callback API (shared CJS singleton) and the promises API object.
  const dnsCallback = requireBuiltin('node:dns') as object;
  for (const fn of ['lookup', 'resolve'] as const) {
    restorers.push(
      overrideMethod(dnsCallback, fn, (...args: readonly unknown[]) =>
        deny(`dns.${fn}`, describeName(args)),
      ),
    );
  }
  const dnsPromisesHolder = dnsPromises as unknown as object;
  for (const fn of ['lookup', 'resolve'] as const) {
    restorers.push(
      overrideMethod(dnsPromisesHolder, fn, (...args: readonly unknown[]) =>
        deny(`dns.promises.${fn}`, describeName(args)),
      ),
    );
  }

  // http(s) client layer — the AC-4-named control.
  nock.disableNetConnect();
  const onNoMatch = (req: unknown): void => {
    attempts.push({ api: 'http.ClientRequest', target: describeHttpTarget(req) });
  };
  nock.emitter.on('no match', onNoMatch);
  restorers.push(() => {
    nock.emitter.removeListener('no match', onNoMatch);
    nock.enableNetConnect();
    nock.cleanAll();
  });

  return {
    attempts,
    assertNoEgress(): void {
      if (attempts.length > 0) {
        const list = attempts.map((attempt) => `${attempt.api} -> ${attempt.target}`).join(', ');
        throw new Error(`[ac4] expected zero outbound attempts, observed: ${list}`);
      }
    },
    restore(): void {
      while (restorers.length > 0) {
        restorers.pop()?.();
      }
    },
  };
}
