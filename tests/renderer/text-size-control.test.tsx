import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TextSizeControl } from '@renderer/components/TextSizeControl';
import { makeFakeApi, makeSettings } from './support/fake-api';
import type { FakeApi } from './support/fake-api';
import { wrapInProviders } from './support/render';
import { expectNoAxeViolations } from './support/axe';

function setup(api: FakeApi = makeFakeApi()) {
  const user = userEvent.setup();
  const { container } = render(wrapInProviders(<TextSizeControl />, api));
  return { api, user, container };
}

afterEach(() => {
  // The control applies a ROOT override (src/lib/settings.tsx); reset it so one
  // test's choice never bleeds into the next within this file.
  document.documentElement.removeAttribute('data-text-size');
  document.documentElement.style.removeProperty('--text-scale');
});

describe('TextSizeControl — renders three reverent, plain-language steps', () => {
  it('exposes Default / Large / Larger as labelled, individually reachable controls', async () => {
    setup();
    expect(await screen.findByRole('radio', { name: /default/i })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /^large$/i })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /larger/i })).toBeInTheDocument();
  });

  it('reflects the persisted step on mount', async () => {
    const api = makeFakeApi({ getSettings: vi.fn(() => Promise.resolve(makeSettings({ textSize: 'large' }))) });
    setup(api);
    const large = await screen.findByRole('radio', { name: /^large$/i });
    await waitFor(() => expect(large).toBeChecked());
    expect(screen.getByRole('radio', { name: /default/i })).not.toBeChecked();
  });

  it('every step is at least a 44px tap target', async () => {
    setup();
    const radios = await screen.findAllByRole('radio');
    for (const radio of radios) {
      const target = radio.closest('label');
      expect(target).not.toBeNull();
      expect(target?.className ?? '').toMatch(/min-h-(1[1-9]|[2-9]\d)\b/);
    }
  });
});

describe('TextSizeControl — persists via the settings channel', () => {
  it('choosing "Large" calls settings:set through the api and reflects it as checked', async () => {
    const api = makeFakeApi();
    const { user } = setup(api);
    const large = await screen.findByRole('radio', { name: /^large$/i });

    await user.click(large);

    expect(api.setSettings).toHaveBeenCalledWith({ textSize: 'large' });
    await waitFor(() => expect(large).toBeChecked());
  });

  it('choosing "Larger" persists that step specifically (not conflated with Large)', async () => {
    const api = makeFakeApi();
    const { user } = setup(api);
    const larger = await screen.findByRole('radio', { name: /larger/i });

    await user.click(larger);

    expect(api.setSettings).toHaveBeenCalledWith({ textSize: 'larger' });
  });
});

describe('TextSizeControl — applies app-wide IMMEDIATELY via a root override', () => {
  it('sets the root data-text-size attribute the instant a step is chosen, before the IPC round trip resolves', async () => {
    let resolveSet!: (value: ReturnType<typeof makeSettings>) => void;
    const pending = new Promise<ReturnType<typeof makeSettings>>((resolve) => {
      resolveSet = resolve;
    });
    const api = makeFakeApi({ setSettings: vi.fn(() => pending) });
    const { user } = setup(api);
    const larger = await screen.findByRole('radio', { name: /larger/i });

    await user.click(larger);

    // Applied at once — no need to wait for the main-process round trip.
    expect(document.documentElement.dataset.textSize).toBe('larger');
    resolveSet(makeSettings({ textSize: 'larger' }));
  });

  it('overrides the --text-scale custom property on the root so every view scales together', async () => {
    const api = makeFakeApi();
    const { user } = setup(api);
    const larger = await screen.findByRole('radio', { name: /larger/i });

    await user.click(larger);

    const scale = Number(document.documentElement.style.getPropertyValue('--text-scale'));
    expect(scale).toBeGreaterThan(1);
  });

  it('the Default step resets the scale back to 1', async () => {
    const api = makeFakeApi({ getSettings: vi.fn(() => Promise.resolve(makeSettings({ textSize: 'larger' }))) });
    const { user } = setup(api);
    const defaultStep = await screen.findByRole('radio', { name: /default/i });
    await waitFor(() => expect(document.documentElement.dataset.textSize).toBe('larger'));

    await user.click(defaultStep);

    expect(document.documentElement.dataset.textSize).toBe('default');
    expect(document.documentElement.style.getPropertyValue('--text-scale')).toBe('1');
  });
});

describe('TextSizeControl — accessibility (WCAG 2.1 AA) at every size', () => {
  it('has no axe violations at Default', async () => {
    const { container } = setup();
    await screen.findByRole('radio', { name: /default/i });
    await expectNoAxeViolations(container);
  });

  it('has no axe violations at Large', async () => {
    const api = makeFakeApi({ getSettings: vi.fn(() => Promise.resolve(makeSettings({ textSize: 'large' }))) });
    const { container } = setup(api);
    await screen.findByRole('radio', { name: /^large$/i, checked: true });
    await expectNoAxeViolations(container);
  });

  it('has no axe violations at Larger', async () => {
    const api = makeFakeApi({ getSettings: vi.fn(() => Promise.resolve(makeSettings({ textSize: 'larger' }))) });
    const { container } = setup(api);
    await screen.findByRole('radio', { name: /larger/i, checked: true });
    await expectNoAxeViolations(container);
  });
});
