// AC-4 OS-deny end-to-end runner (ARCHITECTURE §6.2 — authoritative layer).
//
// Launches the positive controls from the three escape surfaces the in-process
// Vitest spies CANNOT see across isolate/process boundaries — the main process,
// a real worker thread, and a simulated ffmpeg subprocess — against the
// configured target, and asserts EVERY one is blocked. Designed to run under the
// outbound-firewall DENY job (.github/workflows/ac4-egress.yml), where
// KAWSAY_AC4_TARGET_* points at a ROUTABLE address so any real OS-level egress
// (a subprocess/worker socket or DNS lookup the spies miss) is still caught by
// the kernel firewall. A "blocked" outcome means no connection was established
// (error/drop/timeout); the ONLY failure is an actually-established connection.
// Exits non-zero if anything escapes. TEST-ONLY harness — never ships.
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

const HOST = process.env.KAWSAY_AC4_TARGET_HOST ?? '127.0.0.1';
const PORT = Number.parseInt(process.env.KAWSAY_AC4_TARGET_PORT ?? '49231', 10);

const MAIN_TIMEOUT_MS = 6_000;
const CHILD_TIMEOUT_MS = 20_000;

function messageOf(error) {
  return error?.message ?? String(error);
}

function attemptMain() {
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
      resolve({ source: 'main', blocked, detail });
    };
    const timer = setTimeout(() => {
      finish(true, 'timed out — blocked');
    }, MAIN_TIMEOUT_MS);
    try {
      socket = createConnection({ host: HOST, port: PORT });
      socket.once('connect', () => {
        finish(false, 'connection established — ESCAPED');
      });
      socket.once('error', (error) => {
        finish(true, messageOf(error));
      });
    } catch (error) {
      finish(true, messageOf(error));
    }
  });
}

function attemptWorker() {
  const workerUrl = new URL('./egress-worker.mjs', import.meta.url);
  return new Promise((resolve) => {
    const worker = new Worker(workerUrl, { workerData: { host: HOST, port: PORT } });
    const timer = setTimeout(() => {
      void worker.terminate();
      resolve({ source: 'worker', blocked: true, detail: 'runner timeout — blocked' });
    }, CHILD_TIMEOUT_MS);
    worker.once('message', (message) => {
      clearTimeout(timer);
      void worker.terminate();
      resolve({
        source: 'worker',
        blocked: message?.blocked === true,
        detail: String(message?.detail ?? ''),
      });
    });
    worker.once('error', (error) => {
      clearTimeout(timer);
      void worker.terminate();
      resolve({ source: 'worker', blocked: true, detail: `worker error — ${messageOf(error)}` });
    });
  });
}

function attemptSubprocess() {
  const scriptPath = fileURLToPath(new URL('./egress-subprocess.mjs', import.meta.url));
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath], {
      env: { ...process.env, KAWSAY_AC4_TARGET_HOST: HOST, KAWSAY_AC4_TARGET_PORT: String(PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ source: 'subprocess', blocked: true, detail: 'runner timeout — blocked' });
    }, CHILD_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      resolve({ source: 'subprocess', blocked: true, detail: `spawn error — ${messageOf(error)}` });
    });
    child.once('close', () => {
      clearTimeout(timer);
      const line = stdout.trim().split('\n').filter(Boolean).pop() ?? '';
      try {
        const parsed = JSON.parse(line);
        resolve({
          source: 'subprocess',
          blocked: parsed?.blocked === true,
          detail: String(parsed?.detail ?? stderr),
        });
      } catch {
        // No parseable verdict: treat as ESCAPED so a broken harness fails loudly
        // rather than silently passing.
        resolve({
          source: 'subprocess',
          blocked: false,
          detail: `unparseable result: "${line}" stderr=${stderr}`,
        });
      }
    });
  });
}

const target = `${HOST}:${String(PORT)}`;
console.log(`[ac4-e2e] outbound target ${target} — asserting main + worker + subprocess blocked`);

const outcomes = await Promise.all([attemptMain(), attemptWorker(), attemptSubprocess()]);

let escaped = false;
for (const outcome of outcomes) {
  const status = outcome.blocked ? 'BLOCKED' : 'ESCAPED';
  console.log(`[ac4-e2e] ${outcome.source.padEnd(10)} ${status} — ${outcome.detail}`);
  if (!outcome.blocked) {
    escaped = true;
  }
}

if (escaped) {
  console.error('[ac4-e2e] FAIL: at least one outbound attempt escaped the egress guard');
  process.exit(1);
}
console.log('[ac4-e2e] PASS: every outbound attempt was blocked');
