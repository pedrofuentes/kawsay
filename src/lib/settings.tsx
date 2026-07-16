// Holds the persisted, app-wide UX settings (AC-13 / Journey G, #433) — the
// text-size step and the reduced-motion override — so any control can read the
// current choice and change it. Every write is applied to the document root
// IMMEDIATELY (before the IPC round trip even resolves), then persisted via the
// validated `settings:set` channel and reconciled with whatever the main
// process actually wrote to disk — the same optimistic-then-reconcile shape
// `library.tsx` and `use-categorization.ts` already use.
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import type { SettingsDTO, TextSizeDTO } from '@shared/kawsay-api';
import { useKawsayApi } from './kawsay-api';
import { REDUCED_MOTION_OVERRIDE_EVENT } from './use-reduced-motion';

const DEFAULT_SETTINGS: SettingsDTO = { textSize: 'default', reducedMotion: false };

/** The `--text-scale` multiplier each named step maps to (tokens.css's `--text-*`
 *  tokens are all `calc(basePx * var(--text-scale, 1))`, so overriding this ONE
 *  custom property scales every size proportionally, app-wide, at once). */
export const TEXT_SCALE_BY_STEP: Record<TextSizeDTO, number> = {
  default: 1,
  large: 1.15,
  larger: 1.3,
};

/**
 * Apply a settings snapshot to the document root so EVERY view reflects it
 * immediately, with no reload and no per-component wiring:
 *   • `data-text-size` names the step (debugging/testing) and `--text-scale`
 *     is the actual multiplier the type-scale tokens read (tokens.css);
 *   • `data-reduced-motion` is the override `usePrefersReducedMotion` composes
 *     with the OS `prefers-reduced-motion` query.
 */
function applyToRoot(settings: SettingsDTO): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.dataset.textSize = settings.textSize;
  root.style.setProperty('--text-scale', String(TEXT_SCALE_BY_STEP[settings.textSize]));
  root.dataset.reducedMotion = settings.reducedMotion ? 'on' : 'off';
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(REDUCED_MOTION_OVERRIDE_EVENT));
  }
}

export interface SettingsContextValue {
  settings: SettingsDTO;
  /** True while the first settings read is in flight. */
  loading: boolean;
  /** Persist a new text-size step (caller-initiated from the control only). */
  setTextSize: (next: TextSizeDTO) => void;
  /** Persist a new reduced-motion override (caller-initiated from the toggle only). */
  setReducedMotion: (next: boolean) => void;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }): ReactElement {
  const api = useKawsayApi();
  const [settings, setSettings] = useState<SettingsDTO>(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(true);

  // Apply the calm baseline immediately on first mount (before any read
  // resolves), so the root is never left without a `--text-scale`/override.
  useEffect(() => {
    applyToRoot(DEFAULT_SETTINGS);
  }, []);

  useEffect(() => {
    if (api === undefined) {
      setLoading(false);
      return undefined;
    }
    let active = true;
    setLoading(true);
    void api
      .getSettings()
      .then((next) => {
        if (!active) return;
        setSettings(next);
        applyToRoot(next);
        setLoading(false);
      })
      .catch(() => {
        // A failed read leaves the calm baseline applied rather than guessing;
        // the next open will try again.
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [api]);

  const persist = useCallback(
    (patch: Partial<SettingsDTO>): void => {
      const previous = settings;
      const next: SettingsDTO = { ...previous, ...patch };
      // Apply at once — the whole point (AC-13) is that the change is felt
      // immediately, never waiting on the main-process round trip.
      setSettings(next);
      applyToRoot(next);
      if (api === undefined) return;
      void api
        .setSettings(patch)
        .then((resolved) => {
          setSettings(resolved);
          applyToRoot(resolved);
        })
        .catch(() => {
          // Persisting failed — revert to the pre-change snapshot so the UI
          // never lies about what is actually durable.
          setSettings(previous);
          applyToRoot(previous);
        });
    },
    [api, settings],
  );

  const setTextSize = useCallback((next: TextSizeDTO) => persist({ textSize: next }), [persist]);
  const setReducedMotion = useCallback((next: boolean) => persist({ reducedMotion: next }), [persist]);

  const value = useMemo<SettingsContextValue>(
    () => ({ settings, loading, setTextSize, setReducedMotion }),
    [settings, loading, setTextSize, setReducedMotion],
  );

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings(): SettingsContextValue {
  const value = useContext(SettingsContext);
  if (value === null) {
    throw new Error('useSettings must be used within a SettingsProvider.');
  }
  return value;
}
