// Add memories (#427) — the post-onboarding re-entry into the guided import.
// After setup a user must be able to bring in a *second* source at any time, so
// this view replays the same source mini-flow from onboarding —
//   pick a source → guided export walkthrough → point at the file → import
//   (live progress, a stop-that-keeps-what's-found, a completion summary) —
// but hosted inside the main app shell (the sidebar stays; no welcome, no library
// naming, no privacy intro — those are one-time onboarding concerns). It reuses the
// onboarding source registry and step components verbatim and drives the existing
// `import:*` bridge through useImport, so it adds no new IPC channel.
//
// Like every primary view it lands focus on its <h1> (via the reused steps'
// useAutoFocusHeading), and each face renders exactly one level-1 heading.
import { useState } from 'react';
import type { ReactElement } from 'react';
import { useLibrary } from '@renderer/lib/library';
import { useNavigation } from '@renderer/lib/navigation';
import { useImport } from '@renderer/lib/use-import';
import { SourcePickerStep } from '@renderer/onboarding/steps/SourcePickerStep';
import { WalkthroughStep } from '@renderer/onboarding/steps/WalkthroughStep';
import { ImportLocateStep } from '@renderer/onboarding/steps/ImportLocateStep';
import { ImportStep } from '@renderer/onboarding/steps/ImportStep';
import type { SourceMeta } from '@renderer/onboarding/sources';

type Step = 'source' | 'walkthrough' | 'locate' | 'import';

export function AddMemories(): ReactElement {
  const { navigate, invalidateTimeline } = useNavigation();
  const { library } = useLibrary();
  const importJob = useImport();

  // Post-onboarding a library is always open, so this names the person. The
  // fallback only ever shows in a bridge-less preview and never says "your loved
  // one" (USER_FLOWS §1 reverent copy).
  const personName = library?.name ?? 'your library';

  const [step, setStep] = useState<Step>('source');
  const [source, setSource] = useState<SourceMeta | null>(null);

  const goToTimeline = (): void => navigate({ name: 'timeline' });

  // Leaving a finished import for the timeline: the catalog now holds memories
  // it didn't before, so invalidate the mounted-but-cached timeline (#432
  // review regression B) — otherwise the freshly imported memories stay
  // invisible until the app is relaunched. This is the single point every
  // completed/cancelled import passes through (the "See everything" button), and
  // it is NOT the plain source-picker "back" (goToTimeline), so a user who backs
  // out without importing never triggers a needless refetch.
  const seeEverything = (): void => {
    invalidateTimeline();
    goToTimeline();
  };

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

  const sourcePicker = (
    <SourcePickerStep
      heading="Add memories"
      personName={personName}
      onBack={goToTimeline}
      onPick={(picked) => {
        setSource(picked);
        setStep('walkthrough');
      }}
    />
  );

  switch (step) {
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
          onSeeEverything={seeEverything}
          onUndo={() => importJob.undo()}
        />
      );
    default:
      return sourcePicker;
  }
}
