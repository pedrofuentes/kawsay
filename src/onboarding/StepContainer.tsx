// Shared frame for every onboarding screen: a calm, centered single column with
// the full privacy reassurance pinned to the footer (USER_FLOWS Journey A). Steps
// provide their own focusable <h1>; this just gives them consistent width, rhythm,
// and the ever-present "your memories never leave this computer" footer.
import type { ReactElement, ReactNode } from 'react';
import { PrivacyBadge } from '@renderer/components/PrivacyBadge';

export interface StepContainerProps {
  children: ReactNode;
}

export function StepContainer({ children }: StepContainerProps): ReactElement {
  return (
    <div className="flex w-full max-w-xl flex-col gap-8 py-4">
      <div className="flex flex-col gap-6">{children}</div>
      <div className="border-t border-border-subtle pt-5">
        <PrivacyBadge variant="step-footer" />
      </div>
    </div>
  );
}
