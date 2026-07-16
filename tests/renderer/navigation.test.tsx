import { describe, expect, it } from 'vitest';
import { render, renderHook, screen, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import {
  NavigationProvider,
  useNavigation,
  type View,
} from '@renderer/lib/navigation';

function wrapper(initialView?: View) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <NavigationProvider initialView={initialView}>{children}</NavigationProvider>;
  };
}

describe('navigation router', () => {
  it('defaults to the onboarding view on first run', () => {
    const { result } = renderHook(() => useNavigation(), { wrapper: wrapper() });
    expect(result.current.view).toEqual({ name: 'onboarding' });
  });

  it('honours an explicit initial view', () => {
    const { result } = renderHook(() => useNavigation(), {
      wrapper: wrapper({ name: 'timeline' }),
    });
    expect(result.current.view).toEqual({ name: 'timeline' });
  });

  it('navigate() switches the active view', () => {
    const { result } = renderHook(() => useNavigation(), { wrapper: wrapper() });
    act(() => {
      result.current.navigate({ name: 'search' });
    });
    expect(result.current.view).toEqual({ name: 'search' });
  });

  it('renders the current view name for consumers', () => {
    function Probe() {
      const { view } = useNavigation();
      return <span>view:{view.name}</span>;
    }
    render(
      <NavigationProvider initialView={{ name: 'settings' }}>
        <Probe />
      </NavigationProvider>,
    );
    expect(screen.getByText('view:settings')).toBeInTheDocument();
  });

  it('throws a clear error when useNavigation is used outside the provider', () => {
    expect(() => renderHook(() => useNavigation())).toThrow(/NavigationProvider/);
  });
});

// The overlay consumers (Timeline cards, ItemView's sibling snapshot) read
// `favouriteOverrides` to keep a card honest without a refetch. Since #487 lifted
// the in-flight state into the provider, that map briefly carried the OPTIMISTIC
// (unsaved) value, so a favourite marked in ItemView flashed onto the still-mounted
// Timeline and then silently reverted if the save failed (#488). These pin option
// (b): the overlay shows only SETTLED truth; the optimistic value stays scoped to
// the mounted toggle (which reads `favouriteStateFor`, not the overrides map).
describe('favourite overrides — settled truth only for overlay consumers (#488)', () => {
  it('does not expose an in-flight (optimistic) favourite to the overlay', () => {
    const { result } = renderHook(() => useNavigation(), { wrapper: wrapper() });
    let token = 0;
    act(() => {
      token = result.current.beginFavouriteSave('item-1', true);
    });
    // The mounted toggle sees the optimistic value + busy flag...
    expect(result.current.favouriteStateFor('item-1')?.value).toBe(true);
    expect(result.current.favouriteStateFor('item-1')?.saving).toBe(true);
    // ...but overlay consumers must NOT — nothing is persisted yet.
    expect(result.current.favouriteOverrides['item-1']).toBeUndefined();
    // Once it settles, the overlay reflects the persisted value.
    act(() => {
      result.current.settleFavouriteSave('item-1', token, { ok: true, value: true });
    });
    expect(result.current.favouriteOverrides['item-1']).toBe(true);
  });

  it('reverts overlay consumers to settled truth when an in-flight favourite fails', () => {
    const { result } = renderHook(() => useNavigation(), { wrapper: wrapper() });
    let token = 0;
    act(() => {
      token = result.current.beginFavouriteSave('item-2', true);
    });
    expect(result.current.favouriteOverrides['item-2']).toBeUndefined();
    act(() => {
      result.current.settleFavouriteSave('item-2', token, { ok: false, revertTo: false });
    });
    // The optimistic true never reaches the overlay; it settles to the reverted value.
    expect(result.current.favouriteOverrides['item-2']).toBe(false);
  });

  it('keeps the last SETTLED favourite on the overlay while a new toggle is in flight', () => {
    const { result } = renderHook(() => useNavigation(), { wrapper: wrapper() });
    let first = 0;
    act(() => {
      first = result.current.beginFavouriteSave('item-3', true);
    });
    act(() => {
      result.current.settleFavouriteSave('item-3', first, { ok: true, value: true });
    });
    expect(result.current.favouriteOverrides['item-3']).toBe(true);

    // Un-favourite it — while THAT save is in flight the overlay must still show the
    // last settled value (true), not the optimistic false the toggle is showing.
    let second = 0;
    act(() => {
      second = result.current.beginFavouriteSave('item-3', false);
    });
    expect(result.current.favouriteStateFor('item-3')?.value).toBe(false);
    expect(result.current.favouriteOverrides['item-3']).toBe(true);

    // A failed un-favourite reverts to true and the overlay stays true throughout.
    act(() => {
      result.current.settleFavouriteSave('item-3', second, { ok: false, revertTo: true });
    });
    expect(result.current.favouriteOverrides['item-3']).toBe(true);
  });

  it('records settled truth from an older reply that lands while a newer save is still pending', () => {
    // Two overlapping saves on the SAME id, older reply settling first. This exercises
    // the isNewestAttempt=false branch AND the settledValue short-circuit clause: the
    // older reply establishes the current persisted truth for the overlay even though
    // its optimistic value already matches, while the toggle stays busy for the newer
    // save. Without the clause the update is wrongly skipped and the id stays absent.
    const { result } = renderHook(() => useNavigation(), { wrapper: wrapper() });
    let older = 0;
    let newer = 0;
    act(() => {
      older = result.current.beginFavouriteSave('item-4', true); // optimistic favourite
      newer = result.current.beginFavouriteSave('item-4', false); // then un-favourite
    });
    // Nothing settled yet → overlay shows no override (falls back to the card's flag).
    expect(result.current.favouriteOverrides['item-4']).toBeUndefined();
    // The OLDER save fails and reverts to the pre-toggle value (false) — which equals
    // the newer optimistic value, so only the settledValue transition distinguishes it.
    act(() => {
      result.current.settleFavouriteSave('item-4', older, { ok: false, revertTo: false });
    });
    // Overlay now reflects that settled truth...
    expect(result.current.favouriteOverrides['item-4']).toBe(false);
    // ...and the toggle stays busy because the newer save is still in flight.
    expect(result.current.favouriteStateFor('item-4')?.saving).toBe(true);
  });
});
