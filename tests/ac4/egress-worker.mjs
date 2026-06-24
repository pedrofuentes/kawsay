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

function attempt(host, port) {
  return new Promise((resolve) => {
    let settled = false;
    let socket;
    const finish = (blocked, detail) => {
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
      resolve({ blocked, detail });
    };
    const timer = setTimeout(() => {
      finish(true, 'timed out — blocked');
    }, ATTEMPT_TIMEOUT_MS);
    try {
      socket = net.createConnection({ host, port });
      socket.once('connect', () => {
        finish(false, 'connection established — ESCAPED');
      });
      socket.once('error', (error) => {
        finish(true, error?.message ?? String(error));
      });
    } catch (error) {
      finish(true, error?.message ?? String(error));
    }
  });
}

const host = typeof workerData?.host === 'string' ? workerData.host : '127.0.0.1';
const port = Number(workerData?.port ?? 49231);
const result = await attempt(host, port);
parentPort?.postMessage({ source: 'worker', api: 'net.createConnection', ...result });
