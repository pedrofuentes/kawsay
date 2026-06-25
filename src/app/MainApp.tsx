// The main application shell after onboarding. It owns the sidebar + status bar and
// routes the primary sections. The timeline (U1) and search (U2) are the real screens;
// add-memories and settings stay light placeholders for now, all reading the open
// library from LibraryContext and moving between sections via useNavigation.
import type { ReactElement } from 'react';
import { AppShell } from '@renderer/components/AppShell';
import { Button } from '@renderer/components/Button';
import { EmptyState } from '@renderer/components/EmptyState';
import { Icon } from '@renderer/components/Icon';
import type { IconName } from '@renderer/components/Icon';
import { useAutoFocusHeading } from '@renderer/lib/use-auto-focus';
import { useLibrary } from '@renderer/lib/library';
import { useNavigation } from '@renderer/lib/navigation';
import { Search } from '@renderer/views/Search';
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
        return <Search />;
      case 'add-memories':
        return (
          <InfoView
            key="add-memories"
            heading="Add memories"
            icon="archive"
            emptyTitle="Bring in more"
            description={`Add another source to ${who}'s library whenever you're ready.`}
            action={
              <Button variant="primary" onClick={() => navigate({ name: 'timeline' })}>
                Back to the timeline
              </Button>
            }
          />
        );
      case 'settings':
        return (
          <InfoView
            key="settings"
            heading="Settings"
            icon="briefcase"
            emptyTitle="Settings will live here"
            description="Everything stays on this computer. There is nothing to sign in to."
          />
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

interface InfoViewProps {
  heading: string;
  icon: IconName;
  emptyTitle: string;
  description: string;
  action?: ReactElement;
}

// The light placeholder sections (add-memories, settings). Like Timeline and Search,
// each moves focus to its <h1> on mount so that switching sections lands the keyboard
// and screen-reader cursor on the new view's name (WCAG 2.4.3, AC-13). The distinct
// `key` per section in renderSection() remounts this on every switch so the effect
// re-runs.
function InfoView({ heading, icon, emptyTitle, description, action }: InfoViewProps): ReactElement {
  const headingRef = useAutoFocusHeading<HTMLHeadingElement>();
  return (
    <section className="flex flex-col gap-6">
      <h1
        ref={headingRef}
        tabIndex={-1}
        className="font-display text-3xl font-semibold text-text-primary outline-none"
      >
        {heading}
      </h1>
      <EmptyState
        icon={<Icon name={icon} className="h-8 w-8" />}
        title={emptyTitle}
        description={description}
        action={action}
      />
    </section>
  );
}

// Exhaustiveness guard for the typed view router (ADR-0015, issue #95): if a new
// View member is ever added without its own `case`, `view` is no longer `never`
// here and this call fails to type-check — a compile error, not a silent fallback.
function assertNever(view: never): never {
  throw new Error(`Unhandled view: ${JSON.stringify(view)}`);
}
