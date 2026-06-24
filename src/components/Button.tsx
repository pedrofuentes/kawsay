// The one button in the system. Three calm variants; primary is the single,
// obvious next action on a screen (USER_FLOWS rubric R3). Always a real <button>
// with an explicit type, generous hit area (≥44px), and a visible focus ring
// inherited from the global :focus-visible style.
import type { ButtonHTMLAttributes, ReactElement } from 'react';
import { cx } from '@renderer/lib/cx';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> {
  variant?: ButtonVariant;
  fullWidth?: boolean;
}

const BASE =
  'inline-flex items-center justify-center gap-2 rounded-lg font-body font-semibold transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-55';

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'min-h-14 px-8 text-md bg-sage-600 text-text-on-primary hover:bg-sage-700 active:bg-sage-800',
  secondary:
    'min-h-12 px-6 text-base bg-surface-raised text-text-primary border border-border-interactive hover:bg-surface-tinted',
  ghost: 'min-h-12 px-4 text-base bg-transparent text-sage-600 hover:bg-sage-50',
};

export function Button({
  variant = 'secondary',
  type = 'button',
  fullWidth = false,
  children,
  ...rest
}: ButtonProps): ReactElement {
  return (
    <button
      type={type}
      data-variant={variant}
      className={cx(BASE, VARIANTS[variant], fullWidth && 'w-full')}
      {...rest}
    >
      {children}
    </button>
  );
}
