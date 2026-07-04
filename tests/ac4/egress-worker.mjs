// AC-4 positive control — WORKER THREAD outbound attempt (ARCHITECTURE §6.2).
//
// Runs in a real `worker_threads.Worker` (a separate V8 isolate the in-process
// spies cannot see) and deliberately attempts an outbound TCP connection. In CI
// the OS firewall is the authoritative blocker; in-process the default target is
// a closed loopback port so the attempt fails without leaving the machine. This
// file is TEST-ONLY harness code — it never ships in the product.
import net from 'node:net';
import { parentPort, workerData } from 'node:worker_threads';

const ATTEMPT_TIMEOUT_MS = 2_500;

function messageOf(error) {
  return error?.message ?? String(error);
}

// #40 item 3 — a `blocked` verdict REQUIRES that an outbound connection was
// actually INITIATED and then DENIED (refused/dropped, no connection
// established). A worker that errors BEFORE it ever attempts a connection never
// proved the guard blocked anything, so treating that as `blocked` is a
// false-pass that masks a broken harness. Such a pre-attempt failure is a
// DISTINCT `errored` verdict; only `escaped` means a connection was established.
function attempt(host, port, { simulateErrorBeforeAttempt = false } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let attempted = false;
    let socket;
    const finish = (verdict, detail) => {
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
      // `verdict` is the authoritative outcome; `blocked` is derived from it for
      // the CI e2e runner (egress-e2e.mjs), which keys on the boolean.
      resolve({ verdict, blocked: verdict === 'blocked', attempted, detail });
    };
    const timer = setTimeout(() => {
      // A timeout is `blocked` only if the attempt was actually initiated (a
      // dropped SYN); a timeout with no attempt is an `errored` harness.
      finish(attempted ? 'blocked' : 'errored', 'timed out — blocked');
    }, ATTEMPT_TIMEOUT_MS);
    try {
      if (simulateErrorBeforeAttempt) {
        // Models a worker that fails BEFORE touching the network — the exact
        // false-pass class #40 item 3 closes: it must be `errored`, not blocked.
        throw new Error('worker failed before attempting any outbound connection');
      }
      socket = net.createConnection({ host, port });
      attempted = true;
      socket.once('connect', () => {
        finish('escaped', 'connection established — ESCAPED');
      });
      socket.once('error', (error) => {
        // An error AFTER the attempt was initiated is a genuine denial.
        finish(attempted ? 'blocked' : 'errored', messageOf(error));
      });
    } catch (error) {
      // A throw only counts as a denial if the attempt was already initiated; a
      // throw before initiating (e.g. the injected crash) is `errored`.
      finish(attempted ? 'blocked' : 'errored', messageOf(error));
    }
  });
}

const host = typeof workerData?.host === 'string' ? workerData.host : '127.0.0.1';
const port = Number(workerData?.port ?? 49231);
const simulateErrorBeforeAttempt = workerData?.simulateErrorBeforeAttempt === true;
const result = await attempt(host, port, { simulateErrorBeforeAttempt });
parentPort?.postMessage({ source: 'worker', api: 'net.createConnection', ...result });
