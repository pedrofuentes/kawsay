import { afterEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Settings } from '@renderer/views/Settings';
import { makeFakeApi } from './support/fake-api';
import { wrapInProviders } from './support/render';
import { expectNoAxeViolations } from './support/axe';

afterEach(() => {
  document.documentElement.removeAttribute('data-text-size');
  document.documentElement.style.removeProperty('--text-scale');
  document.documentElement.removeAttribute('data-reduced-motion');
});

describe('Settings — AC-13 / Journey G accessibility surface (#433)', () => {
  it('hosts the text-size control, the reduced-motion toggle, and the library location', async () => {
    render(wrapInProviders(<Settings />, makeFakeApi()));

    expect(await screen.findByRole('radio', { name: /default/i })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: /reduce motion/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /open another library/i })).toBeInTheDocument();
  });

  it('restates the local-only promise (P4) in the privacy section', async () => {
    render(wrapInProviders(<Settings />, makeFakeApi()));
    await screen.findByRole('radio', { name: /default/i });

    expect(screen.getByText(/your memories never leave this computer/i)).toBeInTheDocument();
  });

  it('still hosts the existing consent cards and suggestions tray (no regression)', async () => {
    render(wrapInProviders(<Settings />, makeFakeApi()));

    expect(await screen.findByText(/place names/i)).toBeInTheDocument();
  });

  it('has no WCAG 2.1 AA axe violations end to end', async () => {
    const { container } = render(wrapInProviders(<Settings />, makeFakeApi()));
    await screen.findByRole('radio', { name: /default/i });
    await expectNoAxeViolations(container);
  });
});
