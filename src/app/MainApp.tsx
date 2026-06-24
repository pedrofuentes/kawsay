// The main application shell after onboarding. It owns the sidebar + status bar and
// routes the primary sections. The timeline and search bodies are intentionally
// light placeholders here — U1 and U2 replace them with the real screens, reading
// the open library from LibraryContext and moving between sections via useNavigation.
import type { ReactElement } from 'react';
import { AppShell } from '@renderer/components/AppShell';
import { Button } from '@renderer/components/Button';
import { EmptyState } from '@renderer/components/EmptyState';
import { Icon } from '@renderer/components/Icon';
import { useLibrary } from '@renderer/lib/library';
import { useNavigation } from '@renderer/lib/navigation';
import { Search } from '@renderer/views/Search';
import { Sidebar } from './Sidebar';

export function MainApp(): ReactElement {
  const { view, navigate } = useNavigation();
  const { library } = useLibrary();
  const who = library?.name ?? 'your loved one';

  return (
    <AppShell variant="main" sidebar={<Sidebar />} libraryName={library?.name}>
      <div className="mx-auto flex max-w-3xl flex-col gap-8">{renderSection()}</div>
    </AppShell>
  );

  function renderSection(): ReactElement {
    switch (view.name) {
      case 'search':
        return <Search />;
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
      default:
        return (
          <section className="flex flex-col gap-6">
            <h1 className="font-display text-3xl font-semibold text-text-primary">
              {library !== null ? `${library.name}'s timeline` : 'Timeline'}
            </h1>
            <EmptyState
              icon={<Icon name="heart" className="h-8 w-8" />}
              title="Their memories will gather here"
              description="As you bring in chats, photos, and messages, they'll appear here in a gentle timeline."
              action={
                <Button variant="primary" onClick={() => navigate({ name: 'add-memories' })}>
                  Add memories
                </Button>
              }
            />
          </section>
        );
    }
  }
}
