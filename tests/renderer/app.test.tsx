import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { App } from '@renderer/App';

describe('App (composed renderer)', () => {
  it('renders the first-run welcome inside a main landmark, tolerating no api bridge', () => {
    const original = (window as { kawsayAPI?: unknown }).kawsayAPI;
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete (window as { kawsayAPI?: unknown }).kawsayAPI;
    try {
      render(<App />);
      expect(screen.getByRole('main')).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: /start bringing memories/i }),
      ).toBeInTheDocument();
    } finally {
      if (original !== undefined) (window as { kawsayAPI?: unknown }).kawsayAPI = original;
    }
  });
});
