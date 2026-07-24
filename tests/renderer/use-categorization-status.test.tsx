// The categorization opt-in gate is read by several sibling surfaces at once — the
// Settings consent card, the "Organize now" run control, the suggestions tray, and
// the timeline chips. Toggling it in one MUST be reflected in all of them live, so
// opting in reveals the dependent surfaces in the same view rather than only after
// a remount (#510). These pin that cross-instance sync.
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { KawsayApiProvider } from '@renderer/lib/kawsay-api';
import { useCategorizationStatus } from '@renderer/lib/use-categorization';
import { makeFakeApi } from './support/fake-api';
import type { FakeApi } from './support/fake-api';

function wrapper(api: FakeApi) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <KawsayApiProvider api={api}>{children}</KawsayApiProvider>;
  };
}

/** Two independent hook instances, exactly like two sibling components reading the gate. */
function useTwoStatuses() {
  return { a: useCategorizationStatus(), b: useCategorizationStatus() };
}

describe('useCategorizationStatus — cross-instance opt-in sync (#510)', () => {
  it('reflects a toggle from one instance in every other mounted instance', async () => {
    const api = makeFakeApi({
      getCategorizationStatus: vi.fn(() => Promise.resolve({ optedIn: false, offered: true })),
      setCategorizationConsent: vi.fn(() => Promise.resolve({ optedIn: true })),
    });
    const { result } = renderHook(() => useTwoStatuses(), { wrapper: wrapper(api) });

    // Both instances start opted-out once their reads resolve.
    await waitFor(() => {
      expect(result.current.a.optedIn).toBe(false);
      expect(result.current.b.optedIn).toBe(false);
    });

    // Opt in through instance A only.
    act(() => result.current.a.setOptedIn(true));

    // Instance B must see it too — not just A — so a sibling surface enables live.
    await waitFor(() => expect(result.current.b.optedIn).toBe(true));
    expect(result.current.a.optedIn).toBe(true);
  });

  it('propagates a persistence failure revert to every instance', async () => {
    const api = makeFakeApi({
      getCategorizationStatus: vi.fn(() => Promise.resolve({ optedIn: false, offered: true })),
      setCategorizationConsent: vi.fn(() => Promise.reject(new Error('disk busy'))),
    });
    const { result } = renderHook(() => useTwoStatuses(), { wrapper: wrapper(api) });
    await waitFor(() => expect(result.current.a.optedIn).toBe(false));

    // Optimistic ON propagates to B first…
    act(() => result.current.a.setOptedIn(true));
    await waitFor(() => expect(result.current.b.optedIn).toBe(true));
    // …then the persist fails, so both instances fall back to OFF — the gate never
    // lies about what is actually stored.
    await waitFor(() => expect(result.current.b.optedIn).toBe(false));
    expect(result.current.a.optedIn).toBe(false);
  });
});
