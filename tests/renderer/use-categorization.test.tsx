// Direct hook tests for `useItemCategories` — the renderer-side read/act layer
// for the opt-in categorization surface. These pin the guard rails that keep a
// correction from lying to the user:
//   (a) a correction result that arrives AFTER the hook switched items (or
//       unmounted) must be IGNORED — it must not mutate the now-current item's
//       categories or error state (fixes the "item A's chips flash on item B"
//       stale-closure regression, #346 a).
//   (b) a rejected correction must SURFACE an accessible, retryable failure
//       state rather than being silently swallowed (fixes the "no feedback that
//       a preservation correction was not saved" regression, #346 b).
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { CategorizationCorrectionDTO, ItemCategoryDTO } from '@shared/kawsay-api';
import { KawsayApiProvider } from '@renderer/lib/kawsay-api';
import { useItemCategories } from '@renderer/lib/use-categorization';
import { makeFakeApi, makeItemCategory } from './support/fake-api';
import type { FakeApi } from './support/fake-api';

const ITEM_A = '00000000-0000-4000-8000-0000000000a1';
const ITEM_B = '00000000-0000-4000-8000-0000000000b2';
const CATEGORY_ID = '10000000-0000-4000-8000-000000000001';

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

const CONFIRM: CategorizationCorrectionDTO = {
  kind: 'confirm',
  itemId: ITEM_A,
  categoryId: CATEGORY_ID,
};

const REMOVE: CategorizationCorrectionDTO = {
  kind: 'remove',
  itemId: ITEM_A,
  categoryId: CATEGORY_ID,
};

describe('useItemCategories — staleness guard on applyCorrection (#346 a)', () => {
  it("ignores a correction result that resolves AFTER the hook switched items — item B's chips never show item A's returned list", async () => {
    // Item A's initial chips; item B's initial chips are a distinct set so a
    // stale write would be visibly wrong.
    const itemALive = makeItemCategory({ categoryId: CATEGORY_ID, name: 'Cusco, Perú' });
    const itemBLive = makeItemCategory({
      categoryId: '10000000-0000-4000-8000-000000000002',
      name: 'Lima, Perú',
    });
    // The correction resolution the network is about to hand back for item A —
    // if the guard is missing, this would clobber item B's chips.
    const stalePostSwitchRefresh: ItemCategoryDTO[] = [
      makeItemCategory({ categoryId: CATEGORY_ID, name: 'GHOST — stale item A result' }),
    ];

    const listItemCategories = vi.fn((input: { itemId: string }) =>
      Promise.resolve(input.itemId === ITEM_A ? [itemALive] : [itemBLive]),
    );
    const pending = deferred<ItemCategoryDTO[]>();
    const applyCategoryCorrection = vi.fn(() => pending.promise);
    const api = makeFakeApi({ listItemCategories, applyCategoryCorrection });

    const { result, rerender } = renderHook(
      ({ itemId }: { itemId: string }) => useItemCategories(itemId, true),
      { wrapper: wrapper(api), initialProps: { itemId: ITEM_A } },
    );

    await waitFor(() => expect(result.current.categories).toEqual([itemALive]));

    // Fire the correction on item A; it does not resolve yet.
    act(() => result.current.applyCorrection(CONFIRM));
    expect(applyCategoryCorrection).toHaveBeenCalledWith(CONFIRM);

    // The user navigates to item B before the local IPC resolves; item B's
    // chips load in and the hook now shows item B.
    rerender({ itemId: ITEM_B });
    await waitFor(() => expect(result.current.categories).toEqual([itemBLive]));

    // NOW item A's in-flight correction finally resolves.
    await act(async () => {
      pending.resolve(stalePostSwitchRefresh);
      await pending.promise;
    });

    // Item B's chips MUST be untouched — the stale result belongs to a memory
    // the user is no longer looking at.
    expect(result.current.categories).toEqual([itemBLive]);
    expect(result.current.categories).not.toEqual(stalePostSwitchRefresh);
    // And the guard must not have surfaced a failure banner on item B either.
    expect(result.current.correctionError).toBeNull();
  });

  it('ignores a correction REJECTION that arrives after the hook switched items — no failure banner leaks onto item B', async () => {
    const itemALive = makeItemCategory({ categoryId: CATEGORY_ID, name: 'Cusco, Perú' });
    const itemBLive = makeItemCategory({
      categoryId: '10000000-0000-4000-8000-000000000002',
      name: 'Lima, Perú',
    });

    const listItemCategories = vi.fn((input: { itemId: string }) =>
      Promise.resolve(input.itemId === ITEM_A ? [itemALive] : [itemBLive]),
    );
    const pending = deferred<ItemCategoryDTO[]>();
    const applyCategoryCorrection = vi.fn(() => pending.promise);
    const api = makeFakeApi({ listItemCategories, applyCategoryCorrection });

    const { result, rerender } = renderHook(
      ({ itemId }: { itemId: string }) => useItemCategories(itemId, true),
      { wrapper: wrapper(api), initialProps: { itemId: ITEM_A } },
    );

    await waitFor(() => expect(result.current.categories).toEqual([itemALive]));
    act(() => result.current.applyCorrection(CONFIRM));

    rerender({ itemId: ITEM_B });
    await waitFor(() => expect(result.current.categories).toEqual([itemBLive]));

    await act(async () => {
      pending.reject(new Error('DB busy'));
      await pending.promise.catch(() => undefined);
    });

    // Item B must remain calm — no error state from a rejection that belongs
    // to the previous item.
    expect(result.current.correctionError).toBeNull();
    expect(result.current.categories).toEqual([itemBLive]);
  });
});

describe('useItemCategories — surfaces a retryable failure instead of swallowing it (#346 b)', () => {
  it('exposes a calm, non-technical correctionError message when applyCategoryCorrection rejects', async () => {
    const initial = makeItemCategory({ categoryId: CATEGORY_ID, name: 'Cusco, Perú' });
    const applyCategoryCorrection = vi.fn(() => Promise.reject(new Error('DB locked')));
    const api = makeFakeApi({
      listItemCategories: vi.fn(() => Promise.resolve([initial])),
      applyCategoryCorrection,
    });

    const { result } = renderHook(() => useItemCategories(ITEM_A, true), { wrapper: wrapper(api) });
    await waitFor(() => expect(result.current.categories).toEqual([initial]));
    expect(result.current.correctionError).toBeNull();

    await act(async () => {
      result.current.applyCorrection(CONFIRM);
      // Let the rejected microtask flush.
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current.correctionError).not.toBeNull());
    // Non-technical, calm copy — never leaks raw error codes or "undefined".
    expect(result.current.correctionError?.message).toMatch(/couldn'?t save|try again/i);
    expect(result.current.correctionError?.message).not.toMatch(/DB locked|undefined|Error:/);
    // The visible chips are left untouched (nothing on disk changed).
    expect(result.current.categories).toEqual([initial]);
  });

  it('retryCorrection re-attempts the same correction and clears the error on success', async () => {
    const initial = makeItemCategory({ categoryId: CATEGORY_ID, name: 'Cusco, Perú' });
    const refreshed = [
      makeItemCategory({
        categoryId: CATEGORY_ID,
        name: 'Cusco, Perú',
        source: 'user',
        confidence: null,
      }),
    ];
    const applyCategoryCorrection = vi
      .fn<(input: CategorizationCorrectionDTO) => Promise<ItemCategoryDTO[]>>()
      .mockRejectedValueOnce(new Error('DB busy'))
      .mockResolvedValueOnce(refreshed);
    const api = makeFakeApi({
      listItemCategories: vi.fn(() => Promise.resolve([initial])),
      applyCategoryCorrection,
    });

    const { result } = renderHook(() => useItemCategories(ITEM_A, true), { wrapper: wrapper(api) });
    await waitFor(() => expect(result.current.categories).toEqual([initial]));

    await act(async () => {
      result.current.applyCorrection(CONFIRM);
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.correctionError).not.toBeNull());

    await act(async () => {
      result.current.retryCorrection();
      await Promise.resolve();
      await Promise.resolve();
    });

    // Retry replayed the SAME correction (not a synthetic no-op).
    expect(applyCategoryCorrection).toHaveBeenCalledTimes(2);
    expect(applyCategoryCorrection).toHaveBeenNthCalledWith(2, CONFIRM);
    await waitFor(() => expect(result.current.correctionError).toBeNull());
    // And the successful retry refreshed the chips from the returned list.
    expect(result.current.categories).toEqual(refreshed);
  });

  it('clears any surfaced correctionError when the user navigates to a different item', async () => {
    const applyCategoryCorrection = vi.fn(() => Promise.reject(new Error('DB busy')));
    const api = makeFakeApi({
      listItemCategories: vi.fn((input: { itemId: string }) =>
        Promise.resolve([makeItemCategory({ categoryId: CATEGORY_ID, name: input.itemId })]),
      ),
      applyCategoryCorrection,
    });

    const { result, rerender } = renderHook(
      ({ itemId }: { itemId: string }) => useItemCategories(itemId, true),
      { wrapper: wrapper(api), initialProps: { itemId: ITEM_A } },
    );
    await waitFor(() => expect(result.current.categories.length).toBe(1));

    await act(async () => {
      result.current.applyCorrection(CONFIRM);
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.correctionError).not.toBeNull());

    // Switching item drops the error — the banner belonged to a memory the
    // user is no longer looking at.
    rerender({ itemId: ITEM_B });
    await waitFor(() => expect(result.current.correctionError).toBeNull());
  });
});

describe('useItemCategories — concurrent-correction retry survives a sibling success (#360)', () => {
  it('retryCorrection re-fires the most recent correction even if an earlier sibling correction resolved first', async () => {
    // Two corrections fire on the same item before the first resolves — a
    // realistic double-click race the surrounding DB-busy failure path
    // widens. Correction A resolves successfully; correction B (still in
    // flight) then rejects. The user is shown the retryable banner for B,
    // and clicking "Try again" MUST replay B — not silently no-op.
    const initial = makeItemCategory({ categoryId: CATEGORY_ID, name: 'Cusco, Perú' });
    const refreshedAfterA: ItemCategoryDTO[] = [
      makeItemCategory({
        categoryId: CATEGORY_ID,
        name: 'Cusco, Perú',
        source: 'user',
        confidence: null,
      }),
    ];
    const refreshedAfterRetry: ItemCategoryDTO[] = [
      makeItemCategory({ categoryId: CATEGORY_ID, name: 'Cusco, Perú (removed)' }),
    ];

    const pendingA = deferred<ItemCategoryDTO[]>();
    const pendingB = deferred<ItemCategoryDTO[]>();
    const applyCategoryCorrection = vi
      .fn<(input: CategorizationCorrectionDTO) => Promise<ItemCategoryDTO[]>>()
      // First call = correction A (will succeed).
      .mockImplementationOnce(() => pendingA.promise)
      // Second call = correction B (will reject).
      .mockImplementationOnce(() => pendingB.promise)
      // Third call = the retry (will succeed) — proves the retry was re-fired.
      .mockImplementationOnce(() => Promise.resolve(refreshedAfterRetry));
    const api = makeFakeApi({
      listItemCategories: vi.fn(() => Promise.resolve([initial])),
      applyCategoryCorrection,
    });

    const { result } = renderHook(() => useItemCategories(ITEM_A, true), { wrapper: wrapper(api) });
    await waitFor(() => expect(result.current.categories).toEqual([initial]));

    // Fire A, then B — both in flight against the same item.
    act(() => result.current.applyCorrection(CONFIRM));
    act(() => result.current.applyCorrection(REMOVE));
    expect(applyCategoryCorrection).toHaveBeenCalledTimes(2);
    expect(applyCategoryCorrection).toHaveBeenNthCalledWith(1, CONFIRM);
    expect(applyCategoryCorrection).toHaveBeenNthCalledWith(2, REMOVE);

    // Resolve A first — successfully. The buggy code path clears the retry
    // target here; the fixed path leaves it pointing at B.
    await act(async () => {
      pendingA.resolve(refreshedAfterA);
      await pendingA.promise;
    });
    expect(result.current.correctionError).toBeNull();

    // Now B rejects — the banner + "Try again" become available.
    await act(async () => {
      pendingB.reject(new Error('DB busy'));
      await pendingB.promise.catch(() => undefined);
    });
    await waitFor(() => expect(result.current.correctionError).not.toBeNull());

    // Click "Try again" — this MUST re-fire the last correction (B), not no-op.
    await act(async () => {
      result.current.retryCorrection();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(applyCategoryCorrection).toHaveBeenCalledTimes(3);
    expect(applyCategoryCorrection).toHaveBeenNthCalledWith(3, REMOVE);
    await waitFor(() => expect(result.current.correctionError).toBeNull());
    expect(result.current.categories).toEqual(refreshedAfterRetry);
  });
});

describe('useItemCategories — supersedes a stale rejection after a later success (#383)', () => {
  it('drops a rejection from correction A when a later correction B on the same item already resolved successfully — no spurious banner, no redundant replay', async () => {
    // Symmetric residual of #360: two corrections A then B are in flight on
    // the SAME item. B (the later) resolves successfully and applies state,
    // THEN A (the earlier) rejects. On-disk + displayed state already reflect
    // the user's latest intent (B), so A's late rejection MUST be dropped —
    // otherwise a spurious retryable banner appears and any auto/user retry
    // would redundantly re-apply the already-successful B.
    const initial = makeItemCategory({ categoryId: CATEGORY_ID, name: 'Cusco, Perú' });
    const refreshedAfterB: ItemCategoryDTO[] = [
      makeItemCategory({
        categoryId: CATEGORY_ID,
        name: 'Cusco, Perú',
        source: 'user',
        confidence: null,
      }),
    ];

    const pendingA = deferred<ItemCategoryDTO[]>();
    const pendingB = deferred<ItemCategoryDTO[]>();
    const applyCategoryCorrection = vi
      .fn<(input: CategorizationCorrectionDTO) => Promise<ItemCategoryDTO[]>>()
      // First call = correction A (will reject LATE, after B has succeeded).
      .mockImplementationOnce(() => pendingA.promise)
      // Second call = correction B (will succeed FIRST).
      .mockImplementationOnce(() => pendingB.promise);
    const api = makeFakeApi({
      listItemCategories: vi.fn(() => Promise.resolve([initial])),
      applyCategoryCorrection,
    });

    const { result } = renderHook(() => useItemCategories(ITEM_A, true), { wrapper: wrapper(api) });
    await waitFor(() => expect(result.current.categories).toEqual([initial]));

    // Fire A, then B — both in flight against the same item.
    act(() => result.current.applyCorrection(CONFIRM));
    act(() => result.current.applyCorrection(REMOVE));
    expect(applyCategoryCorrection).toHaveBeenCalledTimes(2);
    expect(applyCategoryCorrection).toHaveBeenNthCalledWith(1, CONFIRM);
    expect(applyCategoryCorrection).toHaveBeenNthCalledWith(2, REMOVE);

    // Resolve B first — successfully. State reflects the user's latest intent.
    await act(async () => {
      pendingB.resolve(refreshedAfterB);
      await pendingB.promise;
    });
    expect(result.current.correctionError).toBeNull();
    expect(result.current.categories).toEqual(refreshedAfterB);

    // NOW A rejects — this is stale (superseded by B's success). The fix
    // must DROP it: no banner, no state churn, no redundant replay.
    await act(async () => {
      pendingA.reject(new Error('DB busy'));
      await pendingA.promise.catch(() => undefined);
      // Flush any subsequent microtasks so a would-be setState has time to land.
      await Promise.resolve();
      await Promise.resolve();
    });

    // No spurious retryable banner — B already saved successfully.
    expect(result.current.correctionError).toBeNull();
    // Chips still reflect B's already-applied refresh.
    expect(result.current.categories).toEqual(refreshedAfterB);
    // And no redundant replay was triggered — call count stayed at 2.
    expect(applyCategoryCorrection).toHaveBeenCalledTimes(2);
  });

  it('drops an out-of-order older success from correction A when a later correction B on the same item already succeeded — chips are not regressed (#388)', async () => {
    // The success-side mirror of the rejection drop above: two corrections A
    // then B are in flight on the SAME item. B (the later, higher-seq)
    // resolves SUCCESSFULLY first and applies its refresh; THEN A (the
    // earlier, lower-seq) resolves SUCCESSFULLY second. A's refresh is now
    // stale — applying it would regress the visible chips back to an older
    // state — so the advance-only successor guard MUST drop it and leave B's
    // chips in place.
    const initial = makeItemCategory({ categoryId: CATEGORY_ID, name: 'Cusco, Perú' });
    // A's (confirm) and B's (remove) refreshes are deliberately DISTINCT: if
    // A's older success were NOT dropped, the chips would visibly regress from
    // B's refresh to A's — the assertion that makes this test discriminating
    // against a removed or inverted guard.
    const refreshedAfterA: ItemCategoryDTO[] = [
      makeItemCategory({
        categoryId: CATEGORY_ID,
        name: 'Cusco, Perú',
        source: 'user',
        confidence: null,
      }),
    ];
    const refreshedAfterB: ItemCategoryDTO[] = [
      makeItemCategory({ categoryId: CATEGORY_ID, name: 'Cusco, Perú (removed)' }),
    ];

    const pendingA = deferred<ItemCategoryDTO[]>();
    const pendingB = deferred<ItemCategoryDTO[]>();
    const applyCategoryCorrection = vi
      .fn<(input: CategorizationCorrectionDTO) => Promise<ItemCategoryDTO[]>>()
      // First call = correction A (older seq; will succeed SECOND).
      .mockImplementationOnce(() => pendingA.promise)
      // Second call = correction B (newer seq; will succeed FIRST).
      .mockImplementationOnce(() => pendingB.promise);
    const api = makeFakeApi({
      listItemCategories: vi.fn(() => Promise.resolve([initial])),
      applyCategoryCorrection,
    });

    const { result } = renderHook(() => useItemCategories(ITEM_A, true), { wrapper: wrapper(api) });
    await waitFor(() => expect(result.current.categories).toEqual([initial]));

    // Fire A, then B — both in flight against the same item.
    act(() => result.current.applyCorrection(CONFIRM));
    act(() => result.current.applyCorrection(REMOVE));
    expect(applyCategoryCorrection).toHaveBeenCalledTimes(2);
    expect(applyCategoryCorrection).toHaveBeenNthCalledWith(1, CONFIRM);
    expect(applyCategoryCorrection).toHaveBeenNthCalledWith(2, REMOVE);

    // Resolve B (the later, higher-seq) FIRST — successfully. Its refresh is
    // applied and it becomes the highest successfully-settled attempt.
    await act(async () => {
      pendingB.resolve(refreshedAfterB);
      await pendingB.promise;
    });
    expect(result.current.correctionError).toBeNull();
    expect(result.current.categories).toEqual(refreshedAfterB);

    // NOW A (the earlier, lower-seq) resolves successfully SECOND. It is an
    // out-of-order older success — the guard drops it so B's newer chips stay.
    await act(async () => {
      pendingA.resolve(refreshedAfterA);
      await pendingA.promise;
      // Flush any subsequent microtasks so a would-be setState has time to land.
      await Promise.resolve();
      await Promise.resolve();
    });

    // Chips still reflect B's refresh — A's stale success was dropped, not applied.
    expect(result.current.categories).toEqual(refreshedAfterB);
    // Still no error banner, and no redundant replay was triggered.
    expect(result.current.correctionError).toBeNull();
    expect(applyCategoryCorrection).toHaveBeenCalledTimes(2);
  });
});

describe('useItemCategories — logs correction failures via the [kawsay] convention (#361)', () => {
  // Restore any test-installed spies (e.g. the console.warn spy in the it()
  // below) between tests. Installing spies at describe-collection time with
  // vi.spyOn(...).mockImplementation(...) and only .mockClear()-ing in
  // afterEach would keep console.warn mocked for the ENTIRE FILE (and any
  // later file that inherits a hot module cache), silently masking any
  // future warn-based assertion (#384). Scoping the spy inside the it()
  // plus vi.restoreAllMocks() keeps console.warn honest across the suite.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits a tagged console.warn carrying the original error when the correction rejects', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const initial = makeItemCategory({ categoryId: CATEGORY_ID, name: 'Cusco, Perú' });
    const failure = new Error('SQLITE_BUSY: database is locked');
    const applyCategoryCorrection = vi.fn(() => Promise.reject(failure));
    const api = makeFakeApi({
      listItemCategories: vi.fn(() => Promise.resolve([initial])),
      applyCategoryCorrection,
    });

    const { result } = renderHook(() => useItemCategories(ITEM_A, true), { wrapper: wrapper(api) });
    await waitFor(() => expect(result.current.categories).toEqual([initial]));

    await act(async () => {
      result.current.applyCorrection(CONFIRM);
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.correctionError).not.toBeNull());

    // At least one tagged warn call must reference the [kawsay] prefix AND
    // carry the original error object as a subsequent argument — matching the
    // established convention in src/lib/use-transcription-run.ts.
    const taggedCalls = warnSpy.mock.calls.filter(
      (args) => typeof args[0] === 'string' && args[0].startsWith('[kawsay]'),
    );
    expect(taggedCalls.length).toBeGreaterThan(0);
    const surfacedCall = taggedCalls.find((args) => args.includes(failure));
    expect(surfacedCall).toBeDefined();
  });
});
