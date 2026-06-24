import { describe, expect, it } from 'vitest';
import { computeVirtualWindow } from '@renderer/lib/virtual-window';

// The windowing maths underpin AC-8: the rendered slice must stay bounded and
// must NOT grow with the total row count. These are pure, layout-free assertions
// (jsdom has no layout), so they are the load-bearing evidence for "the DOM holds
// only a bounded/virtualized window whose mounted-node count does not grow with
// item count".
describe('computeVirtualWindow (AC-8 windowing maths)', () => {
  const base = { scrollTop: 0, viewportHeight: 800, rowHeight: 100, overscan: 4 };

  it('renders only a bounded slice, never the whole list', () => {
    const win = computeVirtualWindow({ ...base, rowCount: 10_000 });
    const rendered = win.endIndex - win.startIndex;
    // ceil(800 / 100) visible + overscan on each side = 8 + 8 = 16 rows max.
    expect(rendered).toBeLessThanOrEqual(16);
    expect(rendered).toBeGreaterThan(0);
  });

  it('keeps the mounted-row count identical at 1,000 and 10,000 rows (does not grow with count)', () => {
    const small = computeVirtualWindow({ ...base, rowCount: 1_000 });
    const large = computeVirtualWindow({ ...base, rowCount: 10_000 });
    expect(large.endIndex - large.startIndex).toBe(small.endIndex - small.startIndex);
  });

  it('sizes the full scrollable height to the total row count (so the scrollbar is faithful)', () => {
    const win = computeVirtualWindow({ ...base, rowCount: 10_000 });
    expect(win.totalHeight).toBe(10_000 * 100);
    // Padding above + the rendered slice + padding below spans the whole height.
    const slice = (win.endIndex - win.startIndex) * 100;
    expect(win.topPad + slice + win.bottomPad).toBe(win.totalHeight);
  });

  it('windows around the scroll offset with symmetric overscan', () => {
    const win = computeVirtualWindow({ ...base, scrollTop: 5_000, rowCount: 10_000 });
    // firstVisible = 50; overscan 4 -> start 46.
    expect(win.startIndex).toBe(46);
    expect(win.topPad).toBe(46 * 100);
    expect(win.bottomPad).toBe((10_000 - win.endIndex) * 100);
  });

  it('clamps the window to the list bounds at the very top and very bottom', () => {
    const top = computeVirtualWindow({ ...base, scrollTop: 0, rowCount: 10_000 });
    expect(top.startIndex).toBe(0);
    expect(top.topPad).toBe(0);

    const bottom = computeVirtualWindow({ ...base, scrollTop: 10_000 * 100, rowCount: 10_000 });
    expect(bottom.endIndex).toBe(10_000);
    expect(bottom.bottomPad).toBe(0);
    expect(bottom.startIndex).toBeGreaterThanOrEqual(0);
  });

  it('returns an empty, zero-height window for an empty list', () => {
    const win = computeVirtualWindow({ ...base, rowCount: 0 });
    expect(win).toEqual({ startIndex: 0, endIndex: 0, topPad: 0, bottomPad: 0, totalHeight: 0 });
  });

  it('degrades safely when the viewport has not been measured yet (height 0)', () => {
    const win = computeVirtualWindow({ ...base, viewportHeight: 0, rowCount: 10_000 });
    expect(win.startIndex).toBe(0);
    expect(win.endIndex).toBeGreaterThanOrEqual(0);
    expect(win.endIndex).toBeLessThanOrEqual(10_000);
  });
});
