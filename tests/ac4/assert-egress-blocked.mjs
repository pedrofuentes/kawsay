// AC-4 firewall self-check (ARCHITECTURE §6.2 — self-asserting OS-deny).
//
// Proves the outbound-DENY firewall is ACTUALLY in force before the suite trusts
// it: deliberately attempts a TCP connection to a ROUTABLE public address that
// would normally succeed. Under the DROP policy the SYN is silently discarded, so
// the connection errors or times out — that is the PASS. If the connection is
// established, egress is NOT blocked: the firewall is misconfigured and the job
// must fail (exit 1), so a green AC-4 can never be a silent no-op. TEST-ONLY.
import { createConnection } from 'node:net';

const HOST = process.env.KAWSAY_AC4_PUBLIC_HOST ?? '1.1.1.1';
const PORT = Number.parseInt(process.env.KAWSAY_AC4_PUBLIC_PORT ?? '443', 10);
const CONNECT_TIMEOUT_MS = 8_000;

function messageOf(error) {
  return error?.message ?? String(error);
}

const target = `${HOST}:${String(PORT)}`;
console.log(`[ac4-firewall] verifying outbound DENY is active by probing ${target}`);

const result = await new Promise((resolve) => {
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
    finish(true, 'timed out — SYN dropped by firewall');
  }, CONNECT_TIMEOUT_MS);
  try {
    socket = createConnection({ host: HOST, port: PORT });
    socket.once('connect', () => {
      finish(false, 'connection established — egress NOT blocked');
    });
    socket.once('error', (error) => {
      finish(true, messageOf(error));
    });
  } catch (error) {
    finish(true, messageOf(error));
  }
});

if (!result.blocked) {
  console.error(`[ac4-firewall] FAIL: ${target} reachable — outbound firewall is NOT active`);
  process.exit(1);
}
console.log(`[ac4-firewall] PASS: outbound egress to ${target} is blocked (${result.detail})`);
