// UndoBanner (#429, AC-14 / P4b): the post-import "changed your mind?" affordance.
// It is CONFIRM-GATED — a second, explicit confirmation stands between the user and
// a destructive removal — and speaks in plain, reverent language (USER_FLOWS §1). It
// never removes anything on its own: only the second confirm calls `onUndo`.
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UndoBanner } from '@renderer/components/UndoBanner';
import { ImportStep } from '@renderer/onboarding/steps/ImportStep';
import type { ImportState } from '@renderer/lib/use-import';
import { makeImportSummary } from './support/fake-api';
import { expectNoAxeViolations } from './support/axe';

const FAKE_SOURCE_ID = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';

function completeState(over: Partial<ImportState> = {}): ImportState {
  return {
    status: 'complete',
    jobId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
    sourceId: FAKE_SOURCE_ID,
    processed: 12,
    total: 12,
    message: null,
    phase: 'done',
    summary: makeImportSummary({ occurrencesAdded: 12 }),
    error: null,
    ...over,
  };
}

function setup(over: { onUndo?: () => Promise<void>; count?: number } = {}) {
  const onUndo = over.onUndo ?? vi.fn(() => Promise.resolve());
  const user = userEvent.setup();
  const { container } = render(
    <UndoBanner personName="Elena" count={over.count ?? 347} onUndo={onUndo} />,
  );
  return { onUndo, user, container };
}

describe('UndoBanner — every import is undoable (AC-14)', () => {
  it('explains the undo in calm, reverent, plain language — no jargon', () => {
    setup();
    // Names the person and reassures that only THIS import is affected.
    expect(screen.getByText(/changed your mind/i)).toBeInTheDocument();
    expect(screen.getByText(/Elena/)).toBeInTheDocument();
    expect(screen.getByText(/only|just added/i)).toBeInTheDocument();
    // No raw code, no "delete from database", no source ids.
    expect(screen.queryByText(/DELETE|SQL|source_id|occurrence/i)).not.toBeInTheDocument();
  });

  it('does NOT remove anything on mount or first click — it is confirm-gated (two steps)', async () => {
    const { onUndo, user } = setup();
    // Nothing yet.
    expect(onUndo).not.toHaveBeenCalled();
    // First click only ASKS — it must not call onUndo.
    await user.click(screen.getByRole('button', { name: /undo this import/i }));
    expect(onUndo).not.toHaveBeenCalled();
    // A second, explicit confirmation is now presented.
    expect(await screen.findByRole('button', { name: /yes, remove/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /keep them/i })).toBeInTheDocument();
  });

  it('lets the user back out of the confirmation without removing anything', async () => {
    const { onUndo, user } = setup();
    await user.click(screen.getByRole('button', { name: /undo this import/i }));
    await user.click(screen.getByRole('button', { name: /keep them/i }));
    expect(onUndo).not.toHaveBeenCalled();
    // Back to the calm first step.
    expect(screen.getByRole('button', { name: /undo this import/i })).toBeInTheDocument();
  });

  it('calls onUndo exactly once only after the SECOND confirmation, then confirms it is done', async () => {
    const { onUndo, user } = setup();
    await user.click(screen.getByRole('button', { name: /undo this import/i }));
    await user.click(screen.getByRole('button', { name: /yes, remove/i }));
    await waitFor(() => expect(onUndo).toHaveBeenCalledTimes(1));
    // A gentle confirmation that the library is as it was.
    expect(await screen.findByText(/removed|as it was/i)).toBeInTheDocument();
  });

  it('gives both destructive-flow buttons a real ≥44px hit target', async () => {
    const { user } = setup();
    const start = screen.getByRole('button', { name: /undo this import/i });
    expect(start.className).toMatch(/\bmin-h-1[24]\b/);
    await user.click(start);
    const confirm = await screen.findByRole('button', { name: /yes, remove/i });
    expect(confirm.className).toMatch(/\bmin-h-1[24]\b/);
  });

  it('has no WCAG 2.1 AA axe violations in either step', async () => {
    const { user, container } = setup();
    await expectNoAxeViolations(container);
    await user.click(screen.getByRole('button', { name: /undo this import/i }));
    await screen.findByRole('button', { name: /yes, remove/i });
    await expectNoAxeViolations(container);
  });
});

describe('ImportStep hosts the UndoBanner on its completion summary (#429)', () => {
  it('offers to undo THIS import once it lands, wired to the import\'s source id', async () => {
    const onUndo = vi.fn(() => Promise.resolve());
    const user = userEvent.setup();
    render(
      <ImportStep
        personName="Elena"
        state={completeState()}
        onCancel={() => undefined}
        onRetry={() => undefined}
        onSeeEverything={() => undefined}
        onUndo={onUndo}
      />,
    );
    // The banner appears alongside the existing "See everything" way forward.
    expect(screen.getByRole('button', { name: /see everything/i })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /undo this import/i }));
    await user.click(screen.getByRole('button', { name: /yes, remove/i }));
    await waitFor(() => expect(onUndo).toHaveBeenCalledWith(FAKE_SOURCE_ID));
  });

  it('shows no undo affordance while the import is still running', () => {
    render(
      <ImportStep
        personName="Elena"
        state={completeState({ status: 'running', phase: 'parse', summary: null, sourceId: FAKE_SOURCE_ID })}
        onCancel={() => undefined}
        onRetry={() => undefined}
        onSeeEverything={() => undefined}
        onUndo={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: /undo this import/i })).not.toBeInTheDocument();
  });
});
