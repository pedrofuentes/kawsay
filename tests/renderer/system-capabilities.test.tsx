import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { SystemCapabilities } from '@renderer/components/SystemCapabilities';
import { makeFakeApi } from './support/fake-api';
import type { FakeApi } from './support/fake-api';
import { wrapInProviders } from './support/render';
import { expectNoAxeViolations } from './support/axe';
import type { CapabilitiesDTO } from '@shared/kawsay-api';

const HEALTHY: CapabilitiesDTO = {
  ffmpeg: true,
  ffprobe: true,
  clusterWorker: true,
  embedder: true,
  gazetteer: true,
};

function apiWith(capabilities: CapabilitiesDTO): FakeApi {
  return makeFakeApi({ getCapabilities: vi.fn(() => Promise.resolve(capabilities)) });
}

function setup(api: FakeApi): { container: HTMLElement } {
  const { container } = render(wrapInProviders(<SystemCapabilities />, api));
  return { container };
}

describe('SystemCapabilities — a calm, reverent degraded-capability notice (#441)', () => {
  it('renders nothing when every capability is available (the healthy build)', async () => {
    const { container } = setup(apiWith(HEALTHY));
    // Give the mount-time probe a tick to resolve, then assert it stays silent.
    await waitFor(() => expect(container.firstChild).toBeNull());
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('renders nothing when the probe returns no report (no bridge / failed probe)', async () => {
    const api = makeFakeApi({ getCapabilities: vi.fn(() => Promise.reject(new Error('x'))) });
    const { container } = setup(api);
    await waitFor(() => expect(api.getCapabilities).toHaveBeenCalled());
    expect(container.firstChild).toBeNull();
  });

  it('surfaces a gentle notice when video/voice-note previews are unavailable (ffmpeg missing)', async () => {
    setup(apiWith({ ...HEALTHY, ffmpeg: false }));

    const notice = await screen.findByRole('status');
    // Reverent, plain-language copy: no jargon (no "ffmpeg"/"binary"/"packaging"),
    // and never "the deceased" / "your loved one" phrasings.
    const text = notice.textContent ?? '';
    expect(text.toLowerCase()).not.toContain('ffmpeg');
    expect(text.toLowerCase()).not.toContain('packaging');
    expect(text.toLowerCase()).not.toContain('binary');
    expect(text.toLowerCase()).not.toContain('the deceased');
    // It reassures that everything else keeps working and stays on this computer.
    expect(text.toLowerCase()).toContain('this computer');
  });

  it('also surfaces the notice when ffprobe (the sibling media tool) is unavailable', async () => {
    setup(apiWith({ ...HEALTHY, ffprobe: false }));
    expect(await screen.findByRole('status')).toBeInTheDocument();
  });

  it('has no WCAG 2.1 AA axe violations while the notice is shown', async () => {
    const { container } = setup(apiWith({ ...HEALTHY, ffmpeg: false }));
    await screen.findByRole('status');
    await expectNoAxeViolations(container);
  });
});
