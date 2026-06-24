// Composition root for the renderer. It wires the three foundation providers —
// the typed Kawsay API bridge, the open-library context, and the view router —
// then routes between first-run onboarding and the main app. U1 (timeline) and
// U2 (search) build inside MainApp and reuse these same providers/hooks.
import type { ReactElement } from 'react';
import { KawsayApiProvider } from '@renderer/lib/kawsay-api';
import { LibraryProvider } from '@renderer/lib/library';
import { NavigationProvider, useNavigation } from '@renderer/lib/navigation';
import { OnboardingFlow } from '@renderer/onboarding/OnboardingFlow';
import { MainApp } from '@renderer/app/MainApp';

function Router(): ReactElement {
  const { view } = useNavigation();
  return view.name === 'onboarding' ? <OnboardingFlow /> : <MainApp />;
}

export function App(): ReactElement {
  return (
    <KawsayApiProvider>
      <LibraryProvider>
        <NavigationProvider>
          <Router />
        </NavigationProvider>
      </LibraryProvider>
    </KawsayApiProvider>
  );
}
