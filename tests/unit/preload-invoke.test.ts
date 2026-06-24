import { describe, expect, it, vi } from 'vitest';
import { APP_GET_VERSION } from '@shared/ipc/contract';
import { createValidatedInvoke } from '../../electron/preload/invoke';

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
    await expect(invoke(APP_GET_VERSION, { rogue: true } as never)).rejects.toThrow();
    expect(rawInvoke).not.toHaveBeenCalled();
  });

  it('rejects a malformed reply from main (defends the renderer from a bad main)', async () => {
    const rawInvoke = vi.fn().mockResolvedValue({ version: '' });
    const invoke = createValidatedInvoke(rawInvoke);

    await expect(invoke(APP_GET_VERSION, {})).rejects.toThrow();
  });

  it('throws on an unknown channel name', async () => {
    const rawInvoke = vi.fn();
    const invoke = createValidatedInvoke(rawInvoke);

    await expect(invoke('does:notExist' as never, {} as never)).rejects.toThrow();
    expect(rawInvoke).not.toHaveBeenCalled();
  });
});
