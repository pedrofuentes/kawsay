// Pure, layout-free windowing maths for the virtualized timeline (AC-8). Given a
// scroll offset and a fixed row height, it returns the bounded slice of rows to
// mount plus the spacer heights that keep the scrollbar faithful to the full
// list. It deliberately knows nothing about React or the DOM so it can be unit
// tested directly and reused by any fixed-height virtual list.

export interface VirtualWindowInput {
  /** Current scroll offset of the viewport, in pixels. */
  scrollTop: number;
  /** Measured height of the visible viewport, in pixels (0 before measurement). */
  viewportHeight: number;
  /** Fixed height of every row, in pixels. Must be > 0. */
  rowHeight: number;
  /** Total number of rows in the (virtual) list. */
  rowCount: number;
  /** Extra rows mounted above and below the viewport to smooth fast scrolls. */
  overscan: number;
}

export interface VirtualWindow {
  /** First row to mount (inclusive). */
  startIndex: number;
  /** One past the last row to mount (exclusive). */
  endIndex: number;
  /** Spacer height above the mounted slice, in pixels. */
  topPad: number;
  /** Spacer height below the mounted slice, in pixels. */
  bottomPad: number;
  /** Full scrollable height of the entire list, in pixels. */
  totalHeight: number;
}

/**
 * Compute the bounded window of rows to render. The mounted count depends only on
 * the viewport height, row height, and overscan — never on `rowCount` — so the
 * DOM stays bounded as the library grows to tens of thousands of items (AC-8).
 */
export function computeVirtualWindow(input: VirtualWindowInput): VirtualWindow {
  const { scrollTop, viewportHeight, rowHeight, rowCount, overscan } = input;

  if (rowCount <= 0 || rowHeight <= 0) {
    return { startIndex: 0, endIndex: 0, topPad: 0, bottomPad: 0, totalHeight: 0 };
  }

  const totalHeight = rowCount * rowHeight;
  const safeScrollTop = Math.min(Math.max(0, scrollTop), totalHeight);
  const safeViewport = Math.max(0, viewportHeight);
  const safeOverscan = Math.max(0, Math.floor(overscan));

  const firstVisible = Math.floor(safeScrollTop / rowHeight);
  const visibleRows = Math.ceil(safeViewport / rowHeight);

  const startIndex = Math.max(0, firstVisible - safeOverscan);
  const endIndex = Math.min(rowCount, firstVisible + visibleRows + safeOverscan);

  return {
    startIndex,
    endIndex,
    topPad: startIndex * rowHeight,
    bottomPad: Math.max(0, (rowCount - endIndex) * rowHeight),
    totalHeight,
  };
}
