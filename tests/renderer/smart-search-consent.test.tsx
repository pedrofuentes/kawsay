import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UserEvent } from '@testing-library/user-event';
import { SmartSearchConsent } from '@renderer/components/SmartSearchConsent';
import { makeFakeApi, makeModelDownloadProgressEvent } from './support/fake-api';
import type { FakeApi } from './support/fake-api';
import { wrapInProviders } from './support/render';
import { expectNoAxeViolations } from './support/axe';

const downloadStarted = () => Promise.resolve({ outcome: 'download-started' as const });

/** A fake whose smart-search surface is offered (the pre-publish gate is open). */
function offeredApi(opts: Partial<Parameters<typeof makeFakeApi>[0]> = {}): FakeApi {
  return makeFakeApi({
    getSmartSearchStatus: vi.fn(() =>
      Promise.resolve({ optedIn: false, modelReady: false, offered: true }),
    ),
    enableSmartSearch: vi.fn(downloadStarted),
    ...opts,
  });
}

function setup(api: FakeApi = makeFakeApi()): {
  api: FakeApi;
  user: UserEvent;
  container: HTMLElement;
} {
  const user = userEvent.setup();
  const { container } = render(wrapInProviders(<SmartSearchConsent />, api));
  return { api, user, container };
}

async function startDownloading(user: UserEvent): Promise<void> {
  await user.click(await screen.findByRole('button', { name: /enable smart search/i }));
}

describe('SmartSearchConsent — hidden until the model is offered (the pre-publish gate)', () => {
  it('renders nothing at all while smart search is not yet offered (default, pre-publish)', async () => {
    const { api, container } = setup();
    // Let the one-time capability probe settle...
    await waitFor(() => expect(api.getSmartSearchStatus).toHaveBeenCalled());
    // ...then the whole surface stays hidden — no heading, no toggle, no download.
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    expect(api.enableSmartSearch).not.toHaveBeenCalled();
  });

  it('reveals the opt-in card once the model is offered — no code change, just the gate flip', async () => {
    setup(offeredApi());
    expect(await screen.findByRole('button', { name: /enable smart search/i })).toBeInTheDocument();
  });
});

describe('SmartSearchConsent — explains and asks before anything downloads (M4-1b)', () => {
  it('explains smart search by MEANING in calm, on-device, non-technical language', async () => {
    setup(offeredApi());
    await screen.findByRole('button', { name: /enable smart search/i });
    // What it does: find memories by what they mean / are about, not just exact words.
    expect(
      screen.getByRole('heading', { name: /what they('re| are) about|by meaning/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/not just the exact words/i)).toBeInTheDocument();
    // 100% on-device + memories never leave.
    expect(screen.getByText(/never leave this computer/i)).toBeInTheDocument();
    // One-time ~124 MB download (derived from SMART_SEARCH_MODEL_SIZE_BYTES).
    expect(screen.getByText(/124 MB/)).toBeInTheDocument();
    expect(screen.getByText(/only time .* uses the internet/i)).toBeInTheDocument();
  });

  it('does NOT download anything on mount — opt-in only', async () => {
    const { api } = setup(offeredApi());
    await screen.findByRole('button', { name: /enable smart search/i });
    expect(api.enableSmartSearch).not.toHaveBeenCalled();
  });

  it('does NOT reuse the transcription (audio/voice) wording — this is about meaning', async () => {
    setup(offeredApi());
    await screen.findByRole('button', { name: /enable smart search/i });
    expect(screen.queryByText(/voice notes|transcri|recordings/i)).not.toBeInTheDocument();
  });

  it('starts the one-time download exactly once when the user explicitly opts in', async () => {
    const api = offeredApi();
    const { user } = setup(api);

    await startDownloading(user);

    expect(api.enableSmartSearch).toHaveBeenCalledTimes(1);
  });

  it('starts the download exactly once even on a rapid double-click (no double opt-in)', async () => {
    const api = offeredApi();
    setup(api);
    const button = await screen.findByRole('button', { name: /enable smart search/i });

    fireEvent.click(button);
    fireEvent.click(button);

    await waitFor(() => expect(api.enableSmartSearch).toHaveBeenCalledTimes(1));
    expect(api.enableSmartSearch).toHaveBeenCalledTimes(1);
  });
});

describe('SmartSearchConsent — calm progress while the model downloads', () => {
  it('shows a percentage and byte counts in a polite live region', async () => {
    const api = offeredApi();
    const { user } = setup(api);
    await startDownloading(user);

    api.emitSmartSearchModelDownloadProgress(
      makeModelDownloadProgressEvent({
        phase: 'downloading',
        bytesDownloaded: 65_011_712, // 62 MiB
        totalBytes: 130_023_424, // 124 MiB
      }),
    );

    const bar = await screen.findByRole('progressbar');
    await waitFor(() => expect(bar).toHaveAttribute('aria-valuenow', '50'));
    expect(screen.getByText(/62 MB/)).toBeInTheDocument();
    expect(screen.getByText(/124 MB/)).toBeInTheDocument();

    const live = bar.closest('[aria-live]');
    expect(live).not.toBeNull();
    expect(live).toHaveAttribute('aria-live', 'polite');
  });

  it('reassures the user while the finished download is being checked (verifying)', async () => {
    const api = offeredApi();
    const { user } = setup(api);
    await startDownloading(user);

    api.emitSmartSearchModelDownloadProgress(makeModelDownloadProgressEvent({ phase: 'verifying' }));

    expect(await screen.findByText(/almost there/i)).toBeInTheDocument();
    expect(screen.queryByText(/smart search is ready/i)).not.toBeInTheDocument();
  });

  it('reaches a ready state when the download stream completes', async () => {
    const api = offeredApi();
    const { user } = setup(api);
    await startDownloading(user);

    api.emitSmartSearchModelDownloadProgress(makeModelDownloadProgressEvent({ phase: 'done' }));

    expect(await screen.findByText(/smart search is ready/i)).toBeInTheDocument();
  });
});

describe('SmartSearchConsent — the ready state is announced to assistive tech (WCAG 2.1 AA SC 4.1.3)', () => {
  it('wraps the ready confirmation in a status live region and moves focus to it when the download finishes', async () => {
    const api = offeredApi();
    const { user } = setup(api);
    await startDownloading(user);

    api.emitSmartSearchModelDownloadProgress(makeModelDownloadProgressEvent({ phase: 'done' }));

    const statusRegion = await screen.findByRole('status');
    expect(within(statusRegion).getByText(/smart search is ready/i)).toBeInTheDocument();
    await waitFor(() => expect(statusRegion).toHaveFocus());
  });

  it('does not steal focus when the model is already present on mount (no opt-in just happened)', async () => {
    const api = offeredApi({
      getSmartSearchStatus: vi.fn(() =>
        Promise.resolve({ optedIn: true, modelReady: true, offered: true }),
      ),
    });
    setup(api);

    const statusRegion = await screen.findByRole('status');
    expect(within(statusRegion).getByText(/smart search is ready/i)).toBeInTheDocument();
    expect(statusRegion).not.toHaveFocus();
  });
});

describe('SmartSearchConsent — graceful offline / error handling (never a scary stack trace)', () => {
  it('shows a gentle, plain-language error with a retry — no raw codes', async () => {
    const api = offeredApi();
    const { user } = setup(api);
    await startDownloading(user);

    api.emitSmartSearchModelDownloadProgress(
      makeModelDownloadProgressEvent({
        phase: 'error',
        error: {
          kind: 'network',
          message: 'getaddrinfo ENOTFOUND release-assets',
          retryable: true,
        },
      }),
    );

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(/connection|internet/i)).toBeInTheDocument();
    expect(screen.queryByText(/ENOTFOUND/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it('retry re-invokes the download', async () => {
    const api = offeredApi();
    const { user } = setup(api);
    await startDownloading(user);

    api.emitSmartSearchModelDownloadProgress(
      makeModelDownloadProgressEvent({
        phase: 'error',
        error: { kind: 'network', message: 'offline', retryable: true },
      }),
    );
    await user.click(await screen.findByRole('button', { name: /try again/i }));

    expect(api.enableSmartSearch).toHaveBeenCalledTimes(2);
  });

  it('translates a disk-full failure into calm, non-technical guidance', async () => {
    const api = offeredApi();
    const { user } = setup(api);
    await startDownloading(user);

    api.emitSmartSearchModelDownloadProgress(
      makeModelDownloadProgressEvent({
        phase: 'error',
        error: { kind: 'disk', message: 'ENOSPC: no space left on device', retryable: true },
      }),
    );

    expect(await screen.findByText(/room|space/i)).toBeInTheDocument();
    expect(screen.queryByText(/ENOSPC/)).not.toBeInTheDocument();
  });

  it('explains a corrupted download gently and promises a fresh copy (integrity)', async () => {
    const api = offeredApi();
    const { user } = setup(api);
    await startDownloading(user);

    api.emitSmartSearchModelDownloadProgress(
      makeModelDownloadProgressEvent({
        phase: 'error',
        error: { kind: 'integrity', message: 'sha256 checksum mismatch', retryable: true },
      }),
    );

    expect(await screen.findByText(/in one piece|fresh copy/i)).toBeInTheDocument();
    expect(screen.queryByText(/sha256|checksum/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it('does NOT offer an endless retry on a permanent stream failure — calm alternate guidance', async () => {
    const api = offeredApi();
    const { user } = setup(api);
    await startDownloading(user);

    api.emitSmartSearchModelDownloadProgress(
      makeModelDownloadProgressEvent({
        phase: 'error',
        error: { kind: 'http', message: 'HTTP 403 Forbidden', retryable: false },
      }),
    );

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(/can't set up smart search on this computer/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /try again/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/403/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Forbidden/)).not.toBeInTheDocument();
  });
});

describe('SmartSearchConsent — the platform cannot install the model (unsupported)', () => {
  it('shows a calm, non-retryable "not available here" state and never downloads again', async () => {
    const api = offeredApi({
      enableSmartSearch: vi.fn(() => Promise.resolve({ outcome: 'unsupported-platform' as const })),
    });
    const { user } = setup(api);
    await startDownloading(user);

    expect(await screen.findByText(/isn't available on this computer|can't be set up/i)).toBeInTheDocument();
    // No dead-end retry loop for a platform that simply cannot install it.
    expect(screen.queryByRole('button', { name: /try again/i })).not.toBeInTheDocument();
    // Exact search still works — reassure, don't alarm.
    expect(screen.getByText(/exact words|still search/i)).toBeInTheDocument();
  });
});

describe('SmartSearchConsent — the feature is gated on a present + verified model', () => {
  it('keeps the smart-search toggle disabled and shows it is not set up yet', async () => {
    const { api } = setup(offeredApi());
    const toggle = await screen.findByRole('switch', { name: /search/i });
    expect(await screen.findByText(/isn't set up yet/i)).toBeInTheDocument();
    expect(toggle).toBeDisabled();
    expect(api.enableSmartSearch).not.toHaveBeenCalled();
  });

  it('unlocks the toggle once the model is present and verified', async () => {
    const api = offeredApi({
      getSmartSearchStatus: vi.fn(() =>
        Promise.resolve({ optedIn: true, modelReady: true, offered: true }),
      ),
    });
    setup(api);

    const toggle = await screen.findByRole('switch', { name: /search/i });
    await waitFor(() => expect(toggle).toBeEnabled());
    expect(toggle).toBeChecked();
    expect(screen.getByText(/smart search is ready/i)).toBeInTheDocument();
  });

  it('lets the user turn smart search off again once it is set up (user control)', async () => {
    const api = offeredApi({
      getSmartSearchStatus: vi.fn(() =>
        Promise.resolve({ optedIn: true, modelReady: true, offered: true }),
      ),
    });
    const { user } = setup(api);
    const toggle = await screen.findByRole('switch', { name: /search/i });
    await waitFor(() => expect(toggle).toBeEnabled());

    await user.click(toggle);

    expect(toggle).not.toBeChecked();
  });
});

describe('SmartSearchConsent — accessibility (WCAG 2.1 AA)', () => {
  it('intro has no axe violations', async () => {
    const { container } = setup(offeredApi());
    await screen.findByRole('button', { name: /enable smart search/i });
    await expectNoAxeViolations(container);
  });

  it('downloading has no axe violations', async () => {
    const api = offeredApi();
    const { user, container } = setup(api);
    await startDownloading(user);
    api.emitSmartSearchModelDownloadProgress(
      makeModelDownloadProgressEvent({
        phase: 'downloading',
        bytesDownloaded: 1_000_000,
        totalBytes: 130_023_424,
      }),
    );
    await screen.findByRole('progressbar');
    await expectNoAxeViolations(container);
  });

  it('error has no axe violations', async () => {
    const api = offeredApi();
    const { user, container } = setup(api);
    await startDownloading(user);
    api.emitSmartSearchModelDownloadProgress(
      makeModelDownloadProgressEvent({
        phase: 'error',
        error: { kind: 'network', message: 'offline', retryable: true },
      }),
    );
    await screen.findByRole('alert');
    await expectNoAxeViolations(container);
  });

  it('unsupported has no axe violations', async () => {
    const api = offeredApi({
      enableSmartSearch: vi.fn(() => Promise.resolve({ outcome: 'unsupported-platform' as const })),
    });
    const { user, container } = setup(api);
    await startDownloading(user);
    await screen.findByText(/isn't available on this computer|can't be set up/i);
    await expectNoAxeViolations(container);
  });

  it('ready has no axe violations', async () => {
    const api = offeredApi({
      getSmartSearchStatus: vi.fn(() =>
        Promise.resolve({ optedIn: true, modelReady: true, offered: true }),
      ),
    });
    const { container } = setup(api);
    await screen.findByText(/smart search is ready/i);
    await expectNoAxeViolations(container);
  });
});
