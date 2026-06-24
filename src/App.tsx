import { useEffect, useState, type ReactElement } from 'react';

/**
 * Welcome / placeholder screen for the application shell (card F1). It exercises
 * the design-token pipeline end-to-end — bundled fonts, the calm palette,
 * spacing, radii, and elevation — and proves the secure IPC path by fetching the
 * app version through `window.kawsayAPI` (preload → zod → main → app.getVersion).
 * Later cards replace this with the real onboarding and library views.
 */
export function App(): ReactElement {
  const version = useAppVersion();

  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-6 py-16 text-center">
      <section className="flex max-w-prose flex-col items-center gap-6">
        <p className="font-body text-sm font-medium uppercase tracking-wider text-sage-600">
          Kawsay
        </p>

        <h1 className="font-display text-4xl font-semibold leading-tight text-text-primary">
          A calm, private home for the people you love.
        </h1>

        <p className="font-body text-lg leading-relaxed text-text-secondary">
          Everything stays on this device. Nothing is ever uploaded, tracked, or shared. Take your
          time — there is nothing here but you and your memories.
        </p>

        <span className="mt-2 rounded-full bg-surface-tinted px-5 py-2 font-body text-sm text-text-tertiary shadow-sm">
          {version === null
            ? 'The application shell is ready.'
            : `The application shell is ready · v${version}`}
        </span>
      </section>
    </main>
  );
}

/** Fetch the app version once through the secure bridge, tolerating its absence
 *  (e.g. a plain browser preview where no preload is attached). */
function useAppVersion(): string | null {
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const api = window.kawsayAPI;
    if (api !== undefined) {
      void api.getAppVersion().then(
        (value) => {
          if (active) setVersion(value);
        },
        () => {
          // Leave the neutral fallback copy in place on failure.
        },
      );
    }
    return () => {
      active = false;
    };
  }, []);

  return version;
}
