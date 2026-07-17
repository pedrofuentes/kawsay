// Primary navigation for the main app. Lives inside the AppShell's <aside>. U1 and
// U2 add the timeline and search screens behind these sections; the routing here is
// just the typed navigation context.
import type { ReactElement } from 'react';
import { BrandMark } from '@renderer/components/BrandMark';
import { Icon } from '@renderer/components/Icon';
import type { IconName } from '@renderer/components/Icon';
import { useNavigation } from '@renderer/lib/navigation';
import type { View } from '@renderer/lib/navigation';
import { cx } from '@renderer/lib/cx';

interface NavItem {
  view: View;
  label: string;
  icon: IconName;
}

const ITEMS: NavItem[] = [
  { view: { name: 'timeline' }, label: 'Timeline', icon: 'heart' },
  { view: { name: 'search' }, label: 'Search', icon: 'messages' },
  { view: { name: 'collections' }, label: 'Collections', icon: 'collection' },
  { view: { name: 'add-memories' }, label: 'Add memories', icon: 'archive' },
  { view: { name: 'settings' }, label: 'Settings', icon: 'briefcase' },
];

export function Sidebar(): ReactElement {
  const { view, navigate } = useNavigation();
  return (
    <nav aria-label="Sections" className="flex flex-col gap-1 p-4">
      <div className="flex items-center gap-2 px-3 py-2">
        <BrandMark className="h-7 w-auto text-brand" />
        <span className="font-display text-lg font-semibold text-text-primary">Kawsay</span>
      </div>
      {ITEMS.map((item) => {
        const active = item.view.name === view.name;
        return (
          <button
            key={item.view.name}
            type="button"
            aria-current={active ? 'page' : undefined}
            onClick={() => navigate(item.view)}
            className={cx(
              'flex min-h-11 items-center gap-3 rounded-lg px-3 font-body text-base transition-colors duration-150',
              active
                ? 'bg-surface-raised font-medium text-text-primary'
                : 'text-text-secondary hover:bg-surface-raised',
            )}
          >
            <Icon name={item.icon} className="h-5 w-5 text-sage-600" />
            {item.label}
          </button>
        );
      })}
    </nav>
  );
}
