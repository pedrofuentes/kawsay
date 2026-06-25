import { describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PathField } from '@renderer/components/PathField';
import { KawsayApiProvider } from '@renderer/lib/kawsay-api';
import { makeFakeApi, type FakeApi } from './support/fake-api';
import { expectNoAxeViolations } from './support/axe';

/** Render a PathField inside the api provider (a fake bridge, like Electron). */
function renderWithApi(ui: ReactElement, api: FakeApi) {
  return render(<KawsayApiProvider api={api}>{ui}</KawsayApiProvider>);
}

describe('PathField — Browse… native picker (W2, AC-12 usability)', () => {
  it('shows a Browse button that opens the folder picker and fills the field', async () => {
    const api = makeFakeApi({ openDirectory: vi.fn(() => Promise.resolve('/Users/elena/Memories')) });
    const onChange = vi.fn();
    renderWithApi(
      <PathField label="Folder for memories" value="" onChange={onChange} browseFor="directory" />,
      api,
    );

    await userEvent.click(screen.getByRole('button', { name: /browse/i }));

    expect(api.openDirectory).toHaveBeenCalledTimes(1);
    expect(api.openFile).not.toHaveBeenCalled();
    expect(onChange).toHaveBeenCalledWith('/Users/elena/Memories');
  });

  it('opens the file picker (not the folder picker) when browseFor="file"', async () => {
    const api = makeFakeApi({ openFile: vi.fn(() => Promise.resolve('/exports/whatsapp.zip')) });
    const onChange = vi.fn();
    renderWithApi(
      <PathField label="WhatsApp file" value="" onChange={onChange} browseFor="file" />,
      api,
    );

    await userEvent.click(screen.getByRole('button', { name: /browse/i }));

    expect(api.openFile).toHaveBeenCalledTimes(1);
    expect(api.openDirectory).not.toHaveBeenCalled();
    expect(onChange).toHaveBeenCalledWith('/exports/whatsapp.zip');
  });

  it('leaves the field unchanged when the user cancels the picker (null)', async () => {
    const api = makeFakeApi({ openDirectory: vi.fn(() => Promise.resolve(null)) });
    const onChange = vi.fn();
    renderWithApi(
      <PathField label="Folder" value="/keep/me" onChange={onChange} browseFor="directory" />,
      api,
    );

    await userEvent.click(screen.getByRole('button', { name: /browse/i }));

    expect(api.openDirectory).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('keeps typing as a fallback — the text input still reports edits', async () => {
    const api = makeFakeApi();
    const onChange = vi.fn();
    renderWithApi(
      <PathField label="Folder" value="" onChange={onChange} browseFor="directory" />,
      api,
    );

    await userEvent.type(screen.getByLabelText('Folder'), '/typed/path');

    expect(onChange).toHaveBeenCalled();
  });

  it('tolerates a missing bridge (browser preview): no Browse button, no crash, typing works', async () => {
    const onChange = vi.fn();
    // No provider ⇒ useKawsayApi() is undefined, exactly like a plain browser preview.
    render(<PathField label="Folder" value="" onChange={onChange} browseFor="directory" />);

    expect(screen.queryByRole('button', { name: /browse/i })).toBeNull();
    await userEvent.type(screen.getByLabelText('Folder'), '/typed');
    expect(onChange).toHaveBeenCalled();
  });

  it('renders NO Browse button when browseFor is omitted (e.g. the loved one\'s name field)', () => {
    const api = makeFakeApi();
    renderWithApi(<PathField label="Their name" value="" onChange={() => {}} />, api);

    expect(screen.queryByRole('button', { name: /browse/i })).toBeNull();
  });

  it('exposes an accessible, keyboard-operable Browse control with zero axe violations', async () => {
    const api = makeFakeApi({ openDirectory: vi.fn(() => Promise.resolve('/picked')) });
    const onChange = vi.fn();
    const { container } = renderWithApi(
      <PathField label="Folder for memories" value="" onChange={onChange} browseFor="directory" />,
      api,
    );

    const browse = screen.getByRole('button', { name: /browse/i });
    expect(browse).toHaveAccessibleName();

    // Keyboard-operable: focus then activate with Enter (a real <button>).
    browse.focus();
    expect(browse).toHaveFocus();
    await userEvent.keyboard('{Enter}');

    expect(api.openDirectory).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('/picked');
    await expectNoAxeViolations(container);
  });
});
