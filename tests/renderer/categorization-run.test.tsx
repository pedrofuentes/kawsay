import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UserEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CategorizationRun } from '@renderer/components/CategorizationRun';
import { expectNoAxeViolations } from './support/axe';
import { makeFakeApi } from './support/fake-api';
import type { FakeApi } from './support/fake-api';
import { wrapInProviders } from './support/render';
import type { CategorizationSnapshotDTO, CategorizationStartResultDTO } from '@shared/kawsay-api';

function counts(over: Partial<CategorizationSnapshotDTO['counts']> = {}) {
  return { categorized: 0, skipped: 0, failed: 0, inFlight: 0, ...over };
}

function snapshot(over: Partial<CategorizationSnapshotDTO> = {}): CategorizationSnapshotDTO {
  return { state: 'idle', counts: counts(), lastItem: null, ...over };
}

function startResult(
  over: Partial<CategorizationStartResultDTO> = {},
): CategorizationStartResultDTO {
  // Every call site passes a valid {outcome, reason} pairing; the cast keeps this
  // tiny builder ergonomic against the discriminated-union start result.
  return {
    outcome: 'idle',
    reason: null,
    counts: counts(),
    ...over,
  } as CategorizationStartResultDTO;
}

function offeredApi(over: Parameters<typeof makeFakeApi>[0] = {}): FakeApi {
  return makeFakeApi({
    getCategorizationStatus: vi.fn(() => Promise.resolve({ optedIn: true, offered: true })),
    ...over,
  });
}

function setup(api: FakeApi = offeredApi()): {
  api: FakeApi;
  user: UserEvent;
  container: HTMLElement;
} {
  const user = userEvent.setup();
  const { container } = render(wrapInProviders(<CategorizationRun />, api));
  return { api, user, container };
}

describe('CategorizationRun', () => {
  it('renders nothing when categorization is not offered', async () => {
    const getCategorizationStatus = vi.fn(() =>
      Promise.resolve({ optedIn: true, offered: false }),
    );
    const { container } = setup(makeFakeApi({ getCategorizationStatus }));

    await waitFor(() => expect(getCategorizationStatus).toHaveBeenCalledTimes(1));

    expect(container).toBeEmptyDOMElement();
  });

  it('starts organizing when the user asks and shows the completed summary', async () => {
    const start = vi.fn(() =>
      Promise.resolve(
        startResult({
          outcome: 'completed',
          reason: null,
          counts: counts({ categorized: 2 }),
        }),
      ),
    );
    const { user } = setup(offeredApi({ startCategorization: start }));

    await user.click(await screen.findByRole('button', { name: 'Organize now' }));

    expect(start).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/2 memories/)).toBeInTheDocument();
  });

  it('announces live gathered progress politely', async () => {
    const { api } = setup();
    await screen.findByRole('button', { name: 'Organize now' });

    act(() => {
      api.emitCategorizationProgress(
        snapshot({
          state: 'running',
          counts: counts({ categorized: 7, inFlight: 1 }),
        }),
      );
    });

    const progress = await screen.findByText(/7 gathered so far/);
    expect(progress).toHaveAttribute('aria-live', 'polite');
  });

  it('guides the user to turn on suggestions when a run is refused', async () => {
    const start = vi.fn(() =>
      Promise.resolve(
        startResult({
          outcome: 'refused',
          reason: 'not-opted-in',
        }),
      ),
    );
    const { user } = setup(offeredApi({ startCategorization: start }));

    await user.click(await screen.findByRole('button', { name: 'Organize now' }));

    expect(await screen.findByText(/turn on suggestions in the step above/i)).toBeInTheDocument();
  });

  it('intro has no axe violations', async () => {
    const { container } = setup();
    await screen.findByRole('button', { name: 'Organize now' });

    await expectNoAxeViolations(container);
  });
});
