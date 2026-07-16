// End-to-end RENDERER wiring for undo import (#429): the real chain on the renderer
// side — UndoBanner (on ImportStep) → the real useImport hook's undo() → the
// api.undoImport channel — driven from a real completed import so the import's
// sourceId is what actually reaches the channel. The channel → removeSource half is
// covered in the node layer (catalog-session + originals-store tests, with a real
// better-sqlite3 catalog), which can't run inside jsdom without pulling the whole
// main-process type surface in — so the end-to-end is proven across the two layers.
import { describe, expect, it, vi } from 'vitest';
import { useEffect, useRef } from 'react';
import type { ReactElement } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useImport } from '@renderer/lib/use-import';
import { ImportStep } from '@renderer/onboarding/steps/ImportStep';
import { makeFakeApi, makeImportSummary, makeProgressEvent, FAKE_SOURCE_ID } from './support/fake-api';
import type { FakeApi } from './support/fake-api';
import { wrapInProviders } from './support/render';

function Harness(): ReactElement {
  const job = useImport();
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void job.start({ sourceType: 'whatsapp', inputPath: '/exports/whatsapp.zip' });
  }, [job]);
  return (
    <ImportStep
      personName="Elena"
      state={job}
      onCancel={() => undefined}
      onRetry={() => undefined}
      onSeeEverything={() => undefined}
      onUndo={() => job.undo()}
    />
  );
}

describe('undo import — real renderer wiring: banner → useImport.undo() → channel (#429)', () => {
  it('carries the completed import\'s sourceId all the way to the undo channel, then lands Done', async () => {
    const undoImport: FakeApi['undoImport'] = vi.fn(async () => ({
      itemsRemoved: 1,
      occurrencesRemoved: 1,
    }));
    const api = makeFakeApi({ undoImport });
    const user = userEvent.setup();
    render(wrapInProviders(<Harness />, api));

    // Drive the real hook to its completion summary (start resolves with a sourceId,
    // then a terminal 'done' tick carries the count).
    await waitFor(() => expect(api.startImport).toHaveBeenCalled());
    api.emitProgress(
      makeProgressEvent({ phase: 'done', summary: makeImportSummary({ occurrencesAdded: 1 }) }),
    );
    await screen.findByRole('button', { name: /see everything/i });

    // Confirm-gated undo, all the way through the real hook to the channel.
    await user.click(screen.getByRole('button', { name: /undo this import/i }));
    await user.click(screen.getByRole('button', { name: /yes, remove/i }));

    // The channel was called with the sourceId the import reported — not a guess.
    await waitFor(() => expect(undoImport).toHaveBeenCalledWith({ sourceId: FAKE_SOURCE_ID }));
    // And the user sees the reverent confirmation, never a silent revert.
    expect(await screen.findByText(/removed|as it was/i)).toBeInTheDocument();
  });

  it('shows the honest failure face (not a silent idle) when the channel rejects', async () => {
    // A rejected channel = the removal transaction rolled back; the memories are intact.
    const undoImport: FakeApi['undoImport'] = vi.fn(() => Promise.reject(new Error('db txn failed')));
    const api = makeFakeApi({ undoImport });
    const user = userEvent.setup();
    render(wrapInProviders(<Harness />, api));

    await waitFor(() => expect(api.startImport).toHaveBeenCalled());
    api.emitProgress(
      makeProgressEvent({ phase: 'done', summary: makeImportSummary({ occurrencesAdded: 1 }) }),
    );
    await screen.findByRole('button', { name: /see everything/i });

    await user.click(screen.getByRole('button', { name: /undo this import/i }));
    await user.click(screen.getByRole('button', { name: /yes, remove/i }));

    expect(await screen.findByText(/still (here|there)|couldn.t undo/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });
});
