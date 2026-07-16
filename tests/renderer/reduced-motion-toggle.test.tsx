import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReducedMotionToggle } from '@renderer/components/ReducedMotionToggle';
import { makeFakeApi, makeSettings } from './support/fake-api';
import type { FakeApi } from './support/fake-api';
import { wrapInProviders } from './support/render';
import { expectNoAxeViolations } from './support/axe';

function setup(api: FakeApi = makeFakeApi()) {
  const user = userEvent.setup();
  const { container } = render(wrapInProviders(<ReducedMotionToggle />, api));
  return { api, user, container };
}

afterEach(() => {
  document.documentElement.removeAttribute('data-reduced-motion');
});

describe('ReducedMotionToggle — an explicit, labelled control', () => {
  it('renders a labelled switch reflecting the OFF/auto default on mount', async () => {
    setup();
    const toggle = await screen.findByRole('switch', { name: /reduce motion/i });
    await waitFor(() => expect(toggle).not.toBeChecked());
  });

  it('reflects the persisted ON state on mount', async () => {
    const api = makeFakeApi({ getSettings: vi.fn(() => Promise.resolve(makeSettings({ reducedMotion: true }))) });
    setup(api);
    const toggle = await screen.findByRole('switch', { name: /reduce motion/i });
    await waitFor(() => expect(toggle).toBeChecked());
  });

  it('the switch is at least a 44px tap target', async () => {
    setup();
    const toggle = await screen.findByRole('switch', { name: /reduce motion/i });
    expect(toggle.className).toMatch(/h-11\b/);
  });
});

describe('ReducedMotionToggle — persists via the settings channel', () => {
  it('turning it ON persists setSettings({ reducedMotion: true })', async () => {
    const api = makeFakeApi();
    const { user } = setup(api);
    const toggle = await screen.findByRole('switch', { name: /reduce motion/i });

    await user.click(toggle);

    expect(api.setSettings).toHaveBeenCalledWith({ reducedMotion: true });
    await waitFor(() => expect(toggle).toBeChecked());
  });

  it('turning it back OFF persists setSettings({ reducedMotion: false })', async () => {
    const api = makeFakeApi({ getSettings: vi.fn(() => Promise.resolve(makeSettings({ reducedMotion: true }))) });
    const { user } = setup(api);
    const toggle = await screen.findByRole('switch', { name: /reduce motion/i });
    await waitFor(() => expect(toggle).toBeChecked());

    await user.click(toggle);

    expect(api.setSettings).toHaveBeenCalledWith({ reducedMotion: false });
    await waitFor(() => expect(toggle).not.toBeChecked());
  });
});

describe('ReducedMotionToggle — the root override composes with the OS media query', () => {
  it('setting it ON sets the root data-reduced-motion="on" attribute immediately', async () => {
    const api = makeFakeApi();
    const { user } = setup(api);
    const toggle = await screen.findByRole('switch', { name: /reduce motion/i });

    await user.click(toggle);

    expect(document.documentElement.dataset.reducedMotion).toBe('on');
  });

  it('leaving it OFF leaves the root attribute "off" — the OS query stays the sole source of truth', async () => {
    setup();
    await screen.findByRole('switch', { name: /reduce motion/i });
    await waitFor(() => expect(document.documentElement.dataset.reducedMotion).toBe('off'));
  });
});

describe('ReducedMotionToggle — accessibility (WCAG 2.1 AA)', () => {
  it('has no axe violations when off', async () => {
    const { container } = setup();
    await screen.findByRole('switch');
    await expectNoAxeViolations(container);
  });

  it('has no axe violations when on', async () => {
    const api = makeFakeApi({ getSettings: vi.fn(() => Promise.resolve(makeSettings({ reducedMotion: true }))) });
    const { container } = setup(api);
    await screen.findByRole('switch');
    await expectNoAxeViolations(container);
  });
});
