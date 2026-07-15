// SkippedItemsDisclosure (#430 / AC-15 / P4b — never silently drop items).
// The import summary previously surfaced skipped files only as an aggregate
// count. This component is the "would you like to see which ones?" reveal:
// a labelled, keyboard-accessible toggle that lists every skipped item's
// filename plus a plain-language (reverent, jargon-free) reason mapped from
// its `code`. Written reusable so it can also back the future Add Memories
// view (#427) — hence its own test file, independent of ImportStep.
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SkippedItemsDisclosure } from '@renderer/components/SkippedItemsDisclosure';
import type { SkippedItemDTO } from '@shared/kawsay-api';
import { expectNoAxeViolations } from './support/axe';

const ITEMS: SkippedItemDTO[] = [
  { ref: 'photos/IMG_1.heic', reason: 'partial metadata unavailable: corrupt EXIF', code: 'E_EXIF' },
  { ref: 'clips/VID_2.mov', reason: 'could not probe media: ffprobe exited 1', code: 'E_PROBE' },
  { ref: 'chats/_chat.txt', reason: 'no _chat.txt found in WhatsApp export', code: 'E_NO_CHAT' },
  { ref: 'weird/entry.bin', reason: 'some future failure mode', code: 'E_SOMETHING_NEW_9000' },
  { ref: 'no-code-item.dat', reason: 'unreadable' },
];

describe('SkippedItemsDisclosure', () => {
  it('renders nothing at all for a zero-skip import', () => {
    const { container } = render(<SkippedItemsDisclosure items={[]} />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole('button', { name: /see which ones/i })).not.toBeInTheDocument();
  });

  it('starts collapsed behind a single labelled toggle, not a giant unlabelled blob', () => {
    render(<SkippedItemsDisclosure items={ITEMS} />);
    const toggle = screen.getByRole('button', { name: /see which ones/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('list')).not.toBeVisible();
  });

  it('lists every skipped item with its filename and a plain-language reason when opened', async () => {
    const user = userEvent.setup();
    render(<SkippedItemsDisclosure items={ITEMS} />);
    await user.click(screen.getByRole('button', { name: /see which ones/i }));

    const list = screen.getByRole('list');
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(ITEMS.length);

    // Every filename is shown (basename, not the full nested ref path).
    expect(within(list).getByText('IMG_1.heic')).toBeInTheDocument();
    expect(within(list).getByText('VID_2.mov')).toBeInTheDocument();
    expect(within(list).getByText('_chat.txt')).toBeInTheDocument();
    expect(within(list).getByText('entry.bin')).toBeInTheDocument();
    expect(within(list).getByText('no-code-item.dat')).toBeInTheDocument();

    // Reasons are plain-language, not jargon — never the raw technical `reason`
    // string and never a bare error code (P1).
    expect(screen.queryByText(/ffprobe/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/E_EXIF|E_PROBE|E_NO_CHAT|E_SOMETHING_NEW_9000/)).not.toBeInTheDocument();
    expect(within(list).getByText(/couldn.t read all of its details/i)).toBeInTheDocument();
    expect(within(list).getByText(/couldn.t read its technical details/i)).toBeInTheDocument();
    expect(within(list).getByText(/couldn.t find the conversation file/i)).toBeInTheDocument();

    // An unrecognized code still gets a sensible, reverent fallback reason —
    // never a raw code and never a thrown error.
    const unknownRow = rows.find((row) => within(row).queryByText('entry.bin') !== null);
    expect(unknownRow).toBeDefined();
    expect(within(unknownRow as HTMLElement).getByText(/couldn.t bring this one in/i)).toBeInTheDocument();

    // An item with no code at all also gets a sensible fallback, never blank.
    const noCodeRow = rows.find((row) => within(row).queryByText('no-code-item.dat') !== null);
    expect(noCodeRow).toBeDefined();
    expect(within(noCodeRow as HTMLElement).getByText(/couldn.t bring this one in/i)).toBeInTheDocument();
  });

  it('is keyboard-operable: Tab reaches the toggle, Enter opens it, Space closes it', async () => {
    const user = userEvent.setup();
    render(<SkippedItemsDisclosure items={ITEMS} />);
    const toggle = screen.getByRole('button', { name: /see which ones/i });

    await user.tab();
    expect(toggle).toHaveFocus();

    await user.keyboard('{Enter}');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('list')).toBeVisible();

    await user.keyboard(' ');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('list')).not.toBeVisible();
  });

  it('has no WCAG 2.1 AA axe violations, collapsed or expanded', async () => {
    const user = userEvent.setup();
    const { container } = render(<SkippedItemsDisclosure items={ITEMS} />);
    await expectNoAxeViolations(container);

    await user.click(screen.getByRole('button', { name: /see which ones/i }));
    await expectNoAxeViolations(container);
  });
});
