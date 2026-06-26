import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UserEvent } from '@testing-library/user-event';
import { TranscriptionConsent } from '@renderer/components/TranscriptionConsent';
import { makeFakeApi, makeModelDownloadProgressEvent } from './support/fake-api';
import type { FakeApi } from './support/fake-api';
import { wrapInProviders } from './support/render';
import { expectNoAxeViolations } from './support/axe';

const started = () => Promise.resolve({ status: 'started' as const });

function setup(api: FakeApi = makeFakeApi()): {
  api: FakeApi;
  user: UserEvent;
  container: HTMLElement;
} {
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
    // The heading above is always present, so await the intro-only copy directly to let
    // useModelDownload's checking→intro settle land before asserting (else this races it).
    expect(await screen.findByText(/read and search|searchable/i)).toBeInTheDocument();
    // 100% on-device + memories never leave.
    expect(screen.getByText(/never leave this computer/i)).toBeInTheDocument();
    // One-time ~465 MB download (derived from MODEL_SIZE_BYTES) — the only network the app makes.
    expect(screen.getByText(/465 MB/)).toBeInTheDocument();
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

  it('quotes the one-time download size derived from the model constant — 465 MB, not a stale 466', async () => {
    setup();
    await screen.findByRole('button', { name: /enable transcription/i });

    // 465 = Math.round(MODEL_SIZE_BYTES 487,601,967 / 1 MiB); in production the progress
    // reads the same 465 MB, so the intro must agree with it (it was hardcoded "466 MB").
    expect(screen.getByText(/about 465 MB/i)).toBeInTheDocument();
    expect(screen.queryByText(/466 MB/)).not.toBeInTheDocument();
  });

  it('starts the download exactly once even on a rapid double-click (no double opt-in)', async () => {
    const api = makeFakeApi({ downloadTranscriptionModel: vi.fn(started) });
    setup(api);
    const button = await screen.findByRole('button', { name: /enable transcription/i });

    // A grieving, non-technical user may double-tap; the opt-in must fire exactly once.
    fireEvent.click(button);
    fireEvent.click(button);

    await waitFor(() => expect(api.downloadTranscriptionModel).toHaveBeenCalledTimes(1));
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

describe('TranscriptionConsent — the ready state is announced to assistive tech (WCAG 2.1 AA SC 4.1.3)', () => {
  it('wraps the ready confirmation in a status live region and moves focus to it when the download finishes', async () => {
    const api = makeFakeApi({ downloadTranscriptionModel: vi.fn(started) });
    const { user } = setup(api);
    await startDownloading(user);

    api.emitModelDownloadProgress(makeModelDownloadProgressEvent({ phase: 'done' }));

    // A polite status region — so a screen reader still hears "ready" even though the
    // downloading live region has unmounted — holding the confirmation copy.
    const status = await screen.findByRole('status');
    expect(within(status).getByText(/transcription is ready/i)).toBeInTheDocument();
    // Focus follows to the confirmation as the now-gone "Enable" button unmounts.
    await waitFor(() => expect(status).toHaveFocus());
  });

  it('does not steal focus when the model is already present on mount (no opt-in just happened)', async () => {
    const api = makeFakeApi({ isTranscriptionModelReady: vi.fn(() => Promise.resolve(true)) });
    setup(api);

    const status = await screen.findByRole('status');
    expect(within(status).getByText(/transcription is ready/i)).toBeInTheDocument();
    // Opening Settings to an already-ready card must not yank focus away from the user.
    expect(status).not.toHaveFocus();
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

  it('keeps the gentle "Try again" while the failure is retryable', async () => {
    const api = makeFakeApi({ downloadTranscriptionModel: vi.fn(started) });
    const { user } = setup(api);
    await startDownloading(user);

    api.emitModelDownloadProgress(
      makeModelDownloadProgressEvent({
        phase: 'error',
        error: { kind: 'network', message: 'offline', retryable: true },
      }),
    );

    expect(await screen.findByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it('does NOT offer an endless retry on a permanent failure — shows calm alternate guidance', async () => {
    const api = makeFakeApi({ downloadTranscriptionModel: vi.fn(started) });
    const { user } = setup(api);
    await startDownloading(user);

    // The backend marks 403/404 and permission/cross-device/read-only-install failures
    // non-retryable; retrying would deterministically fail, so we must not invite it.
    api.emitModelDownloadProgress(
      makeModelDownloadProgressEvent({
        phase: 'error',
        error: { kind: 'http', message: 'HTTP 403 Forbidden', retryable: false },
      }),
    );

    const alert = await screen.findByRole('alert');
    expect(
      within(alert).getByText(/can't set up transcription on this computer/i),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /try again/i })).not.toBeInTheDocument();
    // Still calm: no raw codes or stack traces leak through.
    expect(screen.queryByText(/403/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Forbidden/)).not.toBeInTheDocument();
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
    // The switch is always rendered, so await the intro-only status copy to let the
    // checking→intro settle land before asserting the disabled gate (else this races it).
    expect(await screen.findByText(/isn't set up yet/i)).toBeInTheDocument();
    expect(toggle).toBeDisabled();
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
      makeModelDownloadProgressEvent({
        phase: 'downloading',
        bytesDownloaded: 1_000_000,
        totalBytes: 488_636_416,
      }),
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

  it('error (non-retryable, no retry) has no axe violations', async () => {
    const api = makeFakeApi({ downloadTranscriptionModel: vi.fn(started) });
    const { user, container } = setup(api);
    await startDownloading(user);
    api.emitModelDownloadProgress(
      makeModelDownloadProgressEvent({
        phase: 'error',
        error: { kind: 'http', message: 'HTTP 404 Not Found', retryable: false },
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
