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
import { describe, expect, it, vi } from 'vitest';
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
