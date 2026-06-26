import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UserEvent } from '@testing-library/user-event';
import { TranscriptionConsent } from '@renderer/components/TranscriptionConsent';
import { makeFakeApi, makeModelDownloadProgressEvent } from './support/fake-api';
import type { FakeApi } from './support/fake-api';
import { wrapInProviders } from './support/render';
import { expectNoAxeViolations } from './support/axe';

const started = () => Promise.resolve({ status: 'started' as const });

function setup(api: FakeApi = makeFakeApi()): { api: FakeApi; user: UserEvent; container: HTMLElement } {
  const user = userEvent.setup();
  const { container } = render(wrapInProviders(<TranscriptionConsent />, api));
  return { api, user, container };
}

async function startDownloading(user: UserEvent): Promise<void> {
  await user.click(await screen.findByRole('button', { name: /enable transcription/i }));
}

describe('TranscriptionConsent — explains and asks before anything downloads (AC-22 / ADR-0027)', () => {
  it('explains transcription in calm, on-device, non-technical language', async () => {
    setup();
    // What it does: voice notes/audio/video → readable, searchable text.
    expect(await screen.findByText(/voice notes/i)).toBeInTheDocument();
    expect(screen.getByText(/read and search|searchable/i)).toBeInTheDocument();
    // 100% on-device + memories never leave.
    expect(screen.getByText(/never leave this computer/i)).toBeInTheDocument();
    // One-time ~466 MB download that is the only network the app makes.
    expect(screen.getByText(/466 MB/)).toBeInTheDocument();
    expect(screen.getByText(/only time .* uses the internet/i)).toBeInTheDocument();
  });

  it('does NOT download anything on mount — opt-in only (AC-22)', async () => {
    const { api } = setup();
    await screen.findByRole('button', { name: /enable transcription/i });
    expect(api.downloadTranscriptionModel).not.toHaveBeenCalled();
  });

  it('starts the one-time download exactly once when the user explicitly opts in', async () => {
    const api = makeFakeApi({ downloadTranscriptionModel: vi.fn(started) });
    const { user } = setup(api);

    await startDownloading(user);

    expect(api.downloadTranscriptionModel).toHaveBeenCalledTimes(1);
  });
});

describe('TranscriptionConsent — calm progress while the model downloads', () => {
  it('shows a percentage and byte counts in a polite live region', async () => {
    const api = makeFakeApi({ downloadTranscriptionModel: vi.fn(started) });
    const { user } = setup(api);
    await startDownloading(user);

    api.emitModelDownloadProgress(
      makeModelDownloadProgressEvent({
        phase: 'downloading',
        bytesDownloaded: 244_318_208, // 233 MiB
        totalBytes: 488_636_416, // 466 MiB
      }),
    );

    const bar = await screen.findByRole('progressbar');
    await waitFor(() => expect(bar).toHaveAttribute('aria-valuenow', '50'));
    expect(screen.getByText(/233 MB/)).toBeInTheDocument();
    expect(screen.getByText(/466 MB/)).toBeInTheDocument();

    // A reassuring, non-technical message rather than a raw status code.
    const live = bar.closest('[aria-live]');
    expect(live).not.toBeNull();
    expect(live).toHaveAttribute('aria-live', 'polite');
  });

  it('reaches a ready state when the download stream completes', async () => {
    const api = makeFakeApi({ downloadTranscriptionModel: vi.fn(started) });
    const { user } = setup(api);
    await startDownloading(user);

    api.emitModelDownloadProgress(makeModelDownloadProgressEvent({ phase: 'done' }));

    expect(await screen.findByText(/transcription is ready/i)).toBeInTheDocument();
  });

  it('reassures the user while the finished download is being checked (verifying)', async () => {
    const api = makeFakeApi({ downloadTranscriptionModel: vi.fn(started) });
    const { user } = setup(api);
    await startDownloading(user);

    api.emitModelDownloadProgress(makeModelDownloadProgressEvent({ phase: 'verifying' }));

    expect(await screen.findByText(/almost there/i)).toBeInTheDocument();
    // Still calm and on-device — not yet "ready", no raw status.
    expect(screen.queryByText(/transcription is ready/i)).not.toBeInTheDocument();
  });
});

describe('TranscriptionConsent — graceful offline / error handling (never a scary stack trace)', () => {
  it('shows a gentle, plain-language error with a retry — no raw codes', async () => {
    const api = makeFakeApi({ downloadTranscriptionModel: vi.fn(started) });
    const { user } = setup(api);
    await startDownloading(user);

    api.emitModelDownloadProgress(
      makeModelDownloadProgressEvent({
        phase: 'error',
        error: { kind: 'network', message: 'getaddrinfo ENOTFOUND release-assets', retryable: true },
      }),
    );

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(/connection|internet/i)).toBeInTheDocument();
    expect(screen.queryByText(/ENOTFOUND/)).not.toBeInTheDocument();
    expect(screen.queryByText(/getaddrinfo/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it('retry re-invokes the download', async () => {
    const download = vi.fn(started);
    const api = makeFakeApi({ downloadTranscriptionModel: download });
    const { user } = setup(api);
    await startDownloading(user);

    api.emitModelDownloadProgress(
      makeModelDownloadProgressEvent({
        phase: 'error',
        error: { kind: 'network', message: 'offline', retryable: true },
      }),
    );
    await user.click(await screen.findByRole('button', { name: /try again/i }));

    expect(download).toHaveBeenCalledTimes(2);
  });

  it('translates a disk-full failure into calm, non-technical guidance', async () => {
    const api = makeFakeApi({ downloadTranscriptionModel: vi.fn(started) });
    const { user } = setup(api);
    await startDownloading(user);

    api.emitModelDownloadProgress(
      makeModelDownloadProgressEvent({
        phase: 'error',
        error: { kind: 'disk', message: 'ENOSPC: no space left on device', retryable: true },
      }),
    );

    expect(await screen.findByText(/room|space/i)).toBeInTheDocument();
    expect(screen.queryByText(/ENOSPC/)).not.toBeInTheDocument();
  });

  it('explains a corrupted download gently and promises a fresh copy (integrity)', async () => {
    const api = makeFakeApi({ downloadTranscriptionModel: vi.fn(started) });
    const { user } = setup(api);
    await startDownloading(user);

    api.emitModelDownloadProgress(
      makeModelDownloadProgressEvent({
        phase: 'error',
        error: { kind: 'integrity', message: 'sha256 checksum mismatch', retryable: true },
      }),
    );

    expect(await screen.findByText(/in one piece|fresh copy/i)).toBeInTheDocument();
    expect(screen.queryByText(/sha256|checksum/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it('falls back to a reassuring message for any other interruption', async () => {
    const api = makeFakeApi({ downloadTranscriptionModel: vi.fn(started) });
    const { user } = setup(api);
    await startDownloading(user);

    api.emitModelDownloadProgress(
      makeModelDownloadProgressEvent({
        phase: 'error',
        error: { kind: 'http', message: 'HTTP 503 Service Unavailable', retryable: true },
      }),
    );

    expect(await screen.findByText(/something interrupted the download/i)).toBeInTheDocument();
    expect(screen.queryByText(/503/)).not.toBeInTheDocument();
  });
});

describe('TranscriptionConsent — the feature is gated on a present + verified model', () => {
  it('keeps the global transcription toggle disabled and shows it is not set up yet', async () => {
    const { api } = setup();
    const toggle = await screen.findByRole('switch', { name: /transcrib/i });
    expect(toggle).toBeDisabled();
    expect(screen.getByText(/isn't set up yet/i)).toBeInTheDocument();
    expect(api.downloadTranscriptionModel).not.toHaveBeenCalled();
  });

  it('unlocks the toggle once the model is present and verified', async () => {
    const api = makeFakeApi({ isTranscriptionModelReady: vi.fn(() => Promise.resolve(true)) });
    setup(api);

    const toggle = await screen.findByRole('switch', { name: /transcrib/i });
    await waitFor(() => expect(toggle).toBeEnabled());
    expect(toggle).toBeChecked();
    expect(screen.getByText(/transcription is ready/i)).toBeInTheDocument();
  });

  it('lets the user turn transcription off again once it is set up (user control)', async () => {
    const api = makeFakeApi({ isTranscriptionModelReady: vi.fn(() => Promise.resolve(true)) });
    const { user } = setup(api);
    const toggle = await screen.findByRole('switch', { name: /transcrib/i });
    await waitFor(() => expect(toggle).toBeEnabled());

    await user.click(toggle);

    expect(toggle).not.toBeChecked();
  });
});

describe('TranscriptionConsent — accessibility (WCAG 2.1 AA)', () => {
  it('intro has no axe violations', async () => {
    const { container } = setup();
    await screen.findByRole('button', { name: /enable transcription/i });
    await expectNoAxeViolations(container);
  });

  it('downloading has no axe violations', async () => {
    const api = makeFakeApi({ downloadTranscriptionModel: vi.fn(started) });
    const { user, container } = setup(api);
    await startDownloading(user);
    api.emitModelDownloadProgress(
      makeModelDownloadProgressEvent({ phase: 'downloading', bytesDownloaded: 1_000_000, totalBytes: 488_636_416 }),
    );
    await screen.findByRole('progressbar');
    await expectNoAxeViolations(container);
  });

  it('error has no axe violations', async () => {
    const api = makeFakeApi({ downloadTranscriptionModel: vi.fn(started) });
    const { user, container } = setup(api);
    await startDownloading(user);
    api.emitModelDownloadProgress(
      makeModelDownloadProgressEvent({
        phase: 'error',
        error: { kind: 'network', message: 'offline', retryable: true },
      }),
    );
    await screen.findByRole('alert');
    await expectNoAxeViolations(container);
  });

  it('ready has no axe violations', async () => {
    const api = makeFakeApi({ isTranscriptionModelReady: vi.fn(() => Promise.resolve(true)) });
    const { container } = setup(api);
    await screen.findByText(/transcription is ready/i);
    await expectNoAxeViolations(container);
  });
});
