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
import { ImportStep } from '@renderer/onboarding/steps/ImportStep';
import type { ImportState } from '@renderer/lib/use-import';
import type { SkippedItemDTO } from '@shared/kawsay-api';
import { makeImportSummary } from './support/fake-api';
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
    const { container } = render(<SkippedItemsDisclosure items={ITEMS} />);
    const toggle = screen.getByRole('button', { name: /see which ones/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    // Collapsed content is hidden from assistive tech entirely (native `hidden`),
    // exactly like a closed <details> — not merely visually hidden.
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
    // Deferral: the O(n) list rows are not even MOUNTED while collapsed, so a
    // large export pays no up-front DOM cost at import-complete.
    expect(container.querySelectorAll('li')).toHaveLength(0);
  });

  it('keeps its aria-controls target present but empty while collapsed, then fills it on expand', async () => {
    const user = userEvent.setup();
    const { container } = render(<SkippedItemsDisclosure items={ITEMS} />);
    const toggle = screen.getByRole('button', { name: /see which ones/i });

    // The container the toggle controls must always exist so `aria-controls`
    // never dangles — even though its rows are deferred until expansion.
    const controlledId = toggle.getAttribute('aria-controls');
    expect(controlledId).toBeTruthy();
    // `useId()` ids contain colons, so resolve by id rather than a CSS selector.
    const controlled = document.getElementById(controlledId as string);
    expect(controlled).not.toBeNull();
    expect(container.querySelectorAll('li')).toHaveLength(0);

    await user.click(toggle);
    expect(container.querySelectorAll('li')).toHaveLength(ITEMS.length);
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
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
  });

  it('has no WCAG 2.1 AA axe violations, collapsed or expanded', async () => {
    const user = userEvent.setup();
    const { container } = render(<SkippedItemsDisclosure items={ITEMS} />);
    await expectNoAxeViolations(container);

    await user.click(screen.getByRole('button', { name: /see which ones/i }));
    await expectNoAxeViolations(container);
  });
});

describe('SkippedItemsDisclosure wired into the import summary (ImportStep)', () => {
  function completedState(skipped: SkippedItemDTO[]): ImportState {
    return {
      status: 'complete',
      jobId: 'job-1',
      processed: 312,
      total: 312,
      message: null,
      phase: 'done',
      summary: makeImportSummary({ occurrencesAdded: 312, skipped }),
      error: null,
    };
  }

  function renderComplete(skipped: SkippedItemDTO[]) {
    return render(
      <ImportStep
        personName="Elena"
        state={completedState(skipped)}
        onCancel={() => {}}
        onRetry={() => {}}
        onSeeEverything={() => {}}
      />,
    );
  }

  it('offers the disclosure on a completed import that has skips, alongside the aggregate note', async () => {
    const user = userEvent.setup();
    renderComplete([
      { ref: 'photos/IMG_1.heic', reason: 'partial metadata unavailable', code: 'E_EXIF' },
      { ref: 'msgs/att_9.dat', reason: 'attachment missing', code: 'E_MISSING_ATTACHMENT' },
    ]);

    // The existing warm count + aggregate reassurance are still present…
    expect(screen.getByText(/312/)).toBeInTheDocument();
    // …and the per-item disclosure now sits beside them, reachable and expandable.
    const toggle = screen.getByRole('button', { name: /see which ones/i });
    await user.click(toggle);
    const list = screen.getByRole('list');
    expect(within(list).getByText('IMG_1.heic')).toBeInTheDocument();
    expect(within(list).getByText('att_9.dat')).toBeInTheDocument();
    expect(within(list).getByText(/an attached file .* wasn.t in the export/i)).toBeInTheDocument();
  });

  it('shows NO disclosure on a completed import with zero skips', () => {
    renderComplete([]);
    expect(screen.getByText(/312/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /see which ones/i })).not.toBeInTheDocument();
  });
});
