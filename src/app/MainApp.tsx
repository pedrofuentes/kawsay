// The main application shell after onboarding. It owns the sidebar + status bar and
// routes the primary sections: the timeline (U1), search (U2), the Add Memories
// re-entry (#427), and settings — all reading the open library from LibraryContext
// and moving between sections via useNavigation.
import type { ReactElement } from 'react';
import { AppShell } from '@renderer/components/AppShell';
import { useLibrary } from '@renderer/lib/library';
import { useNavigation } from '@renderer/lib/navigation';
import { AddMemories } from '@renderer/views/AddMemories';
import { Search } from '@renderer/views/Search';
import { Settings } from '@renderer/views/Settings';
import { Timeline } from '@renderer/views/Timeline';
import { ItemView } from '@renderer/views/ItemView';
import { Sidebar } from './Sidebar';

export function MainApp(): ReactElement {
  const { view } = useNavigation();
  const { library } = useLibrary();

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
        return <Search />;
      case 'add-memories':
        // Keyed so re-entering "Add memories" remounts the flow at its source
        // chooser (the reused steps' <h1> auto-focus re-runs) rather than stranding
        // the user mid-import from a previous visit.
        return <AddMemories key="add-memories" />;
      case 'settings':
        return <Settings key="settings" />;
      case 'item':
        // Keyed by item id so opening a different memory remounts the view (its
        // <h1> auto-focus re-runs, and the transcript re-reads for the new id).
        return <ItemView key={`item-${view.item.id}`} />;
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
