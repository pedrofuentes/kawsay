// A gentle, non-alarming error surface. Always plain language (the caller passes
// reassuring copy, never a raw code), announced as an alert, with an optional
// single retry. Tone: "something went sideways, here's the calm way forward."
import type { ReactElement } from 'react';
import { Button } from './Button';

export interface ErrorBannerProps {
  id?: string;
  title?: string;
  message: string;
  onRetry?: () => void;
  retryLabel?: string;
}

export function ErrorBanner({
  id,
  title,
  message,
  onRetry,
  retryLabel = 'Try again',
}: ErrorBannerProps): ReactElement {
  return (
    <div
      id={id}
      role="alert"
      className="flex flex-col gap-3 rounded-lg border border-error-border bg-error-bg p-5 text-error-text"
    >
      {title !== undefined ? <p className="font-body text-base font-semibold">{title}</p> : null}
      <p className="font-body text-base">{message}</p>
      {onRetry !== undefined ? (
        <div>
          <Button variant="secondary" onClick={onRetry}>
            {retryLabel}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
