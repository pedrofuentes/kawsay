import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ItemView } from '@renderer/views/ItemView';
import type { ItemCardDTO, TranscriptionSnapshotDTO } from '@shared/kawsay-api';
import { makeFakeApi, makeItemCard, makeTranscriptView } from './support/fake-api';
import type { FakeApi } from './support/fake-api';
import { ViewProbe, wrapInProviders } from './support/render';
import { expectNoAxeViolations } from './support/axe';

function runningStatus(): TranscriptionSnapshotDTO {
  return {
    state: 'running',
    counts: { total: 3, transcribed: 1, failed: 0, skipped: 0, inFlight: 1 },
    lastItem: null,
  };
}

function renderItem(item: ItemCardDTO, api: FakeApi = makeFakeApi()) {
  const user = userEvent.setup();
  const result = render(wrapInProviders(<ItemView />, api, { name: 'item', item }));
  return { api, user, ...result };
}

describe('ItemView — the per-item transcript (read-only, #136)', () => {
  it('shows the spoken words of a finished transcript, read-only (no media element, no editor)', async () => {
    const item = makeItemCard({
      id: '00000000-0000-4000-8000-0000000000a1',
      mediaType: 'audio',
      title: "Grandpa's story",
    });
    const api = makeFakeApi({
      getTranscript: vi.fn(() =>
        Promise.resolve(
          makeTranscriptView({ status: 'done', language: 'en', text: 'Once upon a time, by the sea.' }),
        ),
      ),
    });
    const { container } = renderItem(item, api);

    expect(await screen.findByText(/once upon a time, by the sea/i)).toBeInTheDocument();
    expect(api.getTranscript).toHaveBeenCalledWith({ id: '00000000-0000-4000-8000-0000000000a1' });
    // Read-only: nothing auto-plays and nothing is editable (R11 / AC-14 posture).
    expect(container.querySelector('video, audio')).toBeNull();
    expect(container.querySelector('textarea, input, [contenteditable="true"]')).toBeNull();
  });

  it('marks the words with the detected language so a screen reader pronounces them (lang)', async () => {
    const item = makeItemCard({ mediaType: 'audio', title: 'Una nota de voz' });
    const api = makeFakeApi({
      getTranscript: vi.fn(() =>
        Promise.resolve(
          makeTranscriptView({ status: 'done', language: 'es', text: 'Hola, te quiero mucho.' }),
        ),
      ),
    });
    renderItem(item, api);

    const words = await screen.findByText(/te quiero mucho/i);
    const tagged = words.closest('[lang]');
    expect(tagged).not.toBeNull();
    expect(tagged).toHaveAttribute('lang', 'es');
  });

  it('omits the lang marker entirely when no language was detected (never lang="null")', async () => {
    const item = makeItemCard({ mediaType: 'video', title: 'Home movie' });
    const api = makeFakeApi({
      getTranscript: vi.fn(() =>
        Promise.resolve(
          makeTranscriptView({ status: 'done', language: null, text: 'Laughter and the wind.' }),
        ),
      ),
    });
    const { container } = renderItem(item, api);

    expect(await screen.findByText(/laughter and the wind/i)).toBeInTheDocument();
    // A null language must not become a bogus lang attribute on the transcript text.
    expect(container.querySelector('[lang="null"]')).toBeNull();
    expect(container.querySelector('[lang=""]')).toBeNull();
  });

  it('renders a video item’s transcript too (audio AND video are transcribable)', async () => {
    const item = makeItemCard({ mediaType: 'video', title: 'Birthday clip' });
    const api = makeFakeApi({
      getTranscript: vi.fn(() =>
        Promise.resolve(makeTranscriptView({ status: 'done', language: 'en', text: 'Happy birthday to you.' })),
      ),
    });
    renderItem(item, api);

    expect(await screen.findByText(/happy birthday to you/i)).toBeInTheDocument();
  });
});

describe('ItemView — transcript status states are calm, never technical (#136)', () => {
  it('says "transcribing" while a run is active and this item is still pending', async () => {
    const item = makeItemCard({ mediaType: 'audio', title: 'Pending note' });
    const api = makeFakeApi({
      getTranscript: vi.fn(() => Promise.resolve(makeTranscriptView({ status: 'pending' }))),
      getTranscriptionStatus: vi.fn(() => Promise.resolve(runningStatus())),
    });
    renderItem(item, api);

    expect(await screen.findByText(/transcribing/i)).toBeInTheDocument();
  });

  it('says "not transcribed yet" when pending and no run is in progress', async () => {
    const item = makeItemCard({ mediaType: 'audio', title: 'Idle note' });
    const api = makeFakeApi({
      getTranscript: vi.fn(() => Promise.resolve(makeTranscriptView({ status: 'pending' }))),
    });
    renderItem(item, api);

    expect(await screen.findByText(/not transcribed yet/i)).toBeInTheDocument();
  });

  it('says it "couldn’t" — gently — when transcription failed for this item', async () => {
    const item = makeItemCard({ mediaType: 'audio', title: 'Hard audio' });
    const api = makeFakeApi({
      getTranscript: vi.fn(() => Promise.resolve(makeTranscriptView({ status: 'failed' }))),
    });
    renderItem(item, api);

    expect(await screen.findByText(/couldn't (be )?transcrib/i)).toBeInTheDocument();
  });

  it('notes there were no words to capture when the item was skipped', async () => {
    const item = makeItemCard({ mediaType: 'video', title: 'Silent clip' });
    const api = makeFakeApi({
      getTranscript: vi.fn(() => Promise.resolve(makeTranscriptView({ status: 'skipped' }))),
    });
    renderItem(item, api);

    expect(await screen.findByText(/no (spoken )?words|nothing was said|no words to capture/i)).toBeInTheDocument();
  });

  it('stays calm — "looking for the words" — when the transcript read is rejected (#164)', async () => {
    const item = makeItemCard({ mediaType: 'audio', title: 'Unreadable note' });
    const api = makeFakeApi({
      getTranscript: vi.fn(() => Promise.reject(new Error('transcript read failed'))),
    });
    renderItem(item, api);

    // A failed read must never surface an error — the item view keeps its gentle
    // placeholder so the page stays calm (#164, mirrors use-transcript's catch).
    expect(await screen.findByText(/looking for the words/i)).toBeInTheDocument();
    expect(api.getTranscript).toHaveBeenCalledWith({ id: item.id });
  });
});

describe('ItemView — only audio/video carry a transcript', () => {
  it('never asks for, or shows, a transcript on a photo', async () => {
    const item = makeItemCard({ mediaType: 'photo', title: 'Sunset over the bay' });
    const api = makeFakeApi({ getTranscript: vi.fn(() => Promise.resolve(makeTranscriptView())) });
    renderItem(item, api);

    expect(await screen.findByRole('heading', { level: 1, name: /sunset over the bay/i })).toBeInTheDocument();
    expect(api.getTranscript).not.toHaveBeenCalled();
    expect(screen.queryByText(/what was said/i)).not.toBeInTheDocument();
  });
});

describe('ItemView — untrusted transcript text is rendered as escaped data (security)', () => {
  it('never interprets markup smuggled into the spoken words', async () => {
    const item = makeItemCard({ mediaType: 'audio', title: 'Note' });
    const malicious = '<script>window.__xssT__=1</script> hello there';
    const api = makeFakeApi({
      getTranscript: vi.fn(() =>
        Promise.resolve(makeTranscriptView({ status: 'done', language: 'en', text: malicious })),
      ),
    });
    const { container } = renderItem(item, api);

    expect(await screen.findByText(/<script>window\.__xssT__=1<\/script> hello there/)).toBeInTheDocument();
    expect(container.querySelector('script')).toBeNull();
    expect((window as unknown as { __xssT__?: number }).__xssT__).toBeUndefined();
  });
});

describe('ItemView — moving back', () => {
  it('returns to where the user came from', async () => {
    const item = makeItemCard({ mediaType: 'audio', title: 'A voice note' });
    const api = makeFakeApi({
      getTranscript: vi.fn(() => Promise.resolve(makeTranscriptView({ status: 'done', language: 'en', text: 'Hi.' }))),
    });
    const user = userEvent.setup();
    render(
      wrapInProviders(
        <>
          <ItemView />
          <ViewProbe />
        </>,
        api,
        { name: 'item', item, from: { name: 'search' } },
      ),
    );

    await user.click(await screen.findByRole('button', { name: /back/i }));
    expect(screen.getByTestId('active-view')).toHaveTextContent('search');
  });

  it('falls back to the timeline when there is no remembered origin', async () => {
    const item = makeItemCard({ mediaType: 'audio', title: 'A voice note' });
    const api = makeFakeApi({
      getTranscript: vi.fn(() => Promise.resolve(makeTranscriptView({ status: 'done', language: 'en', text: 'Hi.' }))),
    });
    const user = userEvent.setup();
    render(
      wrapInProviders(
        <>
          <ItemView />
          <ViewProbe />
        </>,
        api,
        { name: 'item', item },
      ),
    );

    await user.click(await screen.findByRole('button', { name: /back/i }));
    expect(screen.getByTestId('active-view')).toHaveTextContent('timeline');
  });
});

describe('ItemView — favourite toggle (#434, part of #434)', () => {
  it('renders a real toggle button reflecting the item’s current favourite state', async () => {
    const item = makeItemCard({ mediaType: 'photo', title: 'Sunset over the bay', isFavourite: false });
    renderItem(item);

    const toggle = await screen.findByRole('button', { name: /mark as favourite/i });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
  });

  it('starts pressed when the item already carries the persisted favourite flag', async () => {
    const item = makeItemCard({ mediaType: 'photo', title: 'Already loved', isFavourite: true });
    renderItem(item);

    const toggle = await screen.findByRole('button', { name: /remove from favourites/i });
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
  });

  it('flips state and persists via the catalog:setFavourite channel on click', async () => {
    const item = makeItemCard({
      id: '00000000-0000-4000-8000-0000000000f1',
      mediaType: 'photo',
      title: 'A quiet afternoon',
      isFavourite: false,
    });
    const setFavourite = vi.fn(() => Promise.resolve({ isFavourite: true }));
    const api = makeFakeApi({ setFavourite });
    const { user } = renderItem(item, api);

    const toggle = await screen.findByRole('button', { name: /mark as favourite/i });
    await user.click(toggle);

    expect(setFavourite).toHaveBeenCalledWith({
      id: '00000000-0000-4000-8000-0000000000f1',
      favourite: true,
    });
    expect(await screen.findByRole('button', { name: /remove from favourites/i })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('toggling back off calls the channel with favourite: false', async () => {
    const item = makeItemCard({ mediaType: 'photo', title: 'Loved memory', isFavourite: true });
    const setFavourite = vi.fn(() => Promise.resolve({ isFavourite: false }));
    const api = makeFakeApi({ setFavourite });
    const { user } = renderItem(item, api);

    const toggle = await screen.findByRole('button', { name: /remove from favourites/i });
    await user.click(toggle);

    expect(setFavourite).toHaveBeenCalledWith({ id: item.id, favourite: false });
    expect(await screen.findByRole('button', { name: /mark as favourite/i })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('politely announces the new state so a screen-reader user hears the change', async () => {
    const item = makeItemCard({ mediaType: 'photo', title: 'A quiet afternoon', isFavourite: false });
    const setFavourite = vi.fn(() => Promise.resolve({ isFavourite: true }));
    const api = makeFakeApi({ setFavourite });
    const { user, container } = renderItem(item, api);

    const toggle = await screen.findByRole('button', { name: /mark as favourite/i });
    await user.click(toggle);

    const live = container.querySelector('[aria-live="polite"]');
    expect(live).not.toBeNull();
    await screen.findByText(/added to favourites/i);
  });

  it('reverts the visible state when persisting fails (nothing on disk changed, so the UI must not lie)', async () => {
    const item = makeItemCard({ mediaType: 'photo', title: 'A quiet afternoon', isFavourite: false });
    const setFavourite = vi.fn(() => Promise.reject(new Error('SQLITE_BUSY')));
    const api = makeFakeApi({ setFavourite });
    const { user } = renderItem(item, api);

    const toggle = await screen.findByRole('button', { name: /mark as favourite/i });
    await user.click(toggle);

    expect(await screen.findByRole('button', { name: /mark as favourite/i })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('gives the toggle a real hit target (≥44px) — never a tiny icon-only click zone', async () => {
    const item = makeItemCard({ mediaType: 'photo', title: 'A quiet afternoon' });
    renderItem(item);

    const toggle = await screen.findByRole('button', { name: /mark as favourite/i });
    // jsdom has no real layout engine, so assert the Tailwind sizing classes that
    // fix the hit target at 44px (h-11 w-11 = 2.75rem = 44px) rather than measured
    // pixels — the same posture as the rest of this suite under jsdom.
    expect(toggle.className).toMatch(/\bh-11\b/);
    expect(toggle.className).toMatch(/\bw-11\b/);
  });
});

describe('ItemView — accessibility (WCAG 2.1 AA)', () => {
  it('the favourite toggle has no axe violations, unfavourited and favourited', async () => {
    const unfav = makeItemCard({ mediaType: 'photo', title: 'Not yet loved', isFavourite: false });
    const { container: c1 } = renderItem(unfav);
    await screen.findByRole('button', { name: /mark as favourite/i });
    await expectNoAxeViolations(c1);

    const fav = makeItemCard({ mediaType: 'photo', title: 'Already loved', isFavourite: true });
    const { container: c2 } = renderItem(fav);
    await screen.findByRole('button', { name: /remove from favourites/i });
    await expectNoAxeViolations(c2);
  });
});

describe('ItemView — accessibility (WCAG 2.1 AA)', () => {
  it('a finished transcript has no axe violations', async () => {
    const item = makeItemCard({ mediaType: 'audio', title: 'A calm story' });
    const api = makeFakeApi({
      getTranscript: vi.fn(() =>
        Promise.resolve(makeTranscriptView({ status: 'done', language: 'en', text: 'A calm story, told once.' })),
      ),
    });
    const { container } = renderItem(item, api);
    await screen.findByText(/a calm story, told once/i);
    await expectNoAxeViolations(container);
  });

  it('a pending/transcribing transcript has no axe violations', async () => {
    const item = makeItemCard({ mediaType: 'audio', title: 'A pending story' });
    const api = makeFakeApi({
      getTranscript: vi.fn(() => Promise.resolve(makeTranscriptView({ status: 'pending' }))),
      getTranscriptionStatus: vi.fn(() => Promise.resolve(runningStatus())),
    });
    const { container } = renderItem(item, api);
    await screen.findByText(/transcribing/i);
    await expectNoAxeViolations(container);
  });
});
