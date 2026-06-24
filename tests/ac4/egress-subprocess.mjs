// AC-4 positive control — SIMULATED ffmpeg SUBPROCESS outbound attempt
// (ARCHITECTURE §6.2). Real `ffmpeg`/`ffprobe` only ever receive local file
// paths (§7), so they can never egress; this stand-in models "a spawned child
// binary that tries to reach the network" to prove the OS firewall catches the
// subprocess path the in-process spies cannot see. In CI the firewall is the
// authoritative blocker; in-process the default target is a closed loopback port
// so nothing leaves the machine. TEST-ONLY harness code — never ships.
import net from 'node:net';

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

const host = process.env.KAWSAY_AC4_TARGET_HOST ?? '127.0.0.1';
const port = Number(process.env.KAWSAY_AC4_TARGET_PORT ?? 49231);
const result = await attempt(host, port);
process.stdout.write(
  `${JSON.stringify({ source: 'subprocess', api: 'net.createConnection', ...result })}\n`,
);
