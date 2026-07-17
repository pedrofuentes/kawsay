import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BrandMark } from '@renderer/components/BrandMark';
import { expectNoAxeViolations } from './support/axe';

describe('BrandMark', () => {
  it('renders as an svg and forwards className', () => {
    const { container } = render(<BrandMark className="h-7 w-auto text-brand" />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg).toHaveClass('h-7', 'w-auto', 'text-brand');
  });

  it('is decorative by default (hidden from assistive tech, no role)', () => {
    const { container } = render(<BrandMark />);
    const svg = container.querySelector('svg');
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(svg).not.toHaveAttribute('role');
    expect(container.querySelector('title')).toBeNull();
  });

  it('exposes an accessible name when given a label', async () => {
    render(<BrandMark label="Kawsay" />);
    const img = screen.getByRole('img', { name: 'Kawsay' });
    expect(img).toBeInTheDocument();
    expect(img).not.toHaveAttribute('aria-hidden');
    await expectNoAxeViolations(img);
  });
});
