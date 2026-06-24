// The main application shell after onboarding. It owns the sidebar + status bar and
// routes the primary sections. The timeline is the real virtualized screen (U1); the
// search body is still a light placeholder until U2 replaces it, reading the open
// library from LibraryContext and moving between sections via useNavigation.
import type { ReactElement } from 'react';
import { AppShell } from '@renderer/components/AppShell';
import { Button } from '@renderer/components/Button';
import { EmptyState } from '@renderer/components/EmptyState';
import { Icon } from '@renderer/components/Icon';
import { useLibrary } from '@renderer/lib/library';
import { useNavigation } from '@renderer/lib/navigation';
import { Timeline } from '@renderer/views/Timeline';
import { Sidebar } from './Sidebar';

export function MainApp(): ReactElement {
  const { view, navigate } = useNavigation();
  const { library } = useLibrary();
  const who = library?.name ?? 'your loved one';

  return (
    <AppShell variant="main" sidebar={<Sidebar />} libraryName={library?.name}>
      {view.name === 'timeline' ? (
        renderSection()
      ) : (
        <div className="mx-auto flex max-w-3xl flex-col gap-8">{renderSection()}</div>
      )}
    </AppShell>
  );

  function renderSection(): ReactElement | null {
    switch (view.name) {
      case 'search':
        return (
          <section className="flex flex-col gap-6">
            <h1 className="font-display text-3xl font-semibold text-text-primary">Search</h1>
            <EmptyState
              icon={<Icon name="messages" className="h-8 w-8" />}
              title="Search is on its way"
              description="Soon you'll be able to find a name, a place, or a few words from anywhere in the library."
            />
          </section>
        );
      case 'add-memories':
        return (
          <section className="flex flex-col gap-6">
            <h1 className="font-display text-3xl font-semibold text-text-primary">Add memories</h1>
            <EmptyState
              icon={<Icon name="archive" className="h-8 w-8" />}
              title="Bring in more"
              description={`Add another source to ${who}'s library whenever you're ready.`}
              action={
                <Button variant="primary" onClick={() => navigate({ name: 'timeline' })}>
                  Back to the timeline
                </Button>
              }
            />
          </section>
        );
      case 'settings':
        return (
          <section className="flex flex-col gap-6">
            <h1 className="font-display text-3xl font-semibold text-text-primary">Settings</h1>
            <EmptyState
              icon={<Icon name="briefcase" className="h-8 w-8" />}
              title="Settings will live here"
              description="Everything stays on this computer. There is nothing to sign in to."
            />
          </section>
        );
      case 'timeline':
        return <Timeline />;
      // Onboarding is routed by the top-level <Router/> (App.tsx) and never reaches
      // MainApp; the case exists only so the switch stays exhaustive over View.
      case 'onboarding':
        return null;
      default:
        return assertNever(view);
    }
  }
}

// Exhaustiveness guard for the typed view router (ADR-0015, issue #95): if a new
// View member is ever added without its own `case`, `view` is no longer `never`
// here and this call fails to type-check — a compile error, not a silent fallback.
function assertNever(view: never): never {
  throw new Error(`Unhandled view: ${JSON.stringify(view)}`);
}
