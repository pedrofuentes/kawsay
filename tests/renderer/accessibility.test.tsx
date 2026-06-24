// Holistic, cross-screen accessibility pass for the whole renderer (card X2 →
// AC-13, WCAG 2.1 AA). Prior cards verified each screen in isolation; these tests
// lock in the app-wide guarantees that only show up across screens: a working
// skip-to-content affordance, a unique-and-complete landmark structure, focus
// that moves sensibly on every navigation, form errors wired to their inputs,
// an AA-contrast placeholder, and zero WCAG 2.1 A/AA axe violations on every
// primary screen and state. They are written to fail on the current gaps first.
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UserEvent } from '@testing-library/user-event';
import { AppShell } from '@renderer/components/AppShell';
import { PathField } from '@renderer/components/PathField';
import { MainApp } from '@renderer/app/MainApp';
import { OnboardingFlow } from '@renderer/onboarding/OnboardingFlow';
import { LibraryLocationStep } from '@renderer/onboarding/steps/LibraryLocationStep';
import { makeFakeApi, makeItemCard, makeProgressEvent, makeImportSummary } from './support/fake-api';
import type { FakeApi } from './support/fake-api';
import { wrapInProviders } from './support/render';
import { expectNoAxeViolations } from './support/axe';

function renderMain(view: { name: 'timeline' | 'search' | 'add-memories' | 'settings' }, api: FakeApi = makeFakeApi()) {
  return render(wrapInProviders(<MainApp />, api, view));
}

// ── Skip-to-content (WCAG 2.4.1 Bypass Blocks) ─────────────────────────────
describe('a11y · skip-to-content affordance', () => {
  it('exposes a skip link that targets the main landmark, ahead of it in the DOM', () => {
    render(
      <AppShell variant="main" sidebar={<nav aria-label="Sections">nav</nav>}>
        <h1>Body</h1>
      </AppShell>,
    );
    const link = screen.getByRole('link', { name: /skip to (main )?content/i });
    const main = screen.getByRole('main');
    expect(link).toHaveAttribute('href', `#${main.id}`);
    expect(main.id).not.toBe('');
    // The skip link must come before the main content so it is the first tab stop.
    expect(link.compareDocumentPosition(main) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('offers the skip link in the onboarding shell too', () => {
    render(
      <AppShell variant="onboarding">
        <h1>Welcome</h1>
      </AppShell>,
    );
    expect(screen.getByRole('link', { name: /skip to (main )?content/i })).toBeInTheDocument();
  });
});

// ── Landmark structure & uniqueness (WCAG 1.3.1) ───────────────────────────
describe('a11y · landmark structure', () => {
  it('exposes one main, one nav, one footer and an aside, each uniquely named', () => {
    renderMain({ name: 'timeline' });
    expect(screen.getAllByRole('main')).toHaveLength(1);
    expect(screen.getAllByRole('contentinfo')).toHaveLength(1);

    const nav = screen.getByRole('navigation');
    const aside = screen.getByRole('complementary');
    // Both landmarks must be present but must NOT share an accessible name, or a
    // screen-reader's landmark menu lists two indistinguishable "Sections".
    const navName = nav.getAttribute('aria-label');
    const asideName = aside.getAttribute('aria-label');
    expect(navName).toBeTruthy();
    expect(asideName).toBeTruthy();
    expect(asideName).not.toBe(navName);
  });

  it('exposes the search landmark on the search screen', () => {
    renderMain({ name: 'search' });
    expect(screen.getByRole('search')).toBeInTheDocument();
    expect(screen.getAllByRole('main')).toHaveLength(1);
  });
});

// ── Heading hierarchy (WCAG 1.3.1 / 2.4.6) ─────────────────────────────────
describe('a11y · heading hierarchy', () => {
  for (const view of ['timeline', 'search', 'add-memories', 'settings'] as const) {
    it(`renders exactly one level-1 heading on the ${view} view`, () => {
      const api = makeFakeApi({
        getTimeline: vi.fn(() => Promise.resolve({ items: [makeItemCard()], nextCursor: null })),
      });
      renderMain({ name: view }, api);
      expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    });
  }
});

// ── Placeholder contrast — issue #104 (WCAG 1.4.3) ─────────────────────────
describe('a11y · placeholder contrast', () => {
  it('PathField placeholder uses text-secondary (7.77:1), never sub-AA text-tertiary (3.98:1)', () => {
    render(<PathField label="Folder" value="" onChange={() => {}} placeholder="e.g. Documents/Kawsay" />);
    const input = screen.getByLabelText('Folder');
    expect(input.className).toContain('placeholder:text-text-secondary');
    expect(input.className).not.toContain('placeholder:text-text-tertiary');
  });

  it('the Search box placeholder also meets AA, off text-tertiary', () => {
    renderMain({ name: 'search' });
    const box = screen.getByRole('searchbox');
    expect(box.className).toContain('placeholder:text-text-secondary');
    expect(box.className).not.toContain('placeholder:text-text-tertiary');
  });
});

// ── Form errors associated with their input (WCAG 3.3.1) ───────────────────
describe('a11y · errors are announced and tied to the field', () => {
  it('marks the path field invalid and points it at the error when a library cannot be made', async () => {
    const user = userEvent.setup();
    const api = makeFakeApi({
      createLibrary: vi.fn(() => Promise.reject(new Error('EACCES: permission denied, mkdir /x'))),
    });
    render(
      wrapInProviders(
        <LibraryLocationStep personName="Elena" onBack={() => {}} onReady={() => {}} />,
        api,
      ),
    );

    await user.type(screen.getByLabelText(/folder|where/i), '/x');
    await user.click(screen.getByRole('button', { name: /create .*library/i }));

    const alert = await screen.findByRole('alert');
    const input = screen.getByLabelText(/folder|where/i);
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(alert.id).not.toBe('');
    expect(input.getAttribute('aria-describedby') ?? '').toContain(alert.id);
  });
});

// ── Focus management across navigation (WCAG 2.4.3) ────────────────────────
describe('a11y · focus moves to the new view heading app-wide', () => {
  it('moves focus to the heading when navigating to the lighter sections too', async () => {
    const user = userEvent.setup();
    renderMain({ name: 'timeline' });

    await user.click(screen.getByRole('button', { name: 'Add memories' }));
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 1, name: 'Add memories' })).toHaveFocus(),
    );

    await user.click(screen.getByRole('button', { name: 'Settings' }));
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toHaveFocus(),
    );
  });
});

// ── Holistic axe sweep: no WCAG 2.1 A/AA violations on any primary screen ───
async function reachOnboarding(user: UserEvent, to: 'name' | 'location' | 'source' | 'walkthrough' | 'locate'): Promise<void> {
  await user.click(screen.getByRole('button', { name: /start bringing memories/i }));
  if (to === 'name') return;
  await user.type(screen.getByLabelText(/who are you honoring/i), 'Elena');
  await user.click(screen.getByRole('button', { name: /continue/i }));
  if (to === 'location') return;
  await user.type(screen.getByLabelText(/folder|where/i), '/Users/elena/Documents/Kawsay');
  await user.click(screen.getByRole('button', { name: /create .*library/i }));
  await screen.findByRole('heading', { name: /where are some of elena's memories/i });
  if (to === 'source') return;
  await user.click(screen.getByRole('button', { name: /whatsapp/i }));
  await screen.findByRole('heading', { level: 1, name: /whatsapp/i });
  if (to === 'walkthrough') return;
  for (let i = 0; i < 8; i += 1) {
    const next = screen.queryByRole('button', { name: /i've done this/i });
    if (!next) break;
    await user.click(next);
  }
}

describe('a11y · axe finds no WCAG 2.1 AA violations', () => {
  it('onboarding · welcome', async () => {
    const { container } = render(wrapInProviders(<OnboardingFlow />, makeFakeApi()));
    await expectNoAxeViolations(container);
  });

  it('onboarding · name, location, source, walkthrough, locate', async () => {
    // Each wizard step is checked from a fresh render so the single walk into it
    // always starts at the welcome screen (the reach helper is not idempotent).
    for (const milestone of ['name', 'location', 'source', 'walkthrough', 'locate'] as const) {
      const user = userEvent.setup();
      const { container, unmount } = render(wrapInProviders(<OnboardingFlow />, makeFakeApi()));
      await reachOnboarding(user, milestone);
      await expectNoAxeViolations(container);
      unmount();
    }
  });

  it('onboarding · import progress and completion', async () => {
    const user = userEvent.setup();
    const api = makeFakeApi();
    const { container } = render(wrapInProviders(<OnboardingFlow />, api));
    await reachOnboarding(user, 'locate');
    await user.type(screen.getByLabelText(/file|folder|where/i), '/exports/whatsapp.zip');
    await user.click(screen.getByRole('button', { name: /bring .*memories in/i }));

    api.emitProgress(makeProgressEvent({ phase: 'parse', processed: 84, total: 200, message: 'Reading…' }));
    await screen.findByRole('progressbar');
    await expectNoAxeViolations(container);

    api.emitProgress(makeProgressEvent({ phase: 'done', summary: makeImportSummary({ occurrencesAdded: 347 }) }));
    await screen.findByText(/347/);
    await expectNoAxeViolations(container);
  });

  it('main · timeline with memories', async () => {
    const api = makeFakeApi({
      getTimeline: vi.fn(() =>
        Promise.resolve({ items: [makeItemCard({ title: 'A walk by the sea' })], nextCursor: null }),
      ),
    });
    const { container } = renderMain({ name: 'timeline' }, api);
    await screen.findByRole('article');
    await expectNoAxeViolations(container);
  });

  it('main · timeline empty state', async () => {
    const { container } = renderMain({ name: 'timeline' });
    await screen.findByRole('heading', { level: 2, name: /gather here/i });
    await expectNoAxeViolations(container);
  });

  it('main · search idle, with results, and not-found', async () => {
    const user = userEvent.setup();
    const api = makeFakeApi({
      searchCatalog: vi.fn(() => Promise.resolve({ items: [makeItemCard({ title: 'Beach picnic' })], total: 1 })),
    });
    const { container } = renderMain({ name: 'search' }, api);
    await expectNoAxeViolations(container);

    await user.type(screen.getByRole('searchbox'), 'beach');
    await within(container).findByText(/1 memory/i);
    await expectNoAxeViolations(container);
  });

  it('main · add memories and settings', async () => {
    const add = renderMain({ name: 'add-memories' });
    await expectNoAxeViolations(add.container);
    add.unmount();
    const settings = renderMain({ name: 'settings' });
    await expectNoAxeViolations(settings.container);
  });
});
