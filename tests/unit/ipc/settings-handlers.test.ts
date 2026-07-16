import { describe, expect, it, vi } from 'vitest';
import {
  handleSettingsGet,
  handleSettingsSet,
  type SettingsStorePort,
} from '../../../electron/main/ipc/handlers/settings';
import { SETTINGS_GET, SETTINGS_SET, ipcContract } from '@shared/ipc/contract';
import type { SettingsDTO } from '@shared/ipc/schemas';

function makeStore(initial: SettingsDTO = { textSize: 'default', reducedMotion: false }): SettingsStorePort {
  let snapshot = initial;
  return {
    get: vi.fn(() => snapshot),
    set: vi.fn((patch: Partial<SettingsDTO>) => {
      snapshot = { ...snapshot, ...patch };
      return snapshot;
    }),
  };
}

describe('settings IPC handlers (AC-13 / Journey G, #433)', () => {
  it('settings:get reads the durable snapshot from the store', async () => {
    const store = makeStore({ textSize: 'large', reducedMotion: true });
    const response = await handleSettingsGet({ settings: store });

    expect(response).toEqual({ textSize: 'large', reducedMotion: true });
    expect(store.get).toHaveBeenCalled();
    expect(ipcContract[SETTINGS_GET].response.safeParse(response).success).toBe(true);
  });

  it('settings:set forwards the request patch to the store and echoes the RESOLVED snapshot', async () => {
    const store = makeStore({ textSize: 'default', reducedMotion: false });
    const response = await handleSettingsSet({ settings: store }, { textSize: 'larger' });

    expect(store.set).toHaveBeenCalledWith({ textSize: 'larger' });
    expect(response).toEqual({ textSize: 'larger', reducedMotion: false });
    expect(ipcContract[SETTINGS_SET].response.safeParse(response).success).toBe(true);
  });

  it('settings:set with a reducedMotion-only patch leaves textSize untouched', async () => {
    const store = makeStore({ textSize: 'large', reducedMotion: false });
    const response = await handleSettingsSet({ settings: store }, { reducedMotion: true });

    expect(response).toEqual({ textSize: 'large', reducedMotion: true });
  });

  it('rejects a malformed request at the contract boundary (bounded enum, not a free string)', () => {
    const parsed = ipcContract[SETTINGS_SET].request.safeParse({ textSize: 'gigantic' });
    expect(parsed.success).toBe(false);
  });

  it('rejects an unknown key on the request (strictObject)', () => {
    const parsed = ipcContract[SETTINGS_SET].request.safeParse({ nope: true });
    expect(parsed.success).toBe(false);
  });
});
