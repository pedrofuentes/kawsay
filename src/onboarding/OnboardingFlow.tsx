// The first-run flow (AC-12). A tiny, explicit step machine threads the loved
// one's name and chosen source through: welcome → name → where the library lives →
// pick a source → guided export → point at the file → import (progress, cancel,
// completion). It renders inside the onboarding shell (a <main> landmark plus the
// persistent privacy status bar) and escapes into the main app via the router.
import { useState } from 'react';
import type { ReactElement } from 'react';
import { AppShell } from '@renderer/components/AppShell';
import { useLibrary } from '@renderer/lib/library';
import { useNavigation } from '@renderer/lib/navigation';
import { useImport } from '@renderer/lib/use-import';
import { WelcomeStep } from './steps/WelcomeStep';
import { NameStep } from './steps/NameStep';
import { LibraryLocationStep } from './steps/LibraryLocationStep';
import { SourcePickerStep } from './steps/SourcePickerStep';
import { WalkthroughStep } from './steps/WalkthroughStep';
import { ImportLocateStep } from './steps/ImportLocateStep';
import { ImportStep } from './steps/ImportStep';
import { TourStep } from './steps/TourStep';
import type { SourceMeta } from './sources';

type Step = 'welcome' | 'tour' | 'name' | 'location' | 'source' | 'walkthrough' | 'locate' | 'import';

export function OnboardingFlow(): ReactElement {
  const { navigate } = useNavigation();
  const { library } = useLibrary();
  const importJob = useImport();

  const [step, setStep] = useState<Step>('welcome');
  const [personName, setPersonName] = useState('');
  const [source, setSource] = useState<SourceMeta | null>(null);

  const enterApp = (): void => navigate({ name: 'timeline' });

  const startImport = (inputPath: string): void => {
    if (source === null) {
      return;
    }
    void importJob.start({ sourceType: source.type, inputPath });
    setStep('import');
  };

  const retryImport = (): void => {
    importJob.reset();
    setStep('locate');
  };

  return (
    <AppShell variant="onboarding" libraryName={library?.name}>
      {renderStep()}
    </AppShell>
  );

  function renderStep(): ReactElement {
    const sourcePicker = (
      <SourcePickerStep
        personName={personName}
        onBack={() => setStep('location')}
        onPick={(picked) => {
          setSource(picked);
          setStep('walkthrough');
        }}
        onSkip={enterApp}
      />
    );

    switch (step) {
      case 'welcome':
        return <WelcomeStep onStart={() => setStep('name')} onTour={() => setStep('tour')} />;
      case 'tour':
        // A real, skippable 3-card preview (#434) — replaces the old fake
        // `onTour` that just called `enterApp()` and dumped the visitor on an
        // empty timeline. Both finishing and skipping land on the timeline.
        return <TourStep onDone={enterApp} onSkip={enterApp} />;
      case 'name':
        return (
          <NameStep
            initialName={personName}
            onContinue={(name) => {
              setPersonName(name);
              setStep('location');
            }}
          />
        );
      case 'location':
        return (
          <LibraryLocationStep
            personName={personName}
            onBack={() => setStep('name')}
            onReady={() => setStep('source')}
          />
        );
      case 'source':
        return sourcePicker;
      case 'walkthrough':
        return source === null ? (
          sourcePicker
        ) : (
          <WalkthroughStep
            source={source}
            personName={personName}
            onBack={() => setStep('source')}
            onDone={() => setStep('locate')}
          />
        );
      case 'locate':
        return source === null ? (
          sourcePicker
        ) : (
          <ImportLocateStep
            source={source}
            personName={personName}
            onBack={() => setStep('walkthrough')}
            onStart={startImport}
          />
        );
      case 'import':
        return (
          <ImportStep
            personName={personName}
            state={importJob}
            onCancel={() => {
              void importJob.cancel();
            }}
            onRetry={retryImport}
            onSeeEverything={enterApp}
          />
        );
      default:
        return <WelcomeStep onStart={() => setStep('name')} onTour={enterApp} />;
    }
  }
}
