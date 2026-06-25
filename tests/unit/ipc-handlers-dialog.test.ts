import { describe, expect, it, vi } from 'vitest';
import {
  handleOpenDirectory,
  handleOpenFile,
  type OpenDialogResultLike,
  type ShowOpenDialog,
} from '../../electron/main/ipc/handlers/dialog';

/** A `showOpenDialog` double that records the exact options it was handed. */
function fakeDialog(result: OpenDialogResultLike) {
  const calls: unknown[] = [];
  const showOpenDialog = vi.fn((options: unknown) => {
    calls.push(options);
    return Promise.resolve(result);
  }) as unknown as ShowOpenDialog;
  return { showOpenDialog, calls };
}

describe('handleOpenDirectory (dialog:openDirectory handler logic)', () => {
  it('returns the first selected path when the user confirms a folder', async () => {
    const { showOpenDialog } = fakeDialog({ canceled: false, filePaths: ['/Users/mateo/Memories'] });
    await expect(handleOpenDirectory({ showOpenDialog }, {})).resolves.toBe('/Users/mateo/Memories');
  });

  it('returns null when the user cancels', async () => {
    const { showOpenDialog } = fakeDialog({ canceled: true, filePaths: [] });
    await expect(handleOpenDirectory({ showOpenDialog }, {})).resolves.toBeNull();
  });

  it('returns null when nothing was selected even if not flagged as canceled', async () => {
    const { showOpenDialog } = fakeDialog({ canceled: false, filePaths: [] });
    await expect(handleOpenDirectory({ showOpenDialog }, {})).resolves.toBeNull();
  });

  it('hardcodes properties:[openDirectory] and forwards ONLY the whitelisted title/defaultPath', async () => {
    const { showOpenDialog, calls } = fakeDialog({ canceled: true, filePaths: [] });
    // The request also carries attacker-style keys; the handler must ignore them
    // and never let the renderer choose `properties` (privilege confinement).
    await handleOpenDirectory({ showOpenDialog }, {
      title: 'Choose a folder',
      defaultPath: '/Users/mateo',
      properties: ['openFile'],
      message: 'pwn',
    } as never);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      title: 'Choose a folder',
      defaultPath: '/Users/mateo',
      properties: ['openDirectory'],
    });
  });

  it('omits unset title/defaultPath rather than sending undefined keys', async () => {
    const { showOpenDialog, calls } = fakeDialog({ canceled: true, filePaths: [] });
    await handleOpenDirectory({ showOpenDialog }, {});
    expect(calls[0]).toEqual({ properties: ['openDirectory'] });
  });
});

describe('handleOpenFile (dialog:openFile handler logic)', () => {
  it('returns the chosen file path when the user confirms', async () => {
    const { showOpenDialog } = fakeDialog({ canceled: false, filePaths: ['/exports/whatsapp.zip'] });
    await expect(handleOpenFile({ showOpenDialog }, {})).resolves.toBe('/exports/whatsapp.zip');
  });

  it('returns null on cancel', async () => {
    const { showOpenDialog } = fakeDialog({ canceled: true, filePaths: [] });
    await expect(handleOpenFile({ showOpenDialog }, {})).resolves.toBeNull();
  });

  it('hardcodes properties:[openFile] so the renderer cannot widen it to a directory', async () => {
    const { showOpenDialog, calls } = fakeDialog({ canceled: true, filePaths: [] });
    await handleOpenFile({ showOpenDialog }, { properties: ['openDirectory'] } as never);
    expect(calls[0]).toEqual({ properties: ['openFile'] });
  });

  it('forwards the whitelisted title/defaultPath for a file picker too', async () => {
    const { showOpenDialog, calls } = fakeDialog({ canceled: true, filePaths: [] });
    await handleOpenFile({ showOpenDialog }, { title: 'Find the export', defaultPath: '/Downloads' });
    expect(calls[0]).toEqual({
      title: 'Find the export',
      defaultPath: '/Downloads',
      properties: ['openFile'],
    });
  });
});
