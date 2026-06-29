import { describe, expect, it, vi } from 'vitest';
import { loadRenderer } from '../../electron/main/app/load-renderer';

describe('loadRenderer', () => {
  it('catches loadFile failures and reports them to the supplied error sink (#24)', async () => {
    const error = new Error('renderer missing');
    const window = {
      loadFile: vi.fn(() => Promise.reject(error)),
      loadURL: vi.fn(() => Promise.resolve()),
    };
    const onLoadFailure = vi.fn();

    await loadRenderer(window, {
      rendererEntryPath: '/app/out/renderer/index.html',
      onLoadFailure,
    });

    expect(onLoadFailure).toHaveBeenCalledWith(error);
  });
});
