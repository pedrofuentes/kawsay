// The reduced-motion OVERRIDE (AC-13 / Journey G, #433): composes with — never
// fights — the OS-level `prefers-reduced-motion` query. ON forces the same calm
// collapse of every animation/transition regardless of the OS setting; OFF/auto
// simply defers to that system preference, so most people never need to touch
// this at all. Persisted durably via `settings:set` so the choice survives a
// relaunch. The switch itself is 44px tall — a full tap target on its own,
// mirroring Button's ≥44px hit-area rule (not just the row around it).
import { useId } from 'react';
import type { ReactElement } from 'react';
import { cx } from '@renderer/lib/cx';
import { useSettings } from '@renderer/lib/settings';

export function ReducedMotionToggle(): ReactElement {
  const { settings, setReducedMotion } = useSettings();
  const labelId = useId();
  const statusId = useId();
  const { reducedMotion } = settings;

  return (
    <div className="flex items-center justify-between gap-4 rounded-xl bg-surface-sunken px-4 py-3">
      <div className="flex flex-col">
        <span id={labelId} className="font-body text-base font-medium text-text-primary">
          Reduce motion
        </span>
        <span id={statusId} className="font-body text-sm text-text-secondary">
          {reducedMotion
            ? 'On. Animation and movement are kept to a minimum, everywhere in Kawsay.'
            : "Off. Kawsay follows this computer's own reduce-motion setting."}
        </span>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={reducedMotion}
        aria-labelledby={labelId}
        aria-describedby={statusId}
        onClick={() => setReducedMotion(!reducedMotion)}
        className={cx(
          'relative inline-flex h-11 w-20 shrink-0 items-center rounded-full transition-colors duration-150',
          reducedMotion ? 'bg-sage-600' : 'bg-border-interactive',
        )}
      >
        <span
          aria-hidden
          className={cx(
            'inline-block h-9 w-9 rounded-full bg-surface-raised transition-transform duration-150',
            reducedMotion ? 'translate-x-10' : 'translate-x-1',
          )}
        />
      </button>
    </div>
  );
}
