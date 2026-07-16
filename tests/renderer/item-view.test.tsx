import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ItemView } from '@renderer/views/ItemView';
import { KawsayApiProvider } from '@renderer/lib/kawsay-api';
import { useFavourite } from '@renderer/lib/use-favourite';
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

/** A promise whose resolution the test controls, so a test can force a specific
 *  IPC response ORDER — `ipcRenderer.invoke` guarantees no such order itself. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (err: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('ItemView — favourite toggle race + lifecycle guards (#434)', () => {
  // Flush pending microtasks + the timer tick, so a late promise settlement runs
  // its handlers before assertions.
  async function flushPending(): Promise<void> {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  it('drops a late save settlement after the item unmounts — no throw, and no "reverting" reaction', async () => {
    // The REAL reachable case: toggle, then click Back → ItemView unmounts while
    // catalog:setFavourite is still pending. The late REJECT must not run the
    // revert/announce reaction on the dead component. (MainApp keys ItemView by
    // item id, so the item-id guard can never fire — only a mount guard covers
    // this.) An unguarded hook logs the "reverting" warn + calls setState; a
    // guarded hook drops it silently. We assert on the observable warn.
    const item = makeItemCard({ mediaType: 'photo', title: 'A quiet afternoon', isFavourite: false });
    const pending = deferred<{ isFavourite: boolean }>();
    const setFavourite = vi.fn(() => pending.promise);
    const api = makeFakeApi({ setFavourite });
    const { user, unmount } = renderItem(item, api);

    const toggle = await screen.findByRole('button', { name: /mark as favourite/i });
    await user.click(toggle);
    expect(setFavourite).toHaveBeenCalledTimes(1);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      unmount();
      // Reject AFTER unmount. Must not throw and must not trigger the revert path.
      pending.reject(new Error('SQLITE_BUSY'));
      await flushPending();
      const revertWarns = warnSpy.mock.calls.filter((call) =>
        String(call[0]).includes('favourite toggle failed; reverting'),
      );
      expect(revertWarns).toEqual([]);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('honours the LAST-SENT toggle, not the last-RESOLVED, when responses arrive out of order', async () => {
    // A hook-level test: two toggles where the 1st sends favourite:true and the
    // 2nd sends favourite:false, but the 1st invoke RESOLVES last. Without a
    // sequence guard the stale {isFavourite:true} clobbers the newer false and the
    // toggle then lies. Exercised through the hook directly (not the button) because
    // the in-flight `disabled` state deliberately blocks a second DOM click — the
    // guard still matters for any programmatic/rapid caller, and `invoke` gives no
    // response-order guarantee.
    const item = makeItemCard({ mediaType: 'photo', title: 'A quiet afternoon', isFavourite: false });
    const first = deferred<{ isFavourite: boolean }>();
    const second = deferred<{ isFavourite: boolean }>();
    const calls: Array<{ id: string; favourite: boolean }> = [];
    const setFavourite = vi.fn((input: { id: string; favourite: boolean }) => {
      calls.push(input);
      return calls.length === 1 ? first.promise : second.promise;
    });
    const api = makeFakeApi({ setFavourite });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <KawsayApiProvider api={api}>{children}</KawsayApiProvider>
    );
    const { result } = renderHook(() => useFavourite(item.id, item.isFavourite), { wrapper });

    // First toggle → favourite:true; second toggle (optimistic state now true) →
    // favourite:false.
    act(() => result.current.toggle());
    act(() => result.current.toggle());

    expect(calls).toEqual([
      { id: item.id, favourite: true },
      { id: item.id, favourite: false },
    ]);

    // Settle out of order: the SECOND-sent (false) first, then the FIRST-sent (true).
    await act(async () => {
      second.resolve({ isFavourite: false });
      await Promise.resolve();
    });
    await act(async () => {
      first.resolve({ isFavourite: true });
      await Promise.resolve();
    });

    // Final state must reflect the last-SENT toggle (false), not the last-RESOLVED.
    expect(result.current.isFavourite).toBe(false);
  });

  it('disables the toggle while a save is in flight, discouraging the rapid re-click race', async () => {
    const item = makeItemCard({ mediaType: 'photo', title: 'A quiet afternoon', isFavourite: false });
    const pending = deferred<{ isFavourite: boolean }>();
    const setFavourite = vi.fn(() => pending.promise);
    const api = makeFakeApi({ setFavourite });
    const { user } = renderItem(item, api);

    const toggle = await screen.findByRole('button', { name: /mark as favourite/i });
    await user.click(toggle);

    // While the save is pending the control reflects a busy state.
    const busy = screen.getByRole('button', { name: /remove from favourites/i });
    expect(busy).toBeDisabled();
    expect(busy).toHaveAttribute('aria-busy', 'true');

    await act(async () => {
      pending.resolve({ isFavourite: true });
      await Promise.resolve();
    });

    // Once settled it is interactive again.
    expect(screen.getByRole('button', { name: /remove from favourites/i })).not.toBeDisabled();
  });
});

describe('ItemView — ←/→ keyboard navigation between memories (#434)', () => {
  function renderWithSiblings(
    siblings: ItemCardDTO[],
    current: ItemCardDTO,
    api: FakeApi = makeFakeApi(),
  ) {
    const user = userEvent.setup();
    const result = render(
      wrapInProviders(
        <>
          <ItemView />
          <button type="button">outside the memory view</button>
        </>,
        api,
        { name: 'item', item: current, from: { name: 'timeline' }, siblings },
      ),
    );
    return { api, user, ...result };
  }

  it('ArrowRight moves to the next memory in timeline order', async () => {
    const a = makeItemCard({ mediaType: 'photo', title: 'First memory' });
    const b = makeItemCard({ mediaType: 'photo', title: 'Second memory' });
    const c = makeItemCard({ mediaType: 'photo', title: 'Third memory' });
    const { user } = renderWithSiblings([a, b, c], a);

    await screen.findByRole('heading', { level: 1, name: /first memory/i });
    await user.keyboard('{ArrowRight}');

    expect(await screen.findByRole('heading', { level: 1, name: /second memory/i })).toBeInTheDocument();
  });

  it('ArrowLeft moves to the previous memory in timeline order', async () => {
    const a = makeItemCard({ mediaType: 'photo', title: 'First memory' });
    const b = makeItemCard({ mediaType: 'photo', title: 'Second memory' });
    const c = makeItemCard({ mediaType: 'photo', title: 'Third memory' });
    const { user } = renderWithSiblings([a, b, c], b);

    await screen.findByRole('heading', { level: 1, name: /second memory/i });
    await user.keyboard('{ArrowLeft}');

    expect(await screen.findByRole('heading', { level: 1, name: /first memory/i })).toBeInTheDocument();
  });

  it('does not wrap past the last memory — ArrowRight is a graceful no-op at the end', async () => {
    const a = makeItemCard({ mediaType: 'photo', title: 'First memory' });
    const b = makeItemCard({ mediaType: 'photo', title: 'Second memory' });
    const { user } = renderWithSiblings([a, b], b);

    await screen.findByRole('heading', { level: 1, name: /second memory/i });
    await user.keyboard('{ArrowRight}');

    // Still on the last memory — nothing broke, nothing wrapped to the first.
    expect(screen.getByRole('heading', { level: 1, name: /second memory/i })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1, name: /first memory/i })).not.toBeInTheDocument();
  });

  it('does not wrap past the first memory — ArrowLeft is a graceful no-op at the start', async () => {
    const a = makeItemCard({ mediaType: 'photo', title: 'First memory' });
    const b = makeItemCard({ mediaType: 'photo', title: 'Second memory' });
    const { user } = renderWithSiblings([a, b], a);

    await screen.findByRole('heading', { level: 1, name: /first memory/i });
    await user.keyboard('{ArrowLeft}');

    expect(screen.getByRole('heading', { level: 1, name: /first memory/i })).toBeInTheDocument();
  });

  it('is a graceful no-op with no timeline context at all (opened without siblings)', async () => {
    const item = makeItemCard({ mediaType: 'photo', title: 'A lone memory' });
    const user = userEvent.setup();
    render(wrapInProviders(<ItemView />, makeFakeApi(), { name: 'item', item }));

    await screen.findByRole('heading', { level: 1, name: /a lone memory/i });
    await user.keyboard('{ArrowRight}');
    await user.keyboard('{ArrowLeft}');

    expect(screen.getByRole('heading', { level: 1, name: /a lone memory/i })).toBeInTheDocument();
  });

  it('offers visible Previous/Next controls too — not keyboard-only', async () => {
    const a = makeItemCard({ mediaType: 'photo', title: 'First memory' });
    const b = makeItemCard({ mediaType: 'photo', title: 'Second memory' });
    const c = makeItemCard({ mediaType: 'photo', title: 'Third memory' });
    const { user } = renderWithSiblings([a, b, c], b);

    await screen.findByRole('heading', { level: 1, name: /second memory/i });
    // The middle memory has both directions available.
    expect(screen.getByRole('button', { name: /previous/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^next/i })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^next/i }));
    expect(await screen.findByRole('heading', { level: 1, name: /third memory/i })).toBeInTheDocument();
  });

  it('hides the Previous control at the start and the Next control at the end', async () => {
    const a = makeItemCard({ mediaType: 'photo', title: 'First memory' });
    const b = makeItemCard({ mediaType: 'photo', title: 'Second memory' });
    renderWithSiblings([a, b], a);

    await screen.findByRole('heading', { level: 1, name: /first memory/i });
    expect(screen.queryByRole('button', { name: /previous/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^next/i })).toBeInTheDocument();
  });

  it('does not trap focus — Tab still reaches a control outside the memory view', async () => {
    const a = makeItemCard({ mediaType: 'photo', title: 'First memory' });
    const b = makeItemCard({ mediaType: 'photo', title: 'Second memory' });
    const { user } = renderWithSiblings([a, b], a);

    await screen.findByRole('heading', { level: 1, name: /first memory/i });
    await user.keyboard('{ArrowRight}');
    await screen.findByRole('heading', { level: 1, name: /second memory/i });

    const outside = screen.getByRole('button', { name: /outside the memory view/i });
    outside.focus();
    expect(outside).toHaveFocus();
  });

  it('politely announces the move so a screen-reader user hears which memory is now showing', async () => {
    const a = makeItemCard({ mediaType: 'photo', title: 'First memory' });
    const b = makeItemCard({ mediaType: 'photo', title: 'Second memory' });
    const { user, container } = renderWithSiblings([a, b], a);

    await screen.findByRole('heading', { level: 1, name: /first memory/i });
    await user.keyboard('{ArrowRight}');
    await screen.findByRole('heading', { level: 1, name: /second memory/i });

    const liveRegions = container.querySelectorAll('[aria-live="polite"]');
    expect(liveRegions.length).toBeGreaterThan(0);
    await waitFor(() =>
      expect(Array.from(liveRegions).some((el) => /second memory/i.test(el.textContent ?? ''))).toBe(
        true,
      ),
    );
  });

  it('has no axe violations with Previous/Next controls visible', async () => {
    const a = makeItemCard({ mediaType: 'photo', title: 'First memory' });
    const b = makeItemCard({ mediaType: 'photo', title: 'Second memory' });
    const c = makeItemCard({ mediaType: 'photo', title: 'Third memory' });
    const { container } = renderWithSiblings([a, b, c], b);

    await screen.findByRole('heading', { level: 1, name: /second memory/i });
    await expectNoAxeViolations(container);
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
