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
