// Direct hook tests for `useSuggestions` — the renderer-side read/act layer for
// the SUGGESTED-COLLECTIONS review tray. These pin the per-action generation
// guard that keeps a stale/superseded curation outcome from lying to the user:
// a rejection that lands AFTER a newer action already succeeded, or AFTER the
// feature was toggled off, must be IGNORED — it must never re-flag the calm
// "couldn't save" hint (the spurious-notice race, #407). The happy paths — a
// single failed action still surfaces the hint, and a later success still
// clears it — must keep working unchanged.
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { SuggestionsViewDTO } from '@shared/kawsay-api';
import { KawsayApiProvider } from '@renderer/lib/kawsay-api';
import { useSuggestions } from '@renderer/lib/use-suggestions';
import { makeFakeApi, makeSuggestion, makeSuggestionsView } from './support/fake-api';
import type { FakeApi } from './support/fake-api';

const CATEGORY = '20000000-0000-4000-8000-000000000001';

function wrapper(api: FakeApi) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <KawsayApiProvider api={api}>{children}</KawsayApiProvider>;
  };
}

/** A hand-rolled deferred so a test can settle a promise on demand. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: Error) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A one-suggestion tray so the hook has something real to curate. */
function oneSuggestionView(): SuggestionsViewDTO {
  return makeSuggestionsView({ suggestions: [makeSuggestion({ categoryId: CATEGORY })] });
}

describe('useSuggestions — per-action generation guard on the error notice (#407)', () => {
  it('does NOT set actionError when a superseded action rejects after a newer action succeeded', async () => {
    const acceptPending = deferred<SuggestionsViewDTO>();
    const dismissPending = deferred<SuggestionsViewDTO>();
    const api = makeFakeApi({
      listSuggestions: vi.fn(() => Promise.resolve(oneSuggestionView())),
      acceptSuggestion: vi.fn(() => acceptPending.promise),
      dismissSuggestion: vi.fn(() => dismissPending.promise),
    });
    const { result } = renderHook(() => useSuggestions(true), { wrapper: wrapper(api) });
    await waitFor(() => expect(result.current.suggestions.length).toBeGreaterThan(0));

    // Two curation actions are in flight at once (the tray does not disable other
    // cards): accept starts first, then dismiss supersedes it.
    act(() => result.current.accept({ categoryId: CATEGORY }));
    act(() => result.current.dismiss({ categoryId: CATEGORY }));

    // The newer action resolves successfully first — the tray is caught up, the
    // notice stays clear.
    await act(async () => {
      dismissPending.resolve(makeSuggestionsView());
    });
    expect(result.current.actionError).toBe(false);

    // The older, superseded action THEN rejects — its stale outcome must be
    // dropped, never resurfacing a spurious "couldn't save" hint.
    await act(async () => {
      acceptPending.reject(new Error('stale rejection'));
    });

    expect(result.current.actionError).toBe(false);
  });

  it('does NOT set actionError when a rejection arrives after the feature was disabled', async () => {
    const acceptPending = deferred<SuggestionsViewDTO>();
    const api = makeFakeApi({
      listSuggestions: vi.fn(() => Promise.resolve(oneSuggestionView())),
      acceptSuggestion: vi.fn(() => acceptPending.promise),
    });
    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useSuggestions(enabled),
      { wrapper: wrapper(api), initialProps: { enabled: true } },
    );
    await waitFor(() => expect(result.current.suggestions.length).toBeGreaterThan(0));

    // An accept is in flight when the user toggles the feature off.
    act(() => result.current.accept({ categoryId: CATEGORY }));
    rerender({ enabled: false });

    // The post-disable rejection must be ignored — the disabled tray never shows
    // a lingering error hint.
    await act(async () => {
      acceptPending.reject(new Error('post-disable rejection'));
    });

    expect(result.current.actionError).toBe(false);
  });

  it('still surfaces actionError for a normal single failed action', async () => {
    const api = makeFakeApi({
      listSuggestions: vi.fn(() => Promise.resolve(oneSuggestionView())),
      acceptSuggestion: vi.fn(() => Promise.reject(new Error('boom'))),
    });
    const { result } = renderHook(() => useSuggestions(true), { wrapper: wrapper(api) });
    await waitFor(() => expect(result.current.suggestions.length).toBeGreaterThan(0));

    await act(async () => {
      result.current.accept({ categoryId: CATEGORY });
    });

    await waitFor(() => expect(result.current.actionError).toBe(true));
  });

  it('clears actionError when a later action succeeds', async () => {
    const api = makeFakeApi({
      listSuggestions: vi.fn(() => Promise.resolve(oneSuggestionView())),
      acceptSuggestion: vi.fn(() => Promise.reject(new Error('boom'))),
      dismissSuggestion: vi.fn(() => Promise.resolve(makeSuggestionsView())),
    });
    const { result } = renderHook(() => useSuggestions(true), { wrapper: wrapper(api) });
    await waitFor(() => expect(result.current.suggestions.length).toBeGreaterThan(0));

    await act(async () => {
      result.current.accept({ categoryId: CATEGORY });
    });
    await waitFor(() => expect(result.current.actionError).toBe(true));

    await act(async () => {
      result.current.dismiss({ categoryId: CATEGORY });
    });
    await waitFor(() => expect(result.current.actionError).toBe(false));
  });

  it('keeps actionError up CONTINUOUSLY while a retry is pending (clears only on committed success)', async () => {
    const retryPending = deferred<SuggestionsViewDTO>();
    const api = makeFakeApi({
      listSuggestions: vi.fn(() => Promise.resolve(oneSuggestionView())),
      // First attempt fails; the retry stays in flight until we resolve it.
      acceptSuggestion: vi
        .fn<() => Promise<SuggestionsViewDTO>>()
        .mockRejectedValueOnce(new Error('boom'))
        .mockReturnValueOnce(retryPending.promise),
    });
    const { result } = renderHook(() => useSuggestions(true), { wrapper: wrapper(api) });
    await waitFor(() => expect(result.current.suggestions.length).toBeGreaterThan(0));

    // The first attempt fails and raises the calm "couldn't save" hint.
    await act(async () => {
      result.current.accept({ categoryId: CATEGORY });
    });
    await waitFor(() => expect(result.current.actionError).toBe(true));

    // A retry starts but has NOT settled yet. The hint must stay up throughout —
    // nothing on disk changed and the retry has not yet succeeded, so blinking the
    // banner off mid-retry would be a spurious reassurance (a bereavement-app
    // regression). It clears ONLY when the retry actually commits a success.
    act(() => result.current.accept({ categoryId: CATEGORY }));
    expect(result.current.actionError).toBe(true);

    await act(async () => {
      retryPending.resolve(makeSuggestionsView());
    });
    expect(result.current.actionError).toBe(false);
  });
});
