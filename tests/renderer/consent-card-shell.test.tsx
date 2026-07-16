// Focused unit test for the shared consent-card "face-machine" shell (#436) that
// SmartSearchConsent and TranscriptionConsent both build on. Each card's own
// test file already covers its wired behaviour end to end; this locks the
// shell's standalone contract (the icon/heading/subtitle intro and the one
// global switch) independent of either card's copy or state machine.
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConsentCardShell } from '@renderer/components/ConsentCardShell';

describe('ConsentCardShell', () => {
  it('labels the card region from the heading and shows the title/subtitle', () => {
    render(
      <ConsentCardShell
        headingId="h"
        icon="search"
        title="Find memories by what they're about"
        subtitle="On-device smart search — entirely optional."
        switchLabelId="l"
        switchStatusId="s"
        switchLabel="Search by meaning"
        switchStatus="Off. You can turn this back on whenever you like."
        on={false}
        switchDisabled
        onToggle={vi.fn()}
      >
        <p>face content</p>
      </ConsentCardShell>,
    );
    expect(
      screen.getByRole('region', { name: "Find memories by what they're about" }),
    ).toBeInTheDocument();
    expect(screen.getByText('On-device smart search — entirely optional.')).toBeInTheDocument();
    expect(screen.getByText('face content')).toBeInTheDocument();
  });

  it('exposes the toggle as an accessible switch reflecting on/off + disabled state', () => {
    render(
      <ConsentCardShell
        headingId="h"
        icon="audio"
        title="Turn voice notes into words you can read"
        subtitle="On-device transcription."
        switchLabelId="l"
        switchStatusId="s"
        switchLabel="Transcribe audio & video"
        switchStatus="On."
        on
        switchDisabled={false}
        onToggle={vi.fn()}
      >
        <p>ready</p>
      </ConsentCardShell>,
    );
    const toggle = screen.getByRole('switch', { name: /transcribe audio/i });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(toggle).not.toBeDisabled();
  });

  it('fires onToggle when the switch is activated', async () => {
    const onToggle = vi.fn();
    render(
      <ConsentCardShell
        headingId="h"
        icon="search"
        title="Title"
        subtitle="Subtitle"
        switchLabelId="l"
        switchStatusId="s"
        switchLabel="Switch"
        switchStatus="Status"
        on={false}
        switchDisabled={false}
        onToggle={onToggle}
      >
        <p>face</p>
      </ConsentCardShell>,
    );
    await userEvent.click(screen.getByRole('switch'));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
