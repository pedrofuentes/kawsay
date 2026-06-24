import nock from 'nock';
import { describe, expect, it } from 'vitest';
import { handleGetVersion } from '../../electron/main/ipc/handlers/app';
import { buildContentSecurityPolicy } from '../../electron/main/security/csp';
import {
  installNetworkGuard,
  isLocalOnlyRequest,
  type NetworkGuardSessionLike,
  type OnBeforeRequestListener,
} from '../../electron/main/security/network-guard';
import { EgressBlockedError, installEgressSpies } from './egress-spies';
import {
  attemptEgressFromSubprocess,
  attemptEgressFromWorker,
  attemptHttpFromMain,
  mainProcessControls,
} from './positive-controls';

const PROCESS_CONTROL_TIMEOUT_MS = 20_000;

describe('AC-4 in-process spies — positive controls catch every main-process primitive', () => {
  it('blocks and records each deliberate outbound attempt (anti false-pass)', async () => {
    const spies = installEgressSpies();
    try {
      for (const attempt of mainProcessControls()) {
        const outcome = await attempt();
        expect(outcome.blocked, `${outcome.api} escaped: ${outcome.detail}`).toBe(true);
      }
      // The spies must have observed each transport: TCP (also tls/http2 funnel
      // through it), UDP, and DNS — proving the harness is not a silent no-op.
      const apis = new Set(spies.attempts.map((attempt) => attempt.api));
      expect(apis.has('net.Socket.connect')).toBe(true);
      expect(apis.has('dgram.Socket.send')).toBe(true);
      expect(apis.has('dns.lookup')).toBe(true);
      expect(apis.has('dns.resolve')).toBe(true);
      expect(apis.has('dns.promises.lookup')).toBe(true);
    } finally {
      spies.restore();
    }
  });
});

describe('AC-4 http(s) layer is denied by nock.disableNetConnect()', () => {
  it('blocks a deliberate http request', async () => {
    nock.disableNetConnect();
    try {
      const outcome = await attemptHttpFromMain();
      expect(outcome.blocked, `http escaped: ${outcome.detail}`).toBe(true);
    } finally {
      nock.enableNetConnect();
      nock.cleanAll();
    }
  });
});

describe('AC-4 positive controls — worker thread & subprocess egress is caught', () => {
  it(
    'a worker-thread outbound attempt is blocked',
    async () => {
      const outcome = await attemptEgressFromWorker();
      expect(outcome.source).toBe('worker');
      expect(outcome.blocked, `worker escaped: ${outcome.detail}`).toBe(true);
    },
    PROCESS_CONTROL_TIMEOUT_MS,
  );

  it(
    'a simulated ffmpeg-subprocess outbound attempt is blocked',
    async () => {
      const outcome = await attemptEgressFromSubprocess();
      expect(outcome.source).toBe('subprocess');
      expect(outcome.blocked, `subprocess escaped: ${outcome.detail}`).toBe(true);
    },
    PROCESS_CONTROL_TIMEOUT_MS,
  );
});

function createFakeSession(): {
  session: NetworkGuardSessionLike;
  fire: (url: string) => void;
} {
  let listener: OnBeforeRequestListener | undefined;
  const session: NetworkGuardSessionLike = {
    webRequest: {
      onBeforeRequest(_filter, registered) {
        listener = registered;
      },
    },
  };
  const fire = (url: string): void => {
    listener?.({ url }, () => undefined);
  };
  return { session, fire };
}

describe('AC-4 representative use flow records ZERO egress', () => {
  it('exercises the available app surface and observes no outbound attempt', () => {
    const spies = installEgressSpies();
    try {
      // Build both CSP variants (the renderer-side egress kill-switch).
      buildContentSecurityPolicy();
      buildContentSecurityPolicy({ devServerUrl: 'http://localhost:5173' });

      // Decide a representative set of local requests through the guard logic.
      for (const url of [
        'file:///app/index.html',
        'kawsay-media://item/1',
        'blob:https://kawsay/x',
        'data:text/plain,hi',
      ]) {
        isLocalOnlyRequest(url, { isPackaged: true });
      }

      // Install + drive the guard on a fake session with legitimate local loads.
      const { session, fire } = createFakeSession();
      installNetworkGuard(session, { isPackaged: true });
      fire('file:///app/index.html');
      fire('kawsay-media://item/2');

      // A normal IPC use (read the app version) touches no network.
      expect(handleGetVersion({ getVersion: () => '1.2.3' })).toEqual({ version: '1.2.3' });

      spies.assertNoEgress();
      expect(spies.attempts).toHaveLength(0);
    } finally {
      spies.restore();
    }
  });
});

describe('AC-4 spy harness self-check (must not be a silent no-op)', () => {
  it('assertNoEgress throws once an outbound attempt has been recorded', async () => {
    const spies = installEgressSpies();
    try {
      await mainProcessControls()[0]?.();
      expect(spies.attempts.length).toBeGreaterThan(0);
      expect(() => {
        spies.assertNoEgress();
      }).toThrow(/zero outbound attempts/u);
    } finally {
      spies.restore();
    }
  });

  it('EgressBlockedError is the deny signal', () => {
    const error = new EgressBlockedError('net.Socket.connect', 'example.com:443');
    expect(error).toBeInstanceOf(Error);
    expect(error.api).toBe('net.Socket.connect');
    expect(error.target).toBe('example.com:443');
  });
});
