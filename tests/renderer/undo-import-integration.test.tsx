// End-to-end wiring for undo import (#429): the REAL chain, not a mock in the middle.
// UndoBanner (on ImportStep) → the real useImport hook's undo() → api.undoImport →
// the real removeSource against a real better-sqlite3 catalog. Proves that a click
// through the confirm-gate actually removes the import's rows AND lands the calm
// "Done" — the partial-cleanup-vs-genuine-failure fix relies on this whole path.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEffect, useRef } from 'react';
import type { ReactElement } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useImport } from '@renderer/lib/use-import';
import { ImportStep } from '@renderer/onboarding/steps/ImportStep';
import { openCatalog, type CatalogDatabase } from '../../electron/main/db/connection';
import { runMigrations } from '../../electron/main/db/migrate';
import { createCatalogRepo } from '../../electron/main/db/catalog-repo';
import { removeSource } from '../../electron/main/library/originals-store';
import { makeFakeApi, makeImportSummary, makeProgressEvent, FAKE_SOURCE_ID } from './support/fake-api';
import type { FakeApi } from './support/fake-api';
import { wrapInProviders } from './support/render';
import { makeTmpDir, removeTmpDir } from '../helpers/tmp';

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

describe('undo import — real wiring through useImport → channel → removeSource (#429)', () => {
  let root: string;
  let db: CatalogDatabase;

  beforeEach(() => {
    root = makeTmpDir('undo-e2e');
    db = openCatalog(`${root}/catalog.sqlite3`);
    runMigrations(db);
    const repo = createCatalogRepo(db);
    // Seed the very source this import "wrote", so undo removes a real row set.
    repo.registerSource({ id: FAKE_SOURCE_ID, sourceKey: 'wa', type: 'whatsapp', label: 'WhatsApp' });
    const itemId = repo.insertItem({ mediaType: 'message', description: 'hola', searchMeta: 'hola' });
    repo.addOccurrence({ itemId, sourceId: FAKE_SOURCE_ID, sourceRef: 'wa/1', originalKind: 'none' });
  });
  afterEach(() => {
    db.close();
    removeTmpDir(root);
  });

  it('removes exactly this import through the whole stack and lands the calm Done', async () => {
    // The undo channel is backed by the REAL removeSource against the seeded db.
    const undoImport: FakeApi['undoImport'] = vi.fn(async ({ sourceId }) => {
      const result = removeSource(db, root, sourceId);
      return { itemsRemoved: result.itemsRemoved, occurrencesRemoved: result.occurrencesRemoved };
    });
    const api = makeFakeApi({ undoImport });
    const user = userEvent.setup();
    render(wrapInProviders(<Harness />, api));

    // Drive the import to its completion summary.
    await waitFor(() => expect(api.startImport).toHaveBeenCalled());
    api.emitProgress(
      makeProgressEvent({ phase: 'done', summary: makeImportSummary({ occurrencesAdded: 1 }) }),
    );
    await screen.findByRole('button', { name: /see everything/i });

    // Undo, confirm-gated, all the way to the real removal.
    await user.click(screen.getByRole('button', { name: /undo this import/i }));
    await user.click(screen.getByRole('button', { name: /yes, remove/i }));

    await waitFor(() => expect(undoImport).toHaveBeenCalledWith({ sourceId: FAKE_SOURCE_ID }));
    // The seeded rows are actually gone from the real catalog.
    expect(Number((db.prepare('SELECT COUNT(*) AS n FROM items').get() as { n: number }).n)).toBe(0);
    expect(
      Number((db.prepare('SELECT COUNT(*) AS n FROM item_occurrences').get() as { n: number }).n),
    ).toBe(0);
    // And the user sees the reverent confirmation, not a silent revert.
    expect(await screen.findByText(/removed|as it was/i)).toBeInTheDocument();
  });
});
