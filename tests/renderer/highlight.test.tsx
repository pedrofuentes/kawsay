// The match-highlighting util extracted from Search.tsx (#436). Everything the
// catalog returns is UNTRUSTED data, so this must always render escaped text —
// never markup — even for a caption that looks like it contains HTML (AC-4
// posture; USER_FLOWS rubric R12).
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { highlight } from '@renderer/lib/highlight';

describe('highlight', () => {
  it('returns the plain text unchanged when the term is empty or blank', () => {
    expect(highlight('Beach picnic', '')).toBe('Beach picnic');
    expect(highlight('Beach picnic', '   ')).toBe('Beach picnic');
  });

  it('wraps a single case-insensitive match in a <mark>', () => {
    const { container } = render(<>{highlight('Beach picnic', 'beach')}</>);
    const mark = container.querySelector('mark');
    expect(mark).not.toBeNull();
    expect(mark).toHaveTextContent('Beach');
    expect(container).toHaveTextContent('Beach picnic');
  });

  it('wraps every occurrence of the term, not just the first', () => {
    const { container } = render(<>{highlight('mama and mama again', 'mama')}</>);
    expect(container.querySelectorAll('mark')).toHaveLength(2);
  });

  it('never turns untrusted markup into a live element — it stays escaped text', () => {
    const { container } = render(<>{highlight('Mama <script>alert(1)</script>', 'mama')}</>);
    expect(container.querySelector('script')).toBeNull();
    expect(container).toHaveTextContent('Mama <script>alert(1)</script>');
    expect(container.querySelector('mark')).not.toBeNull();
  });

  it('renders the text unchanged (no <mark>) when the term does not occur', () => {
    const { container } = render(<>{highlight('Beach picnic', 'zzz')}</>);
    expect(container.querySelector('mark')).toBeNull();
    expect(container).toHaveTextContent('Beach picnic');
  });
});
