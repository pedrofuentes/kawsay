import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UserEvent } from '@testing-library/user-event';
import { TranscriptionRun } from '@renderer/components/TranscriptionRun';
import { makeFakeApi } from './support/fake-api';
import type { FakeApi } from './support/fake-api';
import { wrapInProviders } from './support/render';
import { expectNoAxeViolations } from './support/axe';
import type { TranscriptionSnapshotDTO, TranscriptionStartResultDTO } from '@shared/kawsay-api';

function counts(over: Partial<TranscriptionSnapshotDTO['counts']> = {}) {
  return { total: 0, transcribed: 0, failed: 0, skipped: 0, inFlight: 0, ...over };
}

function snapshot(over: Partial<TranscriptionSnapshotDTO> = {}): TranscriptionSnapshotDTO {
  return { state: 'idle', counts: counts(), lastItem: null, ...over };
}

function startResult(over: Partial<TranscriptionStartResultDTO> = {}): TranscriptionStartResultDTO {
  // Every call site passes a valid {outcome, reason} pairing; the cast keeps this
  // tiny builder ergonomic against the discriminated-union start result (#160).
  return { outcome: 'idle', reason: null, counts: counts(), ...over } as TranscriptionStartResultDTO;
}

function setup(api: FakeApi = makeFakeApi()): {
  api: FakeApi;
  user: UserEvent;
  container: HTMLElement;
} {
  const user = userEvent.setup();
  const { container } = render(wrapInProviders(<TranscriptionRun />, api));
  return { api, user, container };
}

describe('TranscriptionRun — nothing auto-starts (AC-22)', () => {
  it('does NOT start transcription on mount — the run is caller-initiated only', async () => {
    const start = vi.fn(() => Promise.resolve(startResult()));
    const { api } = setup(makeFakeApi({ startTranscription: start }));
    // The start affordance is offered, but no run begins until the user asks.
    expect(await screen.findByRole('button', { name: /start transcrib/i })).toBeInTheDocument();
    expect(start).not.toHaveBeenCalled();
    expect(api.startTranscription).not.toHaveBeenCalled();
  });
});

describe('TranscriptionRun — starting a run and watching gentle progress', () => {
  it('starts the run when the user asks, then announces live progress', async () => {
    const start = vi.fn(() =>
      Promise.resolve(startResult({ outcome: 'started', counts: counts({ total: 40, inFlight: 1 }) })),
    );
    const { api, user } = setup(makeFakeApi({ startTranscription: start }));

    await user.click(await screen.findByRole('button', { name: /start transcrib/i }));
    expect(start).toHaveBeenCalledTimes(1);

    // Optimistic running copy appears immediately, before the first stream tick.
    expect(await screen.findByText(/transcribing your recordings/i)).toBeInTheDocument();

    api.emitTranscriptionProgress(
      snapshot({
        state: 'running',
        counts: counts({ total: 40, transcribed: 12, inFlight: 1 }),
        lastItem: { id: '00000000-0000-4000-8000-000000000001', status: 'transcribed' },
      }),
    );

    // The count is reflected in a polite live region (calm, never a raw number alone).
    const progress = await screen.findByText(/12 of 40/);
    expect(progress).toBeInTheDocument();
    const live = progress.closest('[aria-live]');
    expect(live).not.toBeNull();
    expect(live).toHaveAttribute('aria-live', 'polite');
  });

  it('reflects an already-running run on mount (a reopened window shows progress)', async () => {
    const api = makeFakeApi({
      getTranscriptionStatus: vi.fn(() =>
        Promise.resolve(snapshot({ state: 'running', counts: counts({ total: 40, transcribed: 5, inFlight: 1 }) })),
      ),
    });
    setup(api);

    expect(await screen.findByText(/transcribing your recordings/i)).toBeInTheDocument();
    expect(await screen.findByText(/5 of 40/)).toBeInTheDocument();
  });

  it('reflects a completed run on mount, gently noting any that could not be transcribed', async () => {
    const api = makeFakeApi({
      getTranscriptionStatus: vi.fn(() =>
        Promise.resolve(
          snapshot({ state: 'complete', counts: counts({ total: 10, transcribed: 8, failed: 1, skipped: 1 }) }),
        ),
      ),
    });
    setup(api);

    expect(await screen.findByText(/words you can read/i)).toBeInTheDocument();
    // The 2 that couldn't be transcribed are acknowledged calmly, never lost.
    expect(await screen.findByText(/2 .*couldn't be transcribed|couldn't be transcribed/i)).toBeInTheDocument();
  });

  it('lets the user gently stop an in-flight run', async () => {
    const cancel = vi.fn(() => Promise.resolve({ cancelled: true }));
    const api = makeFakeApi({
      getTranscriptionStatus: vi.fn(() =>
        Promise.resolve(snapshot({ state: 'running', counts: counts({ total: 40, transcribed: 5, inFlight: 1 }) })),
      ),
      cancelTranscription: cancel,
    });
    const { user } = setup(api);

    await user.click(await screen.findByRole('button', { name: /stop/i }));
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});

describe('TranscriptionRun — a gated refusal guides kindly, never errors (AC-22)', () => {
  it('points the user to turn transcription on when they have not opted in', async () => {
    const start = vi.fn(() => Promise.resolve(startResult({ outcome: 'refused', reason: 'not-opted-in' })));
    const { user } = setup(makeFakeApi({ startTranscription: start }));

    await user.click(await screen.findByRole('button', { name: /start transcrib/i }));

    expect(await screen.findByText(/turn on transcription/i)).toBeInTheDocument();
    // Calm guidance — never a scary error/alert, never a raw reason code.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText(/not-opted-in/i)).not.toBeInTheDocument();
  });

  it('explains transcription is still setting up when the model is not ready', async () => {
    const start = vi.fn(() => Promise.resolve(startResult({ outcome: 'refused', reason: 'model-not-ready' })));
    const { user } = setup(makeFakeApi({ startTranscription: start }));

    await user.click(await screen.findByRole('button', { name: /start transcrib/i }));

    expect(await screen.findByText(/still setting up/i)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText(/model-not-ready/i)).not.toBeInTheDocument();
  });

  it('says there is nothing to do when no recordings are waiting', async () => {
    const start = vi.fn(() => Promise.resolve(startResult({ outcome: 'idle', counts: counts({ total: 0 }) })));
    const { user } = setup(makeFakeApi({ startTranscription: start }));

    await user.click(await screen.findByRole('button', { name: /start transcrib/i }));

    expect(await screen.findByText(/no recordings to transcribe/i)).toBeInTheDocument();
  });

  it('reassures when every recording already has words you can read', async () => {
    const start = vi.fn(() =>
      Promise.resolve(startResult({ outcome: 'idle', counts: counts({ total: 12, transcribed: 12 }) })),
    );
    const { user } = setup(makeFakeApi({ startTranscription: start }));

    await user.click(await screen.findByRole('button', { name: /start transcrib/i }));

    expect(await screen.findByText(/already has words you can read/i)).toBeInTheDocument();
  });
});

describe('TranscriptionRun — accessibility (WCAG 2.1 AA)', () => {
  it('intro has no axe violations', async () => {
    const { container } = setup();
    await screen.findByRole('button', { name: /start transcrib/i });
    await expectNoAxeViolations(container);
  });

  it('running has no axe violations', async () => {
    const api = makeFakeApi({
      getTranscriptionStatus: vi.fn(() =>
        Promise.resolve(snapshot({ state: 'running', counts: counts({ total: 40, transcribed: 5, inFlight: 1 }) })),
      ),
    });
    const { container } = setup(api);
    await screen.findByText(/transcribing your recordings/i);
    await expectNoAxeViolations(container);
  });

  it('complete has no axe violations', async () => {
    const api = makeFakeApi({
      getTranscriptionStatus: vi.fn(() =>
        Promise.resolve(snapshot({ state: 'complete', counts: counts({ total: 10, transcribed: 10 }) })),
      ),
    });
    const { container } = setup(api);
    await screen.findByText(/words you can read/i);
    await expectNoAxeViolations(container);
  });

  it('refusal guidance has no axe violations', async () => {
    const start = vi.fn(() => Promise.resolve(startResult({ outcome: 'refused', reason: 'not-opted-in' })));
    const { user, container } = setup(makeFakeApi({ startTranscription: start }));
    await user.click(await screen.findByRole('button', { name: /start transcrib/i }));
    await screen.findByText(/turn on transcription/i);
    await expectNoAxeViolations(container);
  });
});
