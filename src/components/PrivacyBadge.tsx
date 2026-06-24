// The promise the whole app is built on, stated plainly. Two forms: a full
// sentence to anchor a step's footer, and a compact chip that lives permanently
// in the status bar. The lock glyph is decorative; the words carry the meaning.
import type { ReactElement } from 'react';
import { Icon } from './Icon';

export interface PrivacyBadgeProps {
  variant?: 'status-bar' | 'step-footer';
}

export function PrivacyBadge({ variant = 'step-footer' }: PrivacyBadgeProps): ReactElement {
  if (variant === 'status-bar') {
    return (
      <p className="inline-flex items-center gap-2 font-body text-sm text-text-secondary">
        <Icon name="lock" className="h-4 w-4 text-sage-600" />
        <span>Private &amp; on this computer</span>
      </p>
    );
  }
  return (
    <p className="inline-flex items-center gap-2.5 font-body text-sm text-text-secondary">
      <Icon name="lock" className="h-4 w-4 shrink-0 text-sage-600" />
      <span>Your memories never leave this computer. No account, nothing is uploaded.</span>
    </p>
  );
}
