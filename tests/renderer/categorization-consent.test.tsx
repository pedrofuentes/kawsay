import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UserEvent } from '@testing-library/user-event';
import { CategorizationConsent } from '@renderer/components/CategorizationConsent';
import { makeFakeApi } from './support/fake-api';
import type { FakeApi } from './support/fake-api';
import { wrapInProviders } from './support/render';
import { expectNoAxeViolations } from './support/axe';

/** A fake whose categorization surface is OFFERED (the gazetteer asset is bundled). */
function offeredApi(opts: Partial<Parameters<typeof makeFakeApi>[0]> = {}): FakeApi {
  return makeFakeApi({
    getCategorizationStatus: vi.fn(() => Promise.resolve({ optedIn: false, offered: true })),
    ...opts,
  });
}

function setup(api: FakeApi = makeFakeApi()): { api: FakeApi; user: UserEvent; container: HTMLElement } {
  const user = userEvent.setup();
  const { container } = render(wrapInProviders(<CategorizationConsent />, api));
  return { api, user, container };
}

describe('CategorizationConsent — hidden until the gazetteer is bundled (the offered gate)', () => {
  it('renders nothing while categorization is not offered (no bundled gazetteer)', async () => {
    const api = makeFakeApi({
      getCategorizationStatus: vi.fn(() => Promise.resolve({ optedIn: false, offered: false })),
    });
    const { container } = setup(api);

    await waitFor(() => expect(api.getCategorizationStatus).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    expect(api.setCategorizationConsent).not.toHaveBeenCalled();
  });

  it('reveals the opt-in card once categorization is offered — no code change, just the gate', async () => {
    setup(offeredApi());
    expect(await screen.findByRole('switch', { name: /organi[sz]e|categor/i })).toBeInTheDocument();
  });
});

describe('CategorizationConsent — explains and asks before anything is organized (default-off)', () => {
  it('explains organizing by place/theme in calm, on-device, non-technical language', async () => {
    setup(offeredApi());
    await screen.findByRole('switch');
    // 100% on-device + memories never leave.
    expect(screen.getByText(/never leave this computer|stays on this computer/i)).toBeInTheDocument();
    // Off until chosen (default-off).
    expect(screen.getByText(/off until you|entirely optional|only when you turn/i)).toBeInTheDocument();
  });

  it('does NOT organize anything on mount — opt-in only', async () => {
    const { api } = setup(offeredApi());
    await screen.findByRole('switch');
    expect(api.setCategorizationConsent).not.toHaveBeenCalled();
    expect(api.startCategorization).not.toHaveBeenCalled();
  });

  it('reflects the current opted-OUT state on mount (switch is off)', async () => {
    setup(offeredApi());
    const toggle = await screen.findByRole('switch');
    await waitFor(() => expect(toggle).not.toBeChecked());
  });

  it('reflects the current opted-IN state on mount (switch is on)', async () => {
    const api = offeredApi({
      getCategorizationStatus: vi.fn(() => Promise.resolve({ optedIn: true, offered: true })),
    });
    setup(api);
    const toggle = await screen.findByRole('switch');
    await waitFor(() => expect(toggle).toBeChecked());
  });
});

describe('CategorizationConsent — the toggle drives the persisted consent', () => {
  it('turning it ON persists opt-in (setCategorizationConsent(true))', async () => {
    const api = offeredApi();
    const { user } = setup(api);
    const toggle = await screen.findByRole('switch');

    await user.click(toggle);

    expect(api.setCategorizationConsent).toHaveBeenCalledWith({ optedIn: true });
    await waitFor(() => expect(toggle).toBeChecked());
  });

  it('turning it OFF again persists opt-out (setCategorizationConsent(false)) — user control', async () => {
    const api = offeredApi({
      getCategorizationStatus: vi.fn(() => Promise.resolve({ optedIn: true, offered: true })),
    });
    const { user } = setup(api);
    const toggle = await screen.findByRole('switch');
    await waitFor(() => expect(toggle).toBeChecked());

    await user.click(toggle);

    expect(api.setCategorizationConsent).toHaveBeenCalledWith({ optedIn: false });
    await waitFor(() => expect(toggle).not.toBeChecked());
  });
});

describe('CategorizationConsent — accessibility (WCAG 2.1 AA)', () => {
  it('opted-out card has no axe violations', async () => {
    const { container } = setup(offeredApi());
    await screen.findByRole('switch');
    await expectNoAxeViolations(container);
  });

  it('opted-in card has no axe violations', async () => {
    const api = offeredApi({
      getCategorizationStatus: vi.fn(() => Promise.resolve({ optedIn: true, offered: true })),
    });
    const { container } = setup(api);
    await screen.findByRole('switch');
    await expectNoAxeViolations(container);
  });
});
