// The re-entry Add Memories view (#427). After onboarding the sidebar's "Add
// memories" must offer the same guided source flow — pick a source → guided export
// walkthrough → point at the file → import with progress, cancel-keeps-what's-found,
// and a completion summary — but hosted inside the app shell (no wizard chrome, the
// sidebar stays), reusing the onboarding source registry and step components and
// driving the existing `import:*` bridge (no new IPC channel). These tests are
// written to fail against the placeholder first.
import { useEffect } from 'react';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UserEvent } from '@testing-library/user-event';
import { AddMemories } from '@renderer/views/AddMemories';
import { useLibrary } from '@renderer/lib/library';
import { makeFakeApi, makeImportSummary, makeProgressEvent } from './support/fake-api';
import type { FakeApi } from './support/fake-api';
import { ViewProbe, wrapInProviders } from './support/render';
import { expectNoAxeViolations } from './support/axe';

// Post-onboarding reality: a library is already open. This mirrors createLibrary's
// effect during onboarding (name = person's name) so the view can name the person
// in its copy without touching product code.
function WithOpenLibrary({ name }: { name: string }): ReactElement | null {
  const { library, createLibrary } = useLibrary();
  useEffect(() => {
    if (library === null) {
      void createLibrary({ path: '/Users/elena/Documents/Kawsay — Elena', personName: name });
    }
  }, [library, createLibrary, name]);
  return library === null ? null : <AddMemories />;
}

function setup(
  api: FakeApi = makeFakeApi(),
  name = 'Elena',
): { api: FakeApi; user: UserEvent; container: HTMLElement } {
  const user = userEvent.setup();
  const { container } = render(
    wrapInProviders(
      <>
        <WithOpenLibrary name={name} />
        <ViewProbe />
      </>,
      api,
    ),
  );
  return { api, user, container };
}

async function reachLanding(): Promise<HTMLElement> {
  return screen.findByRole('heading', { level: 1, name: 'Add memories' });
}

async function reachWalkthrough(user: UserEvent): Promise<void> {
  await reachLanding();
  await user.click(screen.getByRole('button', { name: /whatsapp/i }));
  await screen.findByRole('heading', { level: 1, name: /whatsapp/i });
}

async function reachLocate(user: UserEvent): Promise<void> {
  await reachWalkthrough(user);
  for (let i = 0; i < 8; i += 1) {
    const next = screen.queryByRole('button', { name: /i've done this/i });
    if (!next) break;
    await user.click(next);
  }
}

async function runImport(
  user: UserEvent,
  path = '/exports/whatsapp.zip',
): Promise<void> {
  await reachLocate(user);
  await user.type(screen.getByLabelText(/file|folder|where/i), path);
  await user.click(screen.getByRole('button', { name: /bring .*memories in/i }));
}

describe('Add memories — landing (source chooser inside the app shell)', () => {
  it('moves focus to an "Add memories" heading and offers the guided sources', async () => {
    setup();
    const heading = await reachLanding();
    await waitFor(() => expect(heading).toHaveFocus());
    expect(screen.getByRole('button', { name: /whatsapp/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /folder of photos/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /google takeout/i })).toBeInTheDocument();
  });

  it('shows exactly one level-1 heading on the landing', async () => {
    setup();
    await reachLanding();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  it('offers a calm way back to the timeline without importing', async () => {
    const { user } = setup();
    await reachLanding();
    await user.click(screen.getByRole('button', { name: /go back|back to the timeline/i }));
    expect(screen.getByTestId('active-view')).toHaveTextContent('timeline');
  });

  it('has no WCAG 2.1 AA axe violations on the landing', async () => {
    const { container } = setup();
    await reachLanding();
    await expectNoAxeViolations(container);
  });
});

describe('Add memories — guided export walkthrough (AC-12)', () => {
  it('hand-holds through the WhatsApp export, naming the person, before any picker', async () => {
    const { user } = setup();
    await reachWalkthrough(user);
    expect(screen.getByRole('heading', { level: 1, name: /elena.*whatsapp|whatsapp/i })).toBeInTheDocument();
    expect(screen.getByText(/step 1 of/i)).toBeInTheDocument();
    expect(screen.getByText(/export chat/i)).toBeInTheDocument();
  });

  it('moves focus to the walkthrough heading when it opens', async () => {
    const { user } = setup();
    await reachWalkthrough(user);
    const heading = screen.getByRole('heading', { level: 1, name: /whatsapp/i });
    await waitFor(() => expect(heading).toHaveFocus());
  });

  it('has no axe violations on the walkthrough', async () => {
    const { user, container } = setup();
    await reachWalkthrough(user);
    await expectNoAxeViolations(container);
  });
});

describe('Add memories — locate the saved export', () => {
  it('ends with the "only a copy" reassurance and a place to point at the file', async () => {
    const { user } = setup();
    await reachLocate(user);
    expect(screen.getByText(/just making a copy/i)).toBeInTheDocument();
    expect(screen.getByText(/nothing will be deleted/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /bring .*memories in/i })).toBeInTheDocument();
  });

  it('has no axe violations on the locate screen', async () => {
    const { user, container } = setup();
    await reachLocate(user);
    await expectNoAxeViolations(container);
  });
});

describe('Add memories — import (reuses import:*; progress, cancel, completion)', () => {
  it('starts the import through the existing bridge with the chosen source and path', async () => {
    const { api, user } = setup();
    await runImport(user, '/exports/whatsapp.zip');
    expect(api.startImport).toHaveBeenCalledWith({
      sourceType: 'whatsapp',
      inputPath: '/exports/whatsapp.zip',
    });
  });

  it('shows live percent-done progress and a running tally in a polite live region', async () => {
    const { api, user } = setup();
    await runImport(user);

    api.emitProgress(
      makeProgressEvent({ phase: 'parse', processed: 84, total: 200, message: 'Reading through messages…' }),
    );

    const bar = await screen.findByRole('progressbar');
    await waitFor(() => expect(bar).toHaveAttribute('aria-valuenow', '42'));
    expect(screen.getByText(/Reading through messages…/)).toBeInTheDocument();
    await expectNoAxeViolations(document.body);
  });

  it('offers a cancel that keeps already-found memories', async () => {
    const { api, user } = setup();
    await runImport(user);
    await user.click(await screen.findByRole('button', { name: /cancel|stop/i }));
    expect(api.cancelImport).toHaveBeenCalledTimes(1);
  });

  it('reveals a warm count on completion and routes into the timeline', async () => {
    const { api, user } = setup();
    await runImport(user);

    api.emitProgress(
      makeProgressEvent({ phase: 'done', summary: makeImportSummary({ occurrencesAdded: 347 }) }),
    );

    expect(await screen.findByText(/347/)).toBeInTheDocument();
    await expectNoAxeViolations(document.body);
    await user.click(screen.getByRole('button', { name: /see everything/i }));
    expect(screen.getByTestId('active-view')).toHaveTextContent('timeline');
  });

  it('surfaces skipped items via the reusable "See which ones?" disclosure (#430) without silently dropping them', async () => {
    const { api, user } = setup();
    await runImport(user);

    api.emitProgress(
      makeProgressEvent({
        phase: 'done',
        summary: makeImportSummary({
          occurrencesAdded: 312,
          skipped: [{ ref: 'exports/IMG_1.heic', reason: 'unreadable', code: 'E_READ' }],
        }),
      }),
    );

    // The completion summary reuses ImportStep, which now hosts #430's disclosure —
    // every skipped item is inspectable behind a single calm toggle, not silently
    // dropped. Expanding it lists the file by name with a plain-language reason.
    const toggle = await screen.findByRole('button', { name: /see which ones\?/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('IMG_1.heic')).toBeInTheDocument();
    expect(screen.getByText(/couldn't read this file/i)).toBeInTheDocument();
  });

  it('shows a calm error (never a raw ERR_ code) when the import fails', async () => {
    const { api, user } = setup();
    await runImport(user);

    api.emitProgress(makeProgressEvent({ phase: 'done', error: 'ERR_ARCHIVE_UNSAFE_PATH' }));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByText(/ERR_ARCHIVE_UNSAFE_PATH/)).not.toBeInTheDocument();
  });

  it('keeps a single level-1 heading through every face', async () => {
    const { api, user } = setup();
    await runImport(user);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    api.emitProgress(
      makeProgressEvent({ phase: 'done', summary: makeImportSummary({ occurrencesAdded: 5 }) }),
    );
    await screen.findByText(/5 memories/i);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });
});
