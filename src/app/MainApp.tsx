// The main application shell after onboarding. It owns the sidebar + status bar and
// routes the primary sections: the timeline (U1), search (U2), the Add Memories
// re-entry (#427), and settings — all reading the open library from LibraryContext
// and moving between sections via useNavigation.
import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { AppShell } from '@renderer/components/AppShell';
import { useLibrary } from '@renderer/lib/library';
import { useNavigation } from '@renderer/lib/navigation';
import { AddMemories } from '@renderer/views/AddMemories';
import { CollectionDetail, Collections } from '@renderer/views/Collections';
import { Search } from '@renderer/views/Search';
import { Settings } from '@renderer/views/Settings';
import { Timeline } from '@renderer/views/Timeline';
import { ItemView } from '@renderer/views/ItemView';
import { Sidebar } from './Sidebar';

export function MainApp(): ReactElement {
  const { view } = useNavigation();
  const { library } = useLibrary();
  const isTimeline = view.name === 'timeline';

  // Leaving Timeline for an opened memory or Search used to UNMOUNT it —
  // `useTimeline`'s loaded pages, the scroll offset, and the virtual window all
  // live in Timeline's own local state, so returning re-ran the fetch from page
  // 1 and reset scroll to the top (#432). Once visited, keep it mounted for the
  // rest of MainApp's lifetime instead of swapping it in and out of the switch
  // below — `active` (passed to Timeline) toggles it hidden rather than gone,
  // so its state simply survives the round trip. This mirrors the pattern the
  // NavigationProvider's favourite-override map already established: state
  // that must outlive a sibling view's remount lives ABOVE the swap, not
  // inside it.
  const [timelineMounted, setTimelineMounted] = useState(isTimeline);
  useEffect(() => {
    if (isTimeline) {
      setTimelineMounted(true);
    }
  }, [isTimeline]);

  return (
    <AppShell variant="main" sidebar={<Sidebar />} libraryName={library?.name}>
      {timelineMounted ? <Timeline active={isTimeline} /> : null}
      {isTimeline ? null : <div className="mx-auto flex max-w-3xl flex-col gap-8">{renderSection()}</div>}
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
      case 'collections':
        return <Collections key="collections" />;
      case 'collection':
        // Keyed by collection id so opening a different collection remounts the
        // view (its <h1> auto-focus re-runs and the members re-fetch for the
        // new id), mirroring the 'item' case below.
        return <CollectionDetail key={`collection-${view.collectionId}`} />;
      case 'item':
        // Keyed by item id so opening a different memory remounts the view (its
        // <h1> auto-focus re-runs, and the transcript re-reads for the new id).
        return <ItemView key={`item-${view.item.id}`} />;
      case 'timeline':
        // Handled above via the persistent, hidden-when-inactive mount (#432) —
        // unreachable here since that branch never calls renderSection().
        return null;
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
