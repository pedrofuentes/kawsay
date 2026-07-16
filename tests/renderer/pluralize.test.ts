// The shared "is it exactly one?" branch (#436) behind every count-driven phrase
// in the renderer (Search's result total, Collections' member count, ImportStep's
// summary, UndoBanner, SuggestionsTray).
import { describe, expect, it } from 'vitest';
import { pluralize } from '@renderer/lib/pluralize';

describe('pluralize', () => {
  it('picks the singular form for a count of exactly 1', () => {
    expect(pluralize(1, 'memory', 'memories')).toBe('memory');
  });

  it('picks the plural form for 0', () => {
    expect(pluralize(0, 'memory', 'memories')).toBe('memories');
  });

  it('picks the plural form for any count greater than 1', () => {
    expect(pluralize(2, 'memory', 'memories')).toBe('memories');
    expect(pluralize(128, 'memory', 'memories')).toBe('memories');
  });

  it('works with whole verb phrases, not just a bare noun', () => {
    expect(pluralize(1, 'memory is', 'memories are')).toBe('memory is');
    expect(pluralize(3, 'memory is', 'memories are')).toBe('memories are');
  });

  it('never singularizes a negative count (defensive: -1 is not "exactly one")', () => {
    expect(pluralize(-1, 'memory', 'memories')).toBe('memories');
  });
});
