import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { usePrefersReducedMotion } from '@renderer/lib/use-reduced-motion';
import { REDUCED_MOTION_OVERRIDE_EVENT } from '@renderer/lib/use-reduced-motion';

/** Install a matchMedia stub answering the reduced-motion query deterministically. */
function stubReducedMotion(reduced: boolean): void {
  const mql = {
    matches: reduced,
    media: '(prefers-reduced-motion: reduce)',
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  };
  (window as unknown as { matchMedia: unknown }).matchMedia = vi.fn().mockReturnValue(mql);
}

function setOverride(on: boolean): void {
  document.documentElement.dataset.reducedMotion = on ? 'on' : 'off';
  window.dispatchEvent(new CustomEvent(REDUCED_MOTION_OVERRIDE_EVENT));
}

afterEach(() => {
  delete (window as unknown as { matchMedia?: unknown }).matchMedia;
  document.documentElement.removeAttribute('data-reduced-motion');
});

describe('usePrefersReducedMotion — composes the in-app override with the OS query', () => {
  it('OS says motion is welcome, no override set → motion stays welcome', () => {
    stubReducedMotion(false);
    const { result } = renderHook(() => usePrefersReducedMotion());
    expect(result.current).toBe(false);
  });

  it('OS says motion is welcome, override turned ON → reduced motion wins (override forces it)', () => {
    stubReducedMotion(false);
    const { result } = renderHook(() => usePrefersReducedMotion());
    expect(result.current).toBe(false);

    act(() => setOverride(true));

    expect(result.current).toBe(true);
  });

  it('OS already prefers reduced motion, override OFF → stays reduced (the OS query is still honoured)', () => {
    stubReducedMotion(true);
    const { result } = renderHook(() => usePrefersReducedMotion());
    expect(result.current).toBe(true);

    act(() => setOverride(false));

    expect(result.current).toBe(true);
  });

  it('turning the override back OFF defers to the (welcoming) OS query again', () => {
    stubReducedMotion(false);
    const { result } = renderHook(() => usePrefersReducedMotion());

    act(() => setOverride(true));
    expect(result.current).toBe(true);

    act(() => setOverride(false));
    expect(result.current).toBe(false);
  });
});
