// The shared page-title recipe (#436) — one focusable <h1> every primary view
// renders through instead of copy-pasting the Tailwind recipe + tabIndex/ref
// wiring. Focus management stays with the caller (most views seed `headingRef`
// from `useAutoFocusHeading`); this component only owns the markup.
import { useRef } from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Heading } from '@renderer/components/Heading';
import { useAutoFocusHeading } from '@renderer/lib/use-auto-focus';

describe('Heading', () => {
  it('renders a single, focusable level-1 heading with its children', () => {
    render(<Heading id="the-heading">Search</Heading>);
    const heading = screen.getByRole('heading', { level: 1, name: 'Search' });
    expect(heading).toHaveAttribute('id', 'the-heading');
    expect(heading).toHaveAttribute('tabindex', '-1');
  });

  it('carries the shared design-system recipe classes', () => {
    render(<Heading>Settings</Heading>);
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading.className).toContain('font-display');
    expect(heading.className).toContain('text-3xl');
    expect(heading.className).toContain('font-semibold');
    expect(heading.className).toContain('text-text-primary');
    expect(heading.className).toContain('outline-none');
  });

  it('receives focus via a ref seeded by useAutoFocusHeading, like every primary view', () => {
    function Host() {
      const headingRef = useAutoFocusHeading<HTMLHeadingElement>();
      return <Heading headingRef={headingRef}>Timeline</Heading>;
    }
    render(<Host />);
    expect(screen.getByRole('heading', { level: 1, name: 'Timeline' })).toHaveFocus();
  });

  it('accepts an externally-managed ref for views with a non-mount-only focus rule', () => {
    function Host() {
      const headingRef = useRef<HTMLHeadingElement>(null);
      return <Heading headingRef={headingRef}>Collections</Heading>;
    }
    render(<Host />);
    // No auto-focus effect is wired here — the caller owns that decision.
    expect(screen.getByRole('heading', { level: 1, name: 'Collections' })).not.toHaveFocus();
  });
});
