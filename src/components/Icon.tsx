// A small, locally-drawn monochrome icon set. The glyphs are deliberately gentle
// and generic (a speech bubble, a photo, a box…) rather than brand logos — calmer,
// and free of trademark concerns. Icons inherit `currentColor`. By default they
// are decorative (aria-hidden); pass a `label` to expose one to assistive tech.
import type { ReactElement } from 'react';

export type IconName =
  | 'lock'
  | 'messages'
  | 'photos'
  | 'video'
  | 'audio'
  | 'document'
  | 'archive'
  | 'globe'
  | 'briefcase'
  | 'heart'
  | 'arrow-right'
  | 'check'
  | 'sparkle';

const PATHS: Record<IconName, ReactElement> = {
  lock: (
    <>
      <rect x="5" y="11" width="14" height="9" rx="2.5" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
      <path d="M12 15v2" />
    </>
  ),
  messages: (
    <>
      <path d="M4 12a6 6 0 0 1 6-6h2a6 6 0 0 1 0 12H7l-3 2v-3a6 6 0 0 1-0-5Z" />
    </>
  ),
  photos: (
    <>
      <rect x="4" y="5" width="16" height="14" rx="2.5" />
      <circle cx="9" cy="10" r="1.6" />
      <path d="m5 17 4-4 3 3 3-3 4 4" />
    </>
  ),
  video: (
    <>
      <rect x="3" y="6" width="18" height="12" rx="2.5" />
      <path d="m10 9.5 5 2.5-5 2.5Z" />
    </>
  ),
  audio: (
    <>
      <path d="M5 11v2" />
      <path d="M9 8.5v7" />
      <path d="M13 6v12" />
      <path d="M17 9v6" />
      <path d="M21 11v2" />
    </>
  ),
  document: (
    <>
      <path d="M7 3.5h7l4 4V19a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 6 19V5a1.5 1.5 0 0 1 1-1.5Z" />
      <path d="M14 3.5V8h4" />
      <path d="M9 13h6" />
      <path d="M9 16.5h6" />
    </>
  ),
  archive: (
    <>
      <path d="M4 7.5 12 4l8 3.5-8 3.5-8-3.5Z" />
      <path d="M4 7.5V16l8 4 8-4V7.5" />
      <path d="M12 11v9" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M4 12h16M12 4c2.5 2.2 2.5 13.8 0 16M12 4c-2.5 2.2-2.5 13.8 0 16" />
    </>
  ),
  briefcase: (
    <>
      <rect x="4" y="7.5" width="16" height="11" rx="2" />
      <path d="M9 7.5V6a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v1.5" />
      <path d="M4 12h16" />
    </>
  ),
  heart: (
    <>
      <path d="M12 19s-6.5-4.2-8.2-8.1C2.5 8 4 5 7 5c1.8 0 3 1 5 3 2-2 3.2-3 5-3 3 0 4.5 3 3.2 5.9C18.5 14.8 12 19 12 19Z" />
    </>
  ),
  'arrow-right': (
    <>
      <path d="M5 12h14" />
      <path d="m13 6 6 6-6 6" />
    </>
  ),
  check: (
    <>
      <path d="m5 12.5 4.5 4.5L19 7.5" />
    </>
  ),
  sparkle: (
    <>
      <path d="M12 4c.6 3.6 1.8 4.8 5.4 5.4-3.6.6-4.8 1.8-5.4 5.4-.6-3.6-1.8-4.8-5.4-5.4C10.2 8.8 11.4 7.6 12 4Z" />
      <path d="M18.5 14.5c.3 1.7.9 2.3 2.6 2.6-1.7.3-2.3.9-2.6 2.6-.3-1.7-.9-2.3-2.6-2.6 1.7-.3 2.3-.9 2.6-2.6Z" />
    </>
  ),
};

export interface IconProps {
  name: IconName;
  label?: string;
  className?: string;
}

export function Icon({ name, label, className }: IconProps): ReactElement {
  const decorative = label === undefined;
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden={decorative ? true : undefined}
      role={decorative ? undefined : 'img'}
      aria-label={label}
    >
      {PATHS[name]}
    </svg>
  );
}
