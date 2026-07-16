import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LibrarySettings } from '@renderer/components/LibrarySettings';
import { KawsayApiProvider } from '@renderer/lib/kawsay-api';
import { LibraryProvider, useLibrary } from '@renderer/lib/library';
import { SettingsProvider } from '@renderer/lib/settings';
import { makeFakeApi, makeLibrarySummary } from './support/fake-api';
import type { FakeApi } from './support/fake-api';
import { expectNoAxeViolations } from './support/axe';

/** LibrarySettings reads the OPEN library from LibraryContext (not a fetch of its
 *  own), so the harness opens one first — exactly how a real Settings visit
 *  always follows an already-open library. */
function OpenerThenSettings({ path }: { path: string }) {
  const { openLibrary } = useLibrary();
  return (
    <>
      <button type="button" onClick={() => void openLibrary({ path })}>
        open-for-test
      </button>
      <LibrarySettings />
    </>
  );
}

async function renderWithOpenLibrary(api: FakeApi, summary = makeLibrarySummary()) {
  const user = userEvent.setup();
  const utils = render(
    <KawsayApiProvider api={api}>
      <SettingsProvider>
        <LibraryProvider>
          <OpenerThenSettings path={summary.root} />
        </LibraryProvider>
      </SettingsProvider>
    </KawsayApiProvider>,
  );
  await user.click(screen.getByText('open-for-test'));
  await waitFor(() => expect(api.openLibrary).toHaveBeenCalled());
  return { ...utils, user, api };
}

describe('LibrarySettings — shows where the library lives', () => {
  it('shows the current library name and root path', async () => {
    const summary = makeLibrarySummary({ name: 'Elena', root: '/Users/elena/Kawsay — Elena' });
    const api = makeFakeApi({ openLibrary: vi.fn(() => Promise.resolve(summary)) });
    const { container } = await renderWithOpenLibrary(api, summary);

    await waitFor(() => expect(container.textContent ?? '').toContain('/Users/elena/Kawsay — Elena'));
    expect(container.textContent ?? '').toMatch(/Elena.{0,3}s memories live at/);
  });
});

describe('LibrarySettings — "Open another library" reuses LibraryProvider\'s existing flow', () => {
  it("reveals a folder chooser and opening it calls the provider's openLibrary — no new IPC", async () => {
    const opened = makeLibrarySummary({ name: 'Second library', root: '/Users/elena/Second' });
    const api = makeFakeApi({
      openLibrary: vi.fn(() => Promise.resolve(opened)),
      openDirectory: vi.fn(() => Promise.resolve('/Users/elena/Second')),
    });
    const { user } = await renderWithOpenLibrary(api);

    await user.click(await screen.findByRole('button', { name: /open another library/i }));
    const pathInput = await screen.findByLabelText(/folder/i);
    await user.type(pathInput, '/Users/elena/Second');
    await user.click(screen.getByRole('button', { name: /open this library/i }));

    await waitFor(() =>
      expect(api.openLibrary).toHaveBeenCalledWith(
        expect.objectContaining({ path: expect.stringContaining('/Users/elena/Second') }),
      ),
    );
  });
});

describe('LibrarySettings — accessibility (WCAG 2.1 AA)', () => {
  it('has no axe violations showing the current library', async () => {
    const api = makeFakeApi();
    const { container } = await renderWithOpenLibrary(api);
    await expectNoAxeViolations(container);
  });
});
