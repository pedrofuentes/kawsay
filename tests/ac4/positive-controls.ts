import { spawn } from 'node:child_process';
import dnsPromises from 'node:dns/promises';
import * as http from 'node:http';
import * as http2 from 'node:http2';
import { createRequire } from 'node:module';
import * as net from 'node:net';
import * as tls from 'node:tls';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

/**
 * AC-4 positive controls (ARCHITECTURE §6.2 — anti-false-pass).
 *
 * Deliberate outbound attempts that the egress harness MUST catch, from the
 * **main process**, a **worker thread**, and a **simulated ffmpeg subprocess**.
 * If the guard/spies/firewall were a silent no-op, these would escape and the
 * suite would fail. Every attempt is classified `blocked` when it errors, throws,
 * or times out, and `escaped` only if a connection is actually established.
 *
 * In-process (Vitest, no firewall) the default target is a closed loopback port
 * so the attempts fail without leaving the machine; the OS-deny CI job overrides
 * `KAWSAY_AC4_TARGET_*` with a routable address so the firewall is the blocker.
 */

const requireBuiltin = createRequire(import.meta.url);

const ATTEMPT_TIMEOUT_MS = 2_500;
const WORKER_TIMEOUT_MS = 10_000;
const SUBPROCESS_TIMEOUT_MS = 12_000;

export type EgressSource = 'main' | 'worker' | 'subprocess';

/**
 * The fine-grained outcome of an outbound attempt (#40 item 3):
 * - `blocked`  — the attempt was INITIATED and then DENIED (no connection made);
 * - `escaped`  — a connection was actually established (the failure case);
 * - `errored`  — the control failed BEFORE a genuine outbound attempt, so it
 *   proves nothing and must NOT be counted as `blocked`.
 */
export type EgressVerdict = 'blocked' | 'escaped' | 'errored';

export interface ControlOutcome {
  readonly source: EgressSource;
  readonly api: string;
  /** True when the attempt was caught (error/throw/timeout); false if it escaped. */
  readonly blocked: boolean;
  readonly detail: string;
  /**
   * The fine-grained verdict when the source distinguishes a genuine denied
   * attempt from a bare error (currently the worker control — #40 item 3).
   */
  readonly verdict?: EgressVerdict;
}

interface EgressTarget {
  readonly host: string;
  readonly port: number;
}

/** The outbound target for every control. Loopback-closed by default (hermetic);
 *  overridden to a routable address by the OS-deny CI job. */
export function egressTarget(): EgressTarget {
  const host = process.env['KAWSAY_AC4_TARGET_HOST'] ?? '127.0.0.1';
  const port = Number.parseInt(process.env['KAWSAY_AC4_TARGET_PORT'] ?? '49231', 10);
  return { host, port: Number.isNaN(port) ? 49231 : port };
}

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

interface Connectable {
  once(event: string, listener: (arg?: unknown) => void): unknown;
  destroy(): unknown;
}

/** Resolve once the socket connects (escaped) or rejects on error/timeout
 *  (blocked). A synchronous throw from `make` (the in-process spy) rejects too. */
function awaitConnection(api: string, make: () => Connectable): Promise<ControlOutcome> {
  return new Promise<ControlOutcome>((resolve) => {
    let settled = false;
    const finish = (blocked: boolean, detail: string, socket?: Connectable): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      try {
        socket?.destroy();
      } catch {
        /* best-effort cleanup */
      }
      resolve({ source: 'main', api, blocked, detail });
    };
    const timer = setTimeout(() => {
      finish(true, 'timed out — blocked');
    }, ATTEMPT_TIMEOUT_MS);

    let socket: Connectable;
    try {
      socket = make();
    } catch (error) {
      finish(true, messageOf(error));
      return;
    }
    socket.once('connect', () => {
      finish(false, 'connection established — ESCAPED', socket);
    });
    socket.once('secureConnect', () => {
      finish(false, 'tls handshake completed — ESCAPED', socket);
    });
    socket.once('error', (error) => {
      finish(true, messageOf(error), socket);
    });
  });
}

export function attemptTcpFromMain(): Promise<ControlOutcome> {
  const { host, port } = egressTarget();
  return awaitConnection('net.createConnection', () => net.createConnection({ host, port }));
}

export function attemptTlsFromMain(): Promise<ControlOutcome> {
  const { host, port } = egressTarget();
  return awaitConnection('tls.connect', () =>
    tls.connect({ host, port, rejectUnauthorized: false }),
  );
}

export function attemptHttp2FromMain(): Promise<ControlOutcome> {
  const { host, port } = egressTarget();
  return new Promise<ControlOutcome>((resolve) => {
    let settled = false;
    const finish = (blocked: boolean, detail: string, session?: http2.ClientHttp2Session): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      try {
        session?.destroy();
      } catch {
        /* best-effort cleanup */
      }
      resolve({ source: 'main', api: 'http2.connect', blocked, detail });
    };
    const timer = setTimeout(() => {
      finish(true, 'timed out — blocked');
    }, ATTEMPT_TIMEOUT_MS);
    try {
      const session = http2.connect(`http://${host}:${String(port)}`);
      session.once('connect', () => {
        finish(false, 'connection established — ESCAPED', session);
      });
      session.once('error', (error) => {
        finish(true, messageOf(error), session);
      });
    } catch (error) {
      finish(true, messageOf(error));
    }
  });
}

export function attemptUdpFromMain(): Promise<ControlOutcome> {
  const { host, port } = egressTarget();
  return new Promise<ControlOutcome>((resolve) => {
    const dgram = requireBuiltin('node:dgram') as typeof import('node:dgram');
    let socket: import('node:dgram').Socket | undefined;
    try {
      socket = dgram.createSocket('udp4');
      socket.send(Buffer.from('ac4'), port, host, (error) => {
        try {
          socket?.close();
        } catch {
          /* best-effort cleanup */
        }
        resolve({
          source: 'main',
          api: 'dgram.Socket.send',
          blocked: error != null,
          detail: error == null ? 'datagram sent — ESCAPED' : messageOf(error),
        });
      });
    } catch (error) {
      try {
        socket?.close();
      } catch {
        /* best-effort cleanup */
      }
      resolve({
        source: 'main',
        api: 'dgram.Socket.send',
        blocked: true,
        detail: messageOf(error),
      });
    }
  });
}

export function attemptDnsLookupFromMain(): Promise<ControlOutcome> {
  const { host } = egressTarget();
  return new Promise<ControlOutcome>((resolve) => {
    const dns = requireBuiltin('node:dns') as typeof import('node:dns');
    try {
      dns.lookup(`probe.${host}.invalid`, (error) => {
        resolve({
          source: 'main',
          api: 'dns.lookup',
          blocked: error != null,
          detail: error == null ? 'resolved — ESCAPED' : messageOf(error),
        });
      });
    } catch (error) {
      resolve({ source: 'main', api: 'dns.lookup', blocked: true, detail: messageOf(error) });
    }
  });
}

export function attemptDnsResolveFromMain(): Promise<ControlOutcome> {
  const { host } = egressTarget();
  return new Promise<ControlOutcome>((resolve) => {
    const dns = requireBuiltin('node:dns') as typeof import('node:dns');
    try {
      dns.resolve(`probe.${host}.invalid`, (error) => {
        resolve({
          source: 'main',
          api: 'dns.resolve',
          blocked: error != null,
          detail: error == null ? 'resolved — ESCAPED' : messageOf(error),
        });
      });
    } catch (error) {
      resolve({ source: 'main', api: 'dns.resolve', blocked: true, detail: messageOf(error) });
    }
  });
}

export async function attemptDnsPromisesFromMain(): Promise<ControlOutcome> {
  const { host } = egressTarget();
  try {
    await dnsPromises.lookup(`probe.${host}.invalid`);
    return {
      source: 'main',
      api: 'dns.promises.lookup',
      blocked: false,
      detail: 'resolved — ESCAPED',
    };
  } catch (error) {
    return { source: 'main', api: 'dns.promises.lookup', blocked: true, detail: messageOf(error) };
  }
}

export function attemptHttpFromMain(): Promise<ControlOutcome> {
  const { host, port } = egressTarget();
  return new Promise<ControlOutcome>((resolve) => {
    let settled = false;
    const finish = (blocked: boolean, detail: string, request?: http.ClientRequest): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      try {
        request?.destroy();
      } catch {
        /* best-effort cleanup */
      }
      resolve({ source: 'main', api: 'http.get', blocked, detail });
    };
    const timer = setTimeout(() => {
      finish(true, 'timed out — blocked');
    }, ATTEMPT_TIMEOUT_MS);
    try {
      const request = http.get({ host, port, path: '/' }, (response) => {
        response.destroy();
        finish(false, 'response received — ESCAPED', request);
      });
      request.once('error', (error) => {
        finish(true, messageOf(error), request);
      });
    } catch (error) {
      finish(true, messageOf(error));
    }
  });
}

/** Every main-process control, in one list, for the spy-layer assertion. */
export function mainProcessControls(): ReadonlyArray<() => Promise<ControlOutcome>> {
  return [
    attemptTcpFromMain,
    attemptTlsFromMain,
    attemptHttp2FromMain,
    attemptUdpFromMain,
    attemptDnsLookupFromMain,
    attemptDnsResolveFromMain,
    attemptDnsPromisesFromMain,
  ];
}

/** Overrides for the worker positive control — the only recognized hook is a
 *  deterministic pre-attempt failure used to prove `errored` is not a false-pass
 *  `blocked` (#40 item 3). */
export interface WorkerControlOverrides {
  readonly simulateErrorBeforeAttempt?: boolean;
}

export function attemptEgressFromWorker(
  overrides: WorkerControlOverrides = {},
): Promise<ControlOutcome> {
  const workerUrl = new URL('./egress-worker.mjs', import.meta.url);
  const { host, port } = egressTarget();
  return new Promise<ControlOutcome>((resolve, reject) => {
    const worker = new Worker(workerUrl, { workerData: { host, port, ...overrides } });
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new Error('worker positive control timed out'));
    }, WORKER_TIMEOUT_MS);
    worker.once(
      'message',
      (message: { verdict?: unknown; detail?: unknown; api?: unknown }) => {
        clearTimeout(timer);
        void worker.terminate();
        // A genuine denied attempt is `blocked`; a connection is `escaped`;
        // anything else (incl. a missing/unknown verdict) is `errored` and must
        // NOT be a false-pass `blocked` (#40 item 3).
        const verdict: EgressVerdict =
          message.verdict === 'blocked' || message.verdict === 'escaped'
            ? message.verdict
            : 'errored';
        resolve({
          source: 'worker',
          api: typeof message.api === 'string' ? message.api : 'net.createConnection',
          blocked: verdict === 'blocked',
          verdict,
          detail: typeof message.detail === 'string' ? message.detail : '',
        });
      },
    );
    worker.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

export function attemptEgressFromSubprocess(): Promise<ControlOutcome> {
  const scriptPath = fileURLToPath(new URL('./egress-subprocess.mjs', import.meta.url));
  const { host, port } = egressTarget();
  return new Promise<ControlOutcome>((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      env: {
        ...process.env,
        KAWSAY_AC4_TARGET_HOST: host,
        KAWSAY_AC4_TARGET_PORT: String(port),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('subprocess positive control timed out'));
    }, SUBPROCESS_TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', () => {
      clearTimeout(timer);
      const line = stdout.trim().split('\n').filter(Boolean).pop() ?? '';
      try {
        const parsed = JSON.parse(line) as { blocked?: unknown; detail?: unknown; api?: unknown };
        resolve({
          source: 'subprocess',
          api: typeof parsed.api === 'string' ? parsed.api : 'net.createConnection',
          blocked: parsed.blocked === true,
          detail: typeof parsed.detail === 'string' ? parsed.detail : stderr,
        });
      } catch (error) {
        reject(
          new Error(`could not parse subprocess result (${messageOf(error)}); stderr=${stderr}`),
        );
      }
    });
  });
}
