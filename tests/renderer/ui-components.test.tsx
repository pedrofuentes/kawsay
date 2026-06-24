import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Button } from '@renderer/components/Button';
import { SourceCard } from '@renderer/components/SourceCard';
import { StepIndicator } from '@renderer/components/StepIndicator';
import { ProgressBar } from '@renderer/components/ProgressBar';
import { EmptyState } from '@renderer/components/EmptyState';
import { ErrorBanner } from '@renderer/components/ErrorBanner';
import { PrivacyBadge } from '@renderer/components/PrivacyBadge';
import { PathField } from '@renderer/components/PathField';
import { ReassuranceNote } from '@renderer/components/ReassuranceNote';

describe('Button', () => {
  it('renders a real button, defaulting type to "button"', () => {
    render(<Button>Start bringing memories</Button>);
    const button = screen.getByRole('button', { name: 'Start bringing memories' });
    expect(button).toHaveAttribute('type', 'button');
  });

  it('fires onClick when activated and tags its variant for styling', async () => {
    const onClick = vi.fn();
    render(
      <Button variant="primary" onClick={onClick}>
        Continue
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Continue' });
    expect(button).toHaveAttribute('data-variant', 'primary');
    await userEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('does not fire onClick while disabled', async () => {
    const onClick = vi.fn();
    render(
      <Button onClick={onClick} disabled>
        Continue
      </Button>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe('SourceCard', () => {
  it('renders a labelled, selectable card with title and plain description', async () => {
    const onSelect = vi.fn();
    render(
      <SourceCard
        title="WhatsApp chats"
        description="Messages, voice notes, photos & videos"
        onSelect={onSelect}
      />,
    );
    const card = screen.getByRole('button', { name: /WhatsApp chats/ });
    expect(card).toHaveTextContent('Messages, voice notes, photos & videos');
    await userEvent.click(card);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});

describe('StepIndicator', () => {
  it('announces the position as "Step X of N"', () => {
    render(<StepIndicator current={2} total={4} />);
    expect(screen.getByText(/Step 2 of 4/i)).toBeInTheDocument();
  });
});

describe('ProgressBar', () => {
  it('exposes determinate progress to assistive tech', () => {
    render(<ProgressBar value={62} max={100} label="Reading WhatsApp" valueText="62 percent" />);
    const bar = screen.getByRole('progressbar', { name: 'Reading WhatsApp' });
    expect(bar).toHaveAttribute('aria-valuenow', '62');
    expect(bar).toHaveAttribute('aria-valuemin', '0');
    expect(bar).toHaveAttribute('aria-valuemax', '100');
    expect(bar).toHaveAttribute('aria-valuetext', '62 percent');
  });
});

describe('EmptyState', () => {
  it('renders a warm heading plus the one helpful next action', () => {
    render(
      <EmptyState
        title="Elena's library is ready."
        description="Let's bring in the first memories."
        action={<Button>Add memories</Button>}
      />,
    );
    expect(screen.getByRole('heading', { name: /Elena's library is ready\./ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add memories' })).toBeInTheDocument();
  });
});

describe('ErrorBanner', () => {
  it('shows a plain-language message in an alert region with an optional retry', async () => {
    const onRetry = vi.fn();
    render(
      <ErrorBanner
        message="We can't save to that folder. Let's pick another place."
        onRetry={onRetry}
        retryLabel="Try again"
      />,
    );
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent("We can't save to that folder. Let's pick another place.");
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

describe('PrivacyBadge', () => {
  it('states the verbatim reassurance in the step-footer variant', () => {
    render(<PrivacyBadge variant="step-footer" />);
    expect(screen.getByText(/never leave this computer/i)).toBeInTheDocument();
  });

  it('shows the compact "Private & on this computer" in the status-bar variant', () => {
    render(<PrivacyBadge variant="status-bar" />);
    expect(screen.getByText(/Private & on this computer/i)).toBeInTheDocument();
  });
});

describe('PathField', () => {
  it('associates its label with the input and reports edits', async () => {
    const onChange = vi.fn();
    render(
      <PathField
        label="Where should we keep these memories?"
        value=""
        onChange={onChange}
        helper="This is a private folder on your computer."
      />,
    );
    const input = screen.getByLabelText('Where should we keep these memories?');
    expect(screen.getByText('This is a private folder on your computer.')).toBeInTheDocument();
    await userEvent.type(input, '/x');
    expect(onChange).toHaveBeenCalled();
  });
});

describe('ReassuranceNote', () => {
  it('renders gentle micro-copy', () => {
    render(<ReassuranceNote>You can come back anytime — nothing will be lost.</ReassuranceNote>);
    expect(
      screen.getByText('You can come back anytime — nothing will be lost.'),
    ).toBeInTheDocument();
  });
});
