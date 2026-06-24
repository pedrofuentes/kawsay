// Shared render helper: wraps a UI tree in the three renderer providers
// (KawsayApi → Library → Navigation) with a configurable fake API, mirroring how
// src/App.tsx composes them. Also exports a tiny probe for asserting the active
// view from the navigation context.
import type { ReactElement, ReactNode } from 'react';
import { render, type RenderResult } from '@testing-library/react';
import { KawsayApiProvider } from '@renderer/lib/kawsay-api';
import { LibraryProvider } from '@renderer/lib/library';
import { NavigationProvider, useNavigation, type View } from '@renderer/lib/navigation';
import type { FakeApi } from './fake-api';
import { makeFakeApi } from './fake-api';

export interface RenderOptions {
  api?: FakeApi;
  initialView?: View;
}

export interface ProvidersRender extends RenderResult {
  api: FakeApi;
}

export function renderWithProviders(ui: ReactNode, options: RenderOptions = {}): ProvidersRender {
  const api = options.api ?? makeFakeApi();
  const result = render(
    <KawsayApiProvider api={api}>
      <LibraryProvider>
        <NavigationProvider initialView={options.initialView}>{ui}</NavigationProvider>
      </LibraryProvider>
    </KawsayApiProvider>,
  );
  return { ...result, api };
}

/** Renders the active view name into the DOM so tests can assert navigation. */
export function ViewProbe(): ReactElement {
  const { view } = useNavigation();
  return <div data-testid="active-view">{view.name}</div>;
}

export function wrapInProviders(children: ReactNode, api: FakeApi, initialView?: View): ReactElement {
  return (
    <KawsayApiProvider api={api}>
      <LibraryProvider>
        <NavigationProvider initialView={initialView}>{children}</NavigationProvider>
      </LibraryProvider>
    </KawsayApiProvider>
  );
}
