import type { ReactElement, ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ItemView } from '@renderer/views/ItemView';
import { KawsayApiProvider } from '@renderer/lib/kawsay-api';
import { useFavourite } from '@renderer/lib/use-favourite';
import { NavigationProvider, useNavigation } from '@renderer/lib/navigation';
import type { ItemCardDTO, TranscriptionSnapshotDTO } from '@shared/kawsay-api';
import { makeFakeApi, makeItemCard, makeTranscriptView } from './support/fake-api';
import type { FakeApi } from './support/fake-api';
import { ViewProbe, wrapInProviders } from './support/render';
import { expectNoAxeViolations } from './support/axe';

/**
 * Mirrors MainApp's id-keyed remount: a FRESH ItemView instance per memory id, so
 * arrowing between memories fully unmounts the previous one exactly as in the
 * running app (`MainApp.tsx` renders `<ItemView key={`item-${id}`}/>`). Rendering
 * `<ItemView/>` bare would keep ONE instance across navigation and mask the
 * remount-driven races this suite must reproduce.
 */
function KeyedItemViewHarness(): ReactElement {
  const { view } = useNavigation();
  if (view.name !== 'item') {
    return <div data-testid="active-view">{view.name}</div>;
  }
  return <ItemView key={`item-${view.item.id}`} />;
}

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
  it('shows the spoken words of a finished transcript, read-only alongside a never-autoplay player', async () => {
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
    // The words themselves stay read-only — no editor (R11 / AC-14 posture).
    expect(container.querySelector('textarea, input, [contenteditable="true"]')).toBeNull();
    // A voice note IS now playable — but only on explicit intent: the player is
    // present with controls and never autoplays (#428 / P6).
    const audio = container.querySelector('audio');
    expect(audio).not.toBeNull();
    expect(audio).toHaveAttribute('controls');
    expect(audio).not.toHaveAttribute('autoplay');
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
    // useFavourite reads its value/busy/sequence state from the navigation provider
    // (owned above ItemView's id-keyed remount), so the hook needs it in scope.
    const wrapper = ({ children }: { children: ReactNode }) => (
      <KawsayApiProvider api={api}>
        <NavigationProvider>{children}</NavigationProvider>
      </KawsayApiProvider>
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

  it('never settles a phantom favourite when two rapid toggles BOTH fail (#493)', async () => {
    // Disk truth: NOT a favourite. The user double-toggles (on → off) quickly, then BOTH
    // saves fail. The revert baseline must be the last SETTLED (disk) value, not the
    // optimistic in-flight value — otherwise the second failure reverts to the phantom
    // optimistic `true` the first toggle set, leaving a favourite that never touched disk.
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
      <KawsayApiProvider api={api}>
        <NavigationProvider>{children}</NavigationProvider>
      </KawsayApiProvider>
    );
    const { result } = renderHook(
      () => ({ fav: useFavourite(item.id, item.isFavourite), nav: useNavigation() }),
      { wrapper },
    );

    act(() => result.current.fav.toggle()); // favourite: true (optimistic)
    act(() => result.current.fav.toggle()); // favourite: false (optimistic, back to disk truth)
    expect(calls).toEqual([
      { id: item.id, favourite: true },
      { id: item.id, favourite: false },
    ]);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // Both saves FAIL, in order — disk never changed.
      await act(async () => {
        first.reject(new Error('SQLITE_BUSY'));
        await Promise.resolve();
      });
      await act(async () => {
        second.reject(new Error('SQLITE_BUSY'));
        await Promise.resolve();
      });

      // Settled truth is disk truth (false) — never a phantom `true` that was never saved.
      expect(result.current.fav.isFavourite).toBe(false);
      expect(result.current.nav.favouriteOverrides[item.id]).toBe(false);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('ItemView — favourite save is bounded + busy-clear gate (#489, #490)', () => {
  // Must match FAVOURITE_SAVE_TIMEOUT_MS in src/lib/use-favourite.ts. Kept local so
  // this stays a behavioural test (the exact bound is an implementation detail; the
  // contract is "a hung save recovers on its own within a bounded time").
  const SAVE_TIMEOUT_MS = 10_000;
  const SAVE_FAILURE_COPY = "We couldn't save that change just now. Nothing was lost.";

  function hookWrapper(api: FakeApi) {
    return function Wrapper({ children }: { children: ReactNode }) {
      return (
        <KawsayApiProvider api={api}>
          <NavigationProvider>{children}</NavigationProvider>
        </KawsayApiProvider>
      );
    };
  }

  it('bounds an in-flight save so a hung catalog:setFavourite never sticks the toggle disabled forever (#489)', async () => {
    vi.useFakeTimers();
    try {
      const item = makeItemCard({ mediaType: 'photo', title: 'A quiet afternoon', isFavourite: false });
      // A save that NEVER settles — the failure mode #489 guards against (e.g. main
      // process wedged on DB contention). Without a timeout the toggle stays disabled
      // for the rest of the session.
      const pending = deferred<{ isFavourite: boolean }>();
      const setFavourite = vi.fn(() => pending.promise);
      const api = makeFakeApi({ setFavourite });
      const { result } = renderHook(() => useFavourite(item.id, item.isFavourite), {
        wrapper: hookWrapper(api),
      });

      act(() => result.current.toggle());
      // Optimistic + busy while the (doomed) save is in flight.
      expect(result.current.isFavourite).toBe(true);
      expect(result.current.isSaving).toBe(true);

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        // The invoke never resolves; advancing past the bound must self-heal.
        await act(async () => {
          await vi.advanceTimersByTimeAsync(SAVE_TIMEOUT_MS);
        });

        // Recovered: reverted to the pre-toggle value, re-enabled, calm failure copy,
        // and the timeout took the same reverting path a rejected save does.
        expect(result.current.isSaving).toBe(false);
        expect(result.current.isFavourite).toBe(false);
        expect(result.current.announcement).toBe(SAVE_FAILURE_COPY);
        // The timeout took a reverting path (distinct message from a rejected save).
        expect(
          warnSpy.mock.calls.some((call) => String(call[0]).includes('timed out; reverting')),
        ).toBe(true);
      } finally {
        warnSpy.mockRestore();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('reconciles a slow save that actually lands AFTER the timeout, instead of leaving a lie (#489)', async () => {
    vi.useFakeTimers();
    try {
      // Start favourited on disk; un-favourite it. The write is merely SLOW (not
      // failed): we cross the timeout and assume failure, then the success lands.
      const item = makeItemCard({ mediaType: 'photo', title: 'A quiet afternoon', isFavourite: true });
      const pending = deferred<{ isFavourite: boolean }>();
      const setFavourite = vi.fn(() => pending.promise);
      const api = makeFakeApi({ setFavourite });
      const { result } = renderHook(() => useFavourite(item.id, item.isFavourite), {
        wrapper: hookWrapper(api),
      });

      act(() => result.current.toggle());
      expect(result.current.isFavourite).toBe(false); // optimistic un-favourite

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        // Timeout first: assume failure, revert to the pre-toggle value, show the notice.
        await act(async () => {
          await vi.advanceTimersByTimeAsync(SAVE_TIMEOUT_MS);
        });
        expect(result.current.isSaving).toBe(false);
        expect(result.current.isFavourite).toBe(true);
        expect(result.current.announcement).toBe(SAVE_FAILURE_COPY);

        // ...but the write ACTUALLY succeeded a moment later. The sequence gate must
        // reconcile the value to disk truth, and the mistaken failure notice is put
        // right — no lingering "couldn't save" over a change that did persist.
        await act(async () => {
          pending.resolve({ isFavourite: false });
          await Promise.resolve();
        });
        expect(result.current.isFavourite).toBe(false);
        expect(result.current.isSaving).toBe(false);
        expect(result.current.announcement).toBe('Removed from favourites.');
      } finally {
        warnSpy.mockRestore();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('reverts to disk truth known at settle time, not a stale baseline, when a timed-out save later commits and the retry fails (#493 F1)', async () => {
    vi.useFakeTimers();
    try {
      // Disk starts un-favourited. Favourite it (t1) with a SLOW save; it times out and
      // reverts. Retry (t2). Then t1's slow save actually COMMITS true, and t2 FAILS.
      // The revert must target disk truth as known at SETTLE time (true), not the value
      // frozen when t2 was clicked (false) — else a phantom un-favourite over a real save.
      const item = makeItemCard({ mediaType: 'photo', title: 'A quiet afternoon', isFavourite: false });
      const d1 = deferred<{ isFavourite: boolean }>();
      const d2 = deferred<{ isFavourite: boolean }>();
      const calls: Array<{ id: string; favourite: boolean }> = [];
      const setFavourite = vi.fn((input: { id: string; favourite: boolean }) => {
        calls.push(input);
        return calls.length === 1 ? d1.promise : d2.promise;
      });
      const api = makeFakeApi({ setFavourite });
      const { result } = renderHook(() => useFavourite(item.id, item.isFavourite), {
        wrapper: hookWrapper(api),
      });

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        act(() => result.current.toggle()); // t1 → favourite true (slow)
        expect(result.current.isFavourite).toBe(true);

        // t1 times out → assume failure, revert to false, re-enable.
        await act(async () => {
          await vi.advanceTimersByTimeAsync(SAVE_TIMEOUT_MS);
        });
        expect(result.current.isFavourite).toBe(false);

        act(() => result.current.toggle()); // t2 → favourite true again (pending)
        expect(result.current.isFavourite).toBe(true);

        // t1's slow save actually committed true (disk truth advances to true)...
        await act(async () => {
          d1.resolve({ isFavourite: true });
          await Promise.resolve();
        });
        // ...and the retry then fails, persisting nothing. Disk still holds true.
        await act(async () => {
          d2.reject(new Error('SQLITE_BUSY'));
          await Promise.resolve();
        });

        // Reverting to a baseline frozen at t2's click (false) would phantom-un-favourite
        // a memory that IS favourited on disk. Settle-time truth keeps it true.
        expect(result.current.isFavourite).toBe(true);
      } finally {
        warnSpy.mockRestore();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the toggle disabled until the NEWEST save settles, even when an older reply lands first (#490)', async () => {
    // Distinct from the out-of-order "drop entirely" test above: here the OLDER-sent
    // save resolves FIRST (in order) while the newer is still pending. The busy-clear
    // gate must keep the control disabled until the NEWEST attempt settles — an older
    // reply must not re-enable it mid-flight. (Hardcoding saving=false in that gate
    // leaves the value tests green but turns THIS one red.)
    const item = makeItemCard({ mediaType: 'photo', title: 'A quiet afternoon', isFavourite: false });
    const first = deferred<{ isFavourite: boolean }>();
    const second = deferred<{ isFavourite: boolean }>();
    const calls: Array<{ id: string; favourite: boolean }> = [];
    const setFavourite = vi.fn((input: { id: string; favourite: boolean }) => {
      calls.push(input);
      return calls.length === 1 ? first.promise : second.promise;
    });
    const api = makeFakeApi({ setFavourite });
    const { result } = renderHook(() => useFavourite(item.id, item.isFavourite), {
      wrapper: hookWrapper(api),
    });

    act(() => result.current.toggle()); // older: favourite true
    act(() => result.current.toggle()); // newer: favourite false
    expect(result.current.isSaving).toBe(true);

    // The OLDER-sent reply resolves FIRST while the newer is still in flight.
    await act(async () => {
      first.resolve({ isFavourite: true });
      await Promise.resolve();
    });
    // Still busy — the newer save has not settled.
    expect(result.current.isSaving).toBe(true);

    // Only the NEWEST settlement clears the busy flag and pins the last-sent value.
    await act(async () => {
      second.resolve({ isFavourite: false });
      await Promise.resolve();
    });
    expect(result.current.isSaving).toBe(false);
    expect(result.current.isFavourite).toBe(false);
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

    // At the START (first memory): no Previous, but Next is offered.
    const start = renderWithSiblings([a, b], a);
    await screen.findByRole('heading', { level: 1, name: /first memory/i });
    expect(screen.queryByRole('button', { name: /previous/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^next/i })).toBeInTheDocument();
    start.unmount();

    // At the END (last memory): Previous is offered, but no Next — the title's
    // second half, previously unasserted.
    renderWithSiblings([a, b], b);
    await screen.findByRole('heading', { level: 1, name: /second memory/i });
    expect(screen.getByRole('button', { name: /previous/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^next/i })).not.toBeInTheDocument();
  });

  it('does not trap focus — Tab still reaches a control outside the memory view', async () => {
    const a = makeItemCard({ mediaType: 'photo', title: 'First memory' });
    const b = makeItemCard({ mediaType: 'photo', title: 'Second memory' });
    const { user } = renderWithSiblings([a, b], a);

    await screen.findByRole('heading', { level: 1, name: /first memory/i });
    await user.keyboard('{ArrowRight}');
    await screen.findByRole('heading', { level: 1, name: /second memory/i });

    const outside = screen.getByRole('button', { name: /outside the memory view/i });
    // Drive REAL Tab traversal from wherever focus currently sits, rather than
    // jumping straight to the outside control with `.focus()` — a genuine focus
    // trap would leave `outside` unreached instead of merely "focusable".
    for (let i = 0; i < 20 && document.activeElement !== outside; i += 1) {
      await user.tab();
    }
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

describe('ItemView — ←/→ nav must not fight the user (#458 review fixes)', () => {
  it('does NOT navigate away while a text selection is active — the arrow stays with the selection', async () => {
    // A user selecting a sentence in the read-only transcript and pressing ← to
    // collapse it must not be teleported to the previous memory (losing their
    // selection). The global arrow handler defers to a live, non-collapsed
    // selection exactly as it defers to a focused input.
    const a = makeItemCard({ mediaType: 'audio', title: 'First memory' });
    const b = makeItemCard({ mediaType: 'audio', title: 'Second memory' });
    const api = makeFakeApi({
      getTranscript: vi.fn(() =>
        Promise.resolve(
          makeTranscriptView({ status: 'done', language: 'en', text: 'A sentence worth selecting.' }),
        ),
      ),
    });
    render(
      wrapInProviders(<ItemView />, api, {
        name: 'item',
        item: a,
        from: { name: 'timeline' },
        siblings: [a, b],
      }),
    );

    const transcript = await screen.findByText(/a sentence worth selecting/i);
    const range = document.createRange();
    range.selectNodeContents(transcript);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    expect(selection?.isCollapsed).toBe(false);

    // At index 0, ArrowRight WOULD move to the next memory if the guard were absent.
    fireEvent.keyDown(window, { key: 'ArrowRight' });

    expect(screen.getByRole('heading', { level: 1, name: /first memory/i })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1, name: /second memory/i })).not.toBeInTheDocument();
    // The selection was left intact — not discarded by a spurious navigation.
    expect(window.getSelection()?.isCollapsed).toBe(false);
  });

  it('ignores auto-repeat so holding an arrow does not fire a burst of remounts', async () => {
    const a = makeItemCard({ mediaType: 'photo', title: 'First memory' });
    const b = makeItemCard({ mediaType: 'photo', title: 'Second memory' });
    render(
      wrapInProviders(<ItemView />, makeFakeApi(), {
        name: 'item',
        item: a,
        from: { name: 'timeline' },
        siblings: [a, b],
      }),
    );

    await screen.findByRole('heading', { level: 1, name: /first memory/i });
    // An auto-repeated keydown (key held) must be a no-op.
    fireEvent.keyDown(window, { key: 'ArrowRight', repeat: true });

    expect(screen.getByRole('heading', { level: 1, name: /first memory/i })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1, name: /second memory/i })).not.toBeInTheDocument();
  });
});

describe('ItemView — ←/→ stands down for modifiers and focused controls (#491)', () => {
  function renderWithSiblingsAndControl(
    siblings: ItemCardDTO[],
    current: ItemCardDTO,
    api: FakeApi = makeFakeApi(),
  ) {
    const user = userEvent.setup();
    const result = render(
      wrapInProviders(
        <>
          <ItemView />
          <input aria-label="a focused text control" />
        </>,
        api,
        { name: 'item', item: current, from: { name: 'timeline' }, siblings },
      ),
    );
    return { api, user, ...result };
  }

  it('Shift+ArrowRight does not navigate — Shift+Arrow is reserved for extending a text selection', async () => {
    const a = makeItemCard({ mediaType: 'photo', title: 'First memory' });
    const b = makeItemCard({ mediaType: 'photo', title: 'Second memory' });
    renderWithSiblingsAndControl([a, b], a);

    await screen.findByRole('heading', { level: 1, name: /first memory/i });
    fireEvent.keyDown(window, { key: 'ArrowRight', shiftKey: true });

    expect(screen.getByRole('heading', { level: 1, name: /first memory/i })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1, name: /second memory/i })).not.toBeInTheDocument();
  });

  it('Shift+ArrowLeft does not navigate either', async () => {
    const a = makeItemCard({ mediaType: 'photo', title: 'First memory' });
    const b = makeItemCard({ mediaType: 'photo', title: 'Second memory' });
    renderWithSiblingsAndControl([a, b], b);

    await screen.findByRole('heading', { level: 1, name: /second memory/i });
    fireEvent.keyDown(window, { key: 'ArrowLeft', shiftKey: true });

    expect(screen.getByRole('heading', { level: 1, name: /second memory/i })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1, name: /first memory/i })).not.toBeInTheDocument();
  });

  it('Alt+ArrowRight does not navigate (an OS/browser history shortcut)', async () => {
    const a = makeItemCard({ mediaType: 'photo', title: 'First memory' });
    const b = makeItemCard({ mediaType: 'photo', title: 'Second memory' });
    renderWithSiblingsAndControl([a, b], a);

    await screen.findByRole('heading', { level: 1, name: /first memory/i });
    fireEvent.keyDown(window, { key: 'ArrowRight', altKey: true });

    expect(screen.getByRole('heading', { level: 1, name: /first memory/i })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1, name: /second memory/i })).not.toBeInTheDocument();
  });

  it('Ctrl+ArrowRight does not navigate', async () => {
    const a = makeItemCard({ mediaType: 'photo', title: 'First memory' });
    const b = makeItemCard({ mediaType: 'photo', title: 'Second memory' });
    renderWithSiblingsAndControl([a, b], a);

    await screen.findByRole('heading', { level: 1, name: /first memory/i });
    fireEvent.keyDown(window, { key: 'ArrowRight', ctrlKey: true });

    expect(screen.getByRole('heading', { level: 1, name: /first memory/i })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1, name: /second memory/i })).not.toBeInTheDocument();
  });

  it('Meta+ArrowRight does not navigate', async () => {
    const a = makeItemCard({ mediaType: 'photo', title: 'First memory' });
    const b = makeItemCard({ mediaType: 'photo', title: 'Second memory' });
    renderWithSiblingsAndControl([a, b], a);

    await screen.findByRole('heading', { level: 1, name: /first memory/i });
    fireEvent.keyDown(window, { key: 'ArrowRight', metaKey: true });

    expect(screen.getByRole('heading', { level: 1, name: /first memory/i })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1, name: /second memory/i })).not.toBeInTheDocument();
  });

  it('an arrow key fired from a focused text control does not navigate away from it', async () => {
    // A focused <input>/<textarea>/<select>/contentEditable owns Left/Right itself
    // (text-cursor movement) — the global listener must defer to it exactly as it
    // defers to a live text selection.
    const a = makeItemCard({ mediaType: 'photo', title: 'First memory' });
    const b = makeItemCard({ mediaType: 'photo', title: 'Second memory' });
    const { user } = renderWithSiblingsAndControl([a, b], b);

    await screen.findByRole('heading', { level: 1, name: /second memory/i });
    const control = screen.getByLabelText(/a focused text control/i);
    await user.click(control);
    fireEvent.keyDown(control, { key: 'ArrowLeft' });

    expect(screen.getByRole('heading', { level: 1, name: /second memory/i })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1, name: /first memory/i })).not.toBeInTheDocument();
  });
});

describe('ItemView — favourite survives arrow-nav within a session (#458 review fix)', () => {
  it('keeps a memory favourited when you arrow away and back — no stale-siblings revert', async () => {
    const a = makeItemCard({
      id: '00000000-0000-4000-8000-0000000000e1',
      mediaType: 'photo',
      title: 'First memory',
      isFavourite: false,
    });
    const b = makeItemCard({ mediaType: 'photo', title: 'Second memory', isFavourite: false });
    const favCalls: Array<{ id: string; favourite: boolean }> = [];
    const setFavourite = vi.fn((input: { id: string; favourite: boolean }) => {
      favCalls.push(input);
      return Promise.resolve({ isFavourite: input.favourite });
    });
    const api = makeFakeApi({ setFavourite });
    const user = userEvent.setup();
    render(
      wrapInProviders(<ItemView />, api, {
        name: 'item',
        item: a,
        from: { name: 'timeline' },
        siblings: [a, b],
      }),
    );

    await screen.findByRole('heading', { level: 1, name: /first memory/i });
    // Favourite the first memory and let the save settle.
    await user.click(screen.getByRole('button', { name: /mark as favourite/i }));
    await screen.findByRole('button', { name: /remove from favourites/i });

    // Arrow to the next memory, then back to the first.
    await user.keyboard('{ArrowRight}');
    await screen.findByRole('heading', { level: 1, name: /second memory/i });
    await user.keyboard('{ArrowLeft}');
    await screen.findByRole('heading', { level: 1, name: /first memory/i });

    // The heart must still read favourited — not reverted from a frozen snapshot.
    const toggle = await screen.findByRole('button', { name: /remove from favourites/i });
    expect(toggle).toHaveAttribute('aria-pressed', 'true');

    // And clicking now correctly UN-favourites (computes next=false), never re-favourites.
    await user.click(toggle);
    expect(favCalls[favCalls.length - 1]).toEqual({ id: a.id, favourite: false });
  });
});

describe('ItemView — favourite that SETTLES only after you arrowed away (before-settle race, #458)', () => {
  // Flush pending microtasks + the timer tick so a late settlement runs.
  async function flushPending(): Promise<void> {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  it('reflects a favourite whose save settles AFTER the id-keyed remount unmounted its ItemView', async () => {
    // The open race the siblings-patch alone does NOT close: the user toggles a
    // favourite on A, then arrows away BEFORE `catalog:setFavourite` settles. The
    // id-keyed remount unmounts ItemView-A, so a mount-guarded settlement drops the
    // reconciliation — the ordered snapshot threaded forward still carries A's
    // STALE pre-toggle flag. Arrow back to A and it wrongly reads un-favourited;
    // a "fix" click then INVERTS the real persisted value. The reconciliation must
    // target state that OUTLIVES the remount so the late settle still lands.
    const a = makeItemCard({
      id: '00000000-0000-4000-8000-0000000000d1',
      mediaType: 'photo',
      title: 'First memory',
      isFavourite: false,
    });
    const b = makeItemCard({
      id: '00000000-0000-4000-8000-0000000000d2',
      mediaType: 'photo',
      title: 'Second memory',
      isFavourite: false,
    });
    const pending = deferred<{ isFavourite: boolean }>();
    const favCalls: Array<{ id: string; favourite: boolean }> = [];
    const setFavourite = vi.fn((input: { id: string; favourite: boolean }) => {
      favCalls.push(input);
      // Only the FIRST save (favouriting A) is deferred; later saves settle at once.
      return favCalls.length === 1
        ? pending.promise
        : Promise.resolve({ isFavourite: input.favourite });
    });
    const api = makeFakeApi({ setFavourite });
    const user = userEvent.setup();
    render(
      wrapInProviders(<KeyedItemViewHarness />, api, {
        name: 'item',
        item: a,
        from: { name: 'timeline' },
        siblings: [a, b],
      }),
    );

    await screen.findByRole('heading', { level: 1, name: /first memory/i });
    // Toggle favourite on A but leave the save UNSETTLED.
    await user.click(screen.getByRole('button', { name: /mark as favourite/i }));
    expect(favCalls).toEqual([{ id: a.id, favourite: true }]);

    // Arrow to B BEFORE the save settles → ItemView-A unmounts (id-keyed remount).
    await user.keyboard('{ArrowRight}');
    await screen.findByRole('heading', { level: 1, name: /second memory/i });

    // NOW the deferred save settles — after ItemView-A is already gone.
    await act(async () => {
      pending.resolve({ isFavourite: true });
      await Promise.resolve();
    });
    await flushPending();

    // Arrow back to A.
    await user.keyboard('{ArrowLeft}');
    await screen.findByRole('heading', { level: 1, name: /first memory/i });

    // A must read FAVOURITED — the settle that resolved after we left still landed
    // on state that survived the remount.
    const toggle = await screen.findByRole('button', { name: /remove from favourites/i });
    expect(toggle).toHaveAttribute('aria-pressed', 'true');

    // And clicking now correctly UN-favourites (computes next=false) — never the
    // spurious re-favourite that would invert the real persisted value.
    await user.click(toggle);
    expect(favCalls[favCalls.length - 1]).toEqual({ id: a.id, favourite: false });
  });

  it('lands the late settle without a setState-on-unmounted React warning', async () => {
    // The reconciliation must run when ItemView-A has unmounted, but the DISPLAYED
    // toggle's own setState must stay mount-guarded (#453) — so no "state update on
    // an unmounted component" warning is emitted on the dead child.
    const a = makeItemCard({
      id: '00000000-0000-4000-8000-0000000000d3',
      mediaType: 'photo',
      title: 'First memory',
      isFavourite: false,
    });
    const b = makeItemCard({
      id: '00000000-0000-4000-8000-0000000000d4',
      mediaType: 'photo',
      title: 'Second memory',
      isFavourite: false,
    });
    const pending = deferred<{ isFavourite: boolean }>();
    let deferOnce = true;
    const setFavourite = vi.fn((input: { id: string; favourite: boolean }) => {
      if (deferOnce) {
        deferOnce = false;
        return pending.promise;
      }
      return Promise.resolve({ isFavourite: input.favourite });
    });
    const api = makeFakeApi({ setFavourite });
    const user = userEvent.setup();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      render(
        wrapInProviders(<KeyedItemViewHarness />, api, {
          name: 'item',
          item: a,
          from: { name: 'timeline' },
          siblings: [a, b],
        }),
      );

      await screen.findByRole('heading', { level: 1, name: /first memory/i });
      await user.click(screen.getByRole('button', { name: /mark as favourite/i }));
      await user.keyboard('{ArrowRight}');
      await screen.findByRole('heading', { level: 1, name: /second memory/i });

      await act(async () => {
        pending.resolve({ isFavourite: true });
        await Promise.resolve();
      });
      await flushPending();

      const unmountedWarns = errorSpy.mock.calls.filter((call) =>
        /unmounted component|update on an unmounted/i.test(String(call[0])),
      );
      expect(unmountedWarns).toEqual([]);
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe('ItemView — a save still IN FLIGHT survives the id-keyed remount (#458 residual race)', () => {
  // Flush pending microtasks + the timer tick so a late settlement runs.
  async function flushPending(): Promise<void> {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  it('keeps the in-flight favourite pressed AND busy after you arrow away and back BEFORE it settles — never a stale, re-clickable heart', async () => {
    // The residual race the before-settle patch does not close. The per-hook-instance
    // `saving`/sequence guards die with the ItemView that MainApp keys by item id, so:
    // toggle A (slow save in flight) → arrow to B and back to A BEFORE it settles →
    // the remounted A resets to the STALE open-time value with an ENABLED control.
    // A re-click there issues a SECOND, racing save that the older in-flight reply can
    // arrive after and clobber — inverting the persisted value. The in-flight state must
    // instead live ABOVE the remount so the reopened memory shows the pending favourite
    // and stays busy until the one save settles.
    const a = makeItemCard({
      id: '00000000-0000-4000-8000-0000000000c1',
      mediaType: 'photo',
      title: 'First memory',
      isFavourite: false,
    });
    const b = makeItemCard({
      id: '00000000-0000-4000-8000-0000000000c2',
      mediaType: 'photo',
      title: 'Second memory',
      isFavourite: false,
    });
    const pending = deferred<{ isFavourite: boolean }>();
    const favCalls: Array<{ id: string; favourite: boolean }> = [];
    const setFavourite = vi.fn((input: { id: string; favourite: boolean }) => {
      favCalls.push(input);
      // Only the first save (favouriting A) is deferred; keep it in flight across the round trip.
      return favCalls.length === 1 ? pending.promise : Promise.resolve({ isFavourite: input.favourite });
    });
    const api = makeFakeApi({ setFavourite });
    const user = userEvent.setup();
    render(
      wrapInProviders(<KeyedItemViewHarness />, api, {
        name: 'item',
        item: a,
        from: { name: 'timeline' },
        siblings: [a, b],
      }),
    );

    await screen.findByRole('heading', { level: 1, name: /first memory/i });
    // Favourite A, but leave the save UNSETTLED.
    await user.click(screen.getByRole('button', { name: /mark as favourite/i }));
    expect(favCalls).toEqual([{ id: a.id, favourite: true }]);

    // Arrow to B and back to A — all BEFORE the save settles (id-keyed remount of ItemView-A).
    await user.keyboard('{ArrowRight}');
    await screen.findByRole('heading', { level: 1, name: /second memory/i });
    await user.keyboard('{ArrowLeft}');
    await screen.findByRole('heading', { level: 1, name: /first memory/i });

    // The reopened A must reflect the in-flight favourite AND still be busy — never the
    // stale un-favourited value on an enabled control that a re-click could race.
    const toggle = await screen.findByRole('button', { name: /remove from favourites/i });
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(toggle).toBeDisabled();
    // The remount opened NO second racing save.
    expect(favCalls).toEqual([{ id: a.id, favourite: true }]);

    // Let the one save settle: the heart resolves to favourited and becomes interactive.
    await act(async () => {
      pending.resolve({ isFavourite: true });
      await Promise.resolve();
    });
    await flushPending();
    expect(favCalls).toEqual([{ id: a.id, favourite: true }]);
    const settled = screen.getByRole('button', { name: /remove from favourites/i });
    expect(settled).not.toBeDisabled();

    // And a click now correctly UN-favourites (computes next=false) — never a spurious
    // re-favourite that could invert the real persisted value.
    await user.click(settled);
    expect(favCalls[favCalls.length - 1]).toEqual({ id: a.id, favourite: false });
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

describe('ItemView — explicit-intent media playback (Journey F / #428)', () => {
  it('offers a never-autoplay audio player for a voice note memory', async () => {
    const item = makeItemCard({ mediaType: 'audio', title: 'A voice note' });
    const { container } = renderItem(item);
    await screen.findByRole('heading', { level: 1, name: /a voice note/i });

    const audio = container.querySelector('audio');
    expect(audio).not.toBeNull();
    expect(audio).toHaveAttribute('controls');
    expect(audio).not.toHaveAttribute('autoplay');
  });

  it('offers a never-autoplay video player for a video memory', async () => {
    const item = makeItemCard({ mediaType: 'video', title: 'A home movie' });
    const { container } = renderItem(item);
    await screen.findByRole('heading', { level: 1, name: /a home movie/i });

    const video = container.querySelector('video');
    expect(video).not.toBeNull();
    expect(video).toHaveAttribute('controls');
    expect(video).not.toHaveAttribute('autoplay');
  });

  it('opens a photo full-size, and shows no player for a still image', async () => {
    const item = makeItemCard({ mediaType: 'photo', title: 'Sunset over the bay' });
    const { container } = renderItem(item);
    await screen.findByRole('heading', { level: 1, name: /sunset over the bay/i });

    const full = container.querySelector('img[src^="kawsay-media:"]');
    expect(full).not.toBeNull();
    expect(container.querySelector('audio, video')).toBeNull();
  });

  it('stays axe-clean with a video player present', async () => {
    const item = makeItemCard({ mediaType: 'video', title: 'A quiet clip' });
    const { container } = renderItem(item);
    await screen.findByRole('heading', { level: 1, name: /a quiet clip/i });
    await expectNoAxeViolations(container);
  });
});
