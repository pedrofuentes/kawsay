import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UserEvent } from '@testing-library/user-event';
import { OnboardingFlow } from '@renderer/onboarding/OnboardingFlow';
import { makeFakeApi, makeImportSummary, makeProgressEvent } from './support/fake-api';
import type { FakeApi } from './support/fake-api';
import { ViewProbe, wrapInProviders } from './support/render';

function setup(api: FakeApi = makeFakeApi()): { api: FakeApi; user: UserEvent } {
  const user = userEvent.setup();
  render(
    wrapInProviders(
      <>
        <OnboardingFlow />
        <ViewProbe />
      </>,
      api,
    ),
  );
  return { api, user };
}

async function reachLibraryStep(user: UserEvent): Promise<void> {
  await user.click(screen.getByRole('button', { name: /start bringing memories/i }));
  await user.type(screen.getByLabelText(/who are you honoring/i), 'Elena');
  await user.click(screen.getByRole('button', { name: /continue/i }));
}

async function reachSourceStep(user: UserEvent): Promise<void> {
  await reachLibraryStep(user);
  await user.type(screen.getByLabelText(/folder|where/i), '/Users/elena/Documents/Kawsay — Elena');
  await user.click(screen.getByRole('button', { name: /create .*library/i }));
  await screen.findByRole('heading', { name: /where are some of elena's memories/i });
}

async function reachImportLocate(user: UserEvent): Promise<void> {
  await reachSourceStep(user);
  await user.click(screen.getByRole('button', { name: /whatsapp/i }));
  // Advance through every export instruction until the locate screen appears.
  for (let i = 0; i < 8; i += 1) {
    const next = screen.queryByRole('button', { name: /i've done this/i });
    if (!next) break;
    await user.click(next);
  }
}

describe('Onboarding — Step 0: welcome (privacy you can feel)', () => {
  it('leads with reassurance that nothing leaves the computer and offers two calm choices', () => {
    setup();
    expect(screen.getByText(/never leave this computer/i)).toBeInTheDocument();
    expect(screen.getByText(/no account/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /start bringing memories/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /show me around first/i })).toBeInTheDocument();
  });

  it('renders inside a main landmark with a persistent privacy badge', () => {
    setup();
    expect(screen.getByRole('main')).toBeInTheDocument();
    expect(screen.getAllByText(/computer/i).length).toBeGreaterThan(0);
  });
});

describe('Onboarding — Step 1: name (by the second screen) + focus management', () => {
  it('moves focus to the step heading and asks the loved one\'s name', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: /start bringing memories/i }));
    const heading = await screen.findByRole('heading', { level: 1, name: /who are you honoring/i });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(screen.getByLabelText(/who are you honoring/i)).toBeInTheDocument();
  });

  it('uses the entered name in the very next step', async () => {
    const { user } = setup();
    await reachLibraryStep(user);
    expect(
      screen.getByRole('heading', { level: 1, name: /elena/i }),
    ).toBeInTheDocument();
  });
});

describe('Onboarding — Step 2: choose where the library lives (create / open)', () => {
  it('creates a library through the typed api with the chosen path and name', async () => {
    const { api, user } = setup();
    await reachLibraryStep(user);
    await user.type(screen.getByLabelText(/folder|where/i), '/Users/elena/Documents/Kawsay — Elena');
    await user.click(screen.getByRole('button', { name: /create .*library/i }));

    expect(api.createLibrary).toHaveBeenCalledWith({
      path: '/Users/elena/Documents/Kawsay — Elena',
      personName: 'Elena',
    });
    await screen.findByRole('heading', { name: /where are some of elena's memories/i });
  });

  it('can open an existing library instead of creating one', async () => {
    const { api, user } = setup();
    await reachLibraryStep(user);
    await user.click(screen.getByRole('button', { name: /already made|open a library/i }));
    await user.type(screen.getByLabelText(/folder|where/i), '/Users/elena/Documents/Kawsay — Elena');
    await user.click(screen.getByRole('button', { name: /^open/i }));

    expect(api.openLibrary).toHaveBeenCalledWith({
      path: '/Users/elena/Documents/Kawsay — Elena',
    });
  });

  it('shows a plain-language error (no OS code) when the folder cannot be used', async () => {
    const api = makeFakeApi({
      createLibrary: vi.fn(() => Promise.reject(new Error('EACCES: permission denied, mkdir /x'))),
    });
    const { user } = setup(api);
    await reachLibraryStep(user);
    await user.type(screen.getByLabelText(/folder|where/i), '/x');
    await user.click(screen.getByRole('button', { name: /create .*library/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toBeInTheDocument();
    expect(screen.queryByText(/EACCES/)).not.toBeInTheDocument();
    expect(screen.queryByText(/permission denied/i)).not.toBeInTheDocument();
  });
});

describe('Onboarding — Step 3: choose a source (AC-12)', () => {
  it('offers all five sources plus an "add later" escape hatch', async () => {
    const { user } = setup();
    await reachSourceStep(user);
    expect(screen.getByRole('button', { name: /whatsapp/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /folder of photos/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /google takeout/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /facebook/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /linkedin/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add this later/i })).toBeInTheDocument();
  });

  it('the escape hatch routes calmly into the main app', async () => {
    const { user } = setup();
    await reachSourceStep(user);
    await user.click(screen.getByRole('button', { name: /add this later/i }));
    expect(screen.getByTestId('active-view')).toHaveTextContent('timeline');
  });
});

describe('Onboarding — Step 4: guided "how to export" walkthrough (AC-12)', () => {
  it('hand-holds the user through the WhatsApp export before any picker', async () => {
    const { user } = setup();
    await reachSourceStep(user);
    await user.click(screen.getByRole('button', { name: /whatsapp/i }));

    expect(screen.getByRole('heading', { level: 1, name: /whatsapp/i })).toBeInTheDocument();
    expect(screen.getByText(/step 1 of/i)).toBeInTheDocument();
    expect(screen.getByText(/export chat/i)).toBeInTheDocument();
  });

  it('ends with the "only a copy" reassurance and a place to point at the file', async () => {
    const { user } = setup();
    await reachImportLocate(user);
    expect(screen.getByText(/just making a copy/i)).toBeInTheDocument();
    expect(screen.getByText(/nothing will be deleted/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /bring .*memories in/i })).toBeInTheDocument();
  });
});

describe('Onboarding — Step 5: import (progress, cancel, completion)', () => {
  it('surfaces a failed startImport bridge call in the import step instead of swallowing it (#25)', async () => {
    const api = makeFakeApi({
      startImport: vi.fn(() => Promise.reject(new Error('ERR_IMPORT_START_FAILED'))),
    });
    const { user } = setup(api);
    await reachImportLocate(user);
    await user.type(screen.getByLabelText(/file|folder|where/i), '/exports/whatsapp.zip');
    await user.click(screen.getByRole('button', { name: /bring .*memories in/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/interrupted bringing/i);
  });

  it('starts the import through the typed api with the chosen source and path', async () => {
    const { api, user } = setup();
    await reachImportLocate(user);
    await user.type(screen.getByLabelText(/file|folder|where/i), '/exports/whatsapp.zip');
    await user.click(screen.getByRole('button', { name: /bring .*memories in/i }));

    expect(api.startImport).toHaveBeenCalledWith({
      sourceType: 'whatsapp',
      inputPath: '/exports/whatsapp.zip',
    });
  });

  it('shows live percent-done progress and a running tally in a polite live region', async () => {
    const { api, user } = setup();
    await reachImportLocate(user);
    await user.type(screen.getByLabelText(/file|folder|where/i), '/exports/whatsapp.zip');
    await user.click(screen.getByRole('button', { name: /bring .*memories in/i }));

    api.emitProgress(
      makeProgressEvent({ phase: 'parse', processed: 84, total: 200, message: 'Reading through messages…' }),
    );

    const bar = await screen.findByRole('progressbar');
    await waitFor(() => expect(bar).toHaveAttribute('aria-valuenow', '42'));
    expect(screen.getByText(/Reading through messages…/)).toBeInTheDocument();
    expect(screen.getByText(/never leave this computer/i)).toBeInTheDocument();
  });

  it('offers a cancel that keeps already-found memories', async () => {
    const { api, user } = setup();
    await reachImportLocate(user);
    await user.type(screen.getByLabelText(/file|folder|where/i), '/exports/whatsapp.zip');
    await user.click(screen.getByRole('button', { name: /bring .*memories in/i }));

    await user.click(await screen.findByRole('button', { name: /cancel|stop/i }));
    expect(api.cancelImport).toHaveBeenCalledTimes(1);
  });

  it('reveals a warm count and routes into the main app on completion', async () => {
    const { api, user } = setup();
    await reachImportLocate(user);
    await user.type(screen.getByLabelText(/file|folder|where/i), '/exports/whatsapp.zip');
    await user.click(screen.getByRole('button', { name: /bring .*memories in/i }));

    api.emitProgress(
      makeProgressEvent({ phase: 'done', summary: makeImportSummary({ occurrencesAdded: 347 }) }),
    );

    expect(await screen.findByText(/347/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /see everything/i }));
    expect(screen.getByTestId('active-view')).toHaveTextContent('timeline');
  });

  it('surfaces skipped items without ever silently dropping them (AC-15)', async () => {
    const { api, user } = setup();
    await reachImportLocate(user);
    await user.type(screen.getByLabelText(/file|folder|where/i), '/exports/whatsapp.zip');
    await user.click(screen.getByRole('button', { name: /bring .*memories in/i }));

    api.emitProgress(
      makeProgressEvent({
        phase: 'done',
        summary: makeImportSummary({
          occurrencesAdded: 312,
          skipped: [{ ref: 'IMG_1.heic', reason: 'unreadable' }],
        }),
      }),
    );

    expect(await screen.findByText(/couldn't read/i)).toBeInTheDocument();
  });

  it('surfaces partial-metadata warnings without implying the memory was skipped', async () => {
    const { api, user } = setup();
    await reachImportLocate(user);
    await user.type(screen.getByLabelText(/file|folder|where/i), '/exports/photos');
    await user.click(screen.getByRole('button', { name: /bring .*memories in/i }));

    api.emitProgress(
      makeProgressEvent({
        phase: 'done',
        summary: makeImportSummary({
          occurrencesAdded: 1,
          skipped: [
            {
              ref: 'IMG_1.heic',
              reason: 'partial metadata unavailable: corrupt EXIF',
              code: 'E_EXIF',
            },
          ],
        }),
      }),
    );

    expect(await screen.findByText(/couldn't read every detail/i)).toBeInTheDocument();
    expect(screen.queryByText(/couldn't read 1 item/i)).toBeNull();
  });

  it('shows a calm error (never a raw ERR_ code) when the import fails', async () => {
    const { api, user } = setup();
    await reachImportLocate(user);
    await user.type(screen.getByLabelText(/file|folder|where/i), '/exports/whatsapp.zip');
    await user.click(screen.getByRole('button', { name: /bring .*memories in/i }));

    api.emitProgress(makeProgressEvent({ phase: 'done', error: 'ERR_ARCHIVE_UNSAFE_PATH' }));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByText(/ERR_ARCHIVE_UNSAFE_PATH/)).not.toBeInTheDocument();
  });
});

describe('Onboarding — folder source has a one-screen primer (no export steps)', () => {
  it('points the user at a folder and reassures originals are untouched', async () => {
    const { user } = setup();
    await reachSourceStep(user);
    await user.click(screen.getByRole('button', { name: /folder of photos/i }));
    expect(screen.getByText(/never changes or moves them|stay where they are/i)).toBeInTheDocument();
    const main = screen.getByRole('main');
    expect(within(main).getByRole('heading', { level: 1 })).toBeInTheDocument();
  });
});
