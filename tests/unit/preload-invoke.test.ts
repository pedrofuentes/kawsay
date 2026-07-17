import { describe, expect, it, vi } from 'vitest';
import { APP_GET_VERSION } from '@shared/ipc/contract';
import { IPC_ERROR_CODES, IpcError } from '@shared/ipc/error-envelope';
import { createValidatedInvoke } from '../../electron/preload/invoke';

/** Assert `promise` rejects with a typed {@link IpcError} carrying `code` — the
 *  discriminating check (#481 D3): a generic `.rejects.toThrow()` would pass for
 *  ANY thrown value, so it can't catch a regression that swaps in the wrong code
 *  (e.g. BAD_REQUEST leaking through as BAD_RESPONSE, or a raw zod error). */
async function expectIpcErrorCode(promise: Promise<unknown>, code: string): Promise<void> {
  const rejection = await promise.then(
    () => {
      throw new Error('expected the promise to reject');
    },
    (e: unknown) => e,
  );
  expect(rejection).toBeInstanceOf(IpcError);
  expect((rejection as IpcError).code).toBe(code);
}

describe('createValidatedInvoke (preload zod-validated bridge)', () => {
  it('validates the request, forwards it to the raw transport, and validates the reply', async () => {
    const rawInvoke = vi.fn().mockResolvedValue({ version: '1.2.3' });
    const invoke = createValidatedInvoke(rawInvoke);

    const result = await invoke(APP_GET_VERSION, {});

    expect(result).toEqual({ version: '1.2.3' });
    expect(rawInvoke).toHaveBeenCalledTimes(1);
    expect(rawInvoke).toHaveBeenCalledWith(APP_GET_VERSION, {});
  });

  it('rejects an invalid request BEFORE it ever crosses the boundary', async () => {
    const rawInvoke = vi.fn().mockResolvedValue({ version: '1.2.3' });
    const invoke = createValidatedInvoke(rawInvoke);

    // Extra keys are rejected by the strict request schema — a buggy or
    // compromised renderer can never smuggle an unexpected payload through.
    await expectIpcErrorCode(
      invoke(APP_GET_VERSION, { rogue: true } as never),
      IPC_ERROR_CODES.BAD_REQUEST,
    );
    expect(rawInvoke).not.toHaveBeenCalled();
  });

  it('rejects a malformed reply from main (defends the renderer from a bad main)', async () => {
    const rawInvoke = vi.fn().mockResolvedValue({ version: '' });
    const invoke = createValidatedInvoke(rawInvoke);

    await expectIpcErrorCode(invoke(APP_GET_VERSION, {}), IPC_ERROR_CODES.BAD_RESPONSE);
  });

  it('throws on an unknown channel name', async () => {
    const rawInvoke = vi.fn();
    const invoke = createValidatedInvoke(rawInvoke);

    await expectIpcErrorCode(
      invoke('does:notExist' as never, {} as never),
      IPC_ERROR_CODES.BAD_REQUEST,
    );
    expect(rawInvoke).not.toHaveBeenCalled();
  });
});
