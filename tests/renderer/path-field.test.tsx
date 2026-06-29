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

    expect(api.openDirectory).toHaveBeenCalledWith({
      title: 'Folder for memories',
      defaultPath: undefined,
    });
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

    expect(api.openFile).toHaveBeenCalledWith({
      title: 'WhatsApp file',
      defaultPath: undefined,
    });
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

    expect(api.openDirectory).toHaveBeenCalledWith({ title: 'Folder', defaultPath: '/keep/me' });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('uses browseTitle as the dialog title while defaulting to the current path', async () => {
    const api = makeFakeApi({ openDirectory: vi.fn(() => Promise.resolve('/new/path')) });
    const onChange = vi.fn();
    renderWithApi(
      <PathField
        label="Folder"
        value="/current/path"
        onChange={onChange}
        browseFor="directory"
        browseTitle="Choose the memory folder"
      />,
      api,
    );

    await userEvent.click(screen.getByRole('button', { name: /browse/i }));

    expect(api.openDirectory).toHaveBeenCalledWith({
      title: 'Choose the memory folder',
      defaultPath: '/current/path',
    });
    expect(onChange).toHaveBeenCalledWith('/new/path');
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

  it('handles a rejected picker calmly: keeps the field, shows a gentle inline error, no crash (#115)', async () => {
    // The native dialog rarely fails, but if its IPC rejects the await must not
    // become an unhandled rejection that leaves the user with no feedback.
    const openDirectory = vi.fn(() => Promise.reject(new Error('EACCES: native dialog failed')));
    const api = makeFakeApi({ openDirectory });
    const onChange = vi.fn();
    renderWithApi(
      <PathField label="Folder" value="/keep/me" onChange={onChange} browseFor="directory" />,
      api,
    );

    await userEvent.click(screen.getByRole('button', { name: /browse/i }));

    // A calm, non-technical message is announced — never the raw OS error.
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/couldn't open/i);
    expect(alert).not.toHaveTextContent(/EACCES/);
    // The field is left exactly as the user had it, and onChange never fires.
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Folder')).toHaveValue('/keep/me');
    // The message is associated with the input for screen-reader users.
    const input = screen.getByLabelText('Folder');
    expect(input.getAttribute('aria-describedby') ?? '').toContain(alert.id);
  });

  it('handles a rejected FILE picker the same calm way (#115)', async () => {
    const openFile = vi.fn(() => Promise.reject(new Error('dialog unavailable')));
    const api = makeFakeApi({ openFile });
    const onChange = vi.fn();
    const { container } = renderWithApi(
      <PathField label="WhatsApp file" value="/prior.zip" onChange={onChange} browseFor="file" />,
      api,
    );

    await userEvent.click(screen.getByRole('button', { name: /browse/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/couldn't open/i);
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByLabelText('WhatsApp file')).toHaveValue('/prior.zip');
    await expectNoAxeViolations(container);
  });

  it('recovers when a retried Browse succeeds: clears the error and fills the field (#115)', async () => {
    const openDirectory = vi
      .fn()
      .mockRejectedValueOnce(new Error('dialog hiccup'))
      .mockResolvedValueOnce('/Users/elena/Memories');
    const api = makeFakeApi({ openDirectory });
    const onChange = vi.fn();
    renderWithApi(
      <PathField label="Folder" value="" onChange={onChange} browseFor="directory" />,
      api,
    );

    await userEvent.click(screen.getByRole('button', { name: /browse/i }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /browse/i }));

    expect(onChange).toHaveBeenCalledWith('/Users/elena/Memories');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('clears a stale Browse error as soon as the user types a path instead of retrying (#127)', async () => {
    const openDirectory = vi.fn(() => Promise.reject(new Error('dialog hiccup')));
    const api = makeFakeApi({ openDirectory });
    const onChange = vi.fn();
    renderWithApi(
      <PathField label="Folder" value="/keep/me" onChange={onChange} browseFor="directory" />,
      api,
    );

    await userEvent.click(screen.getByRole('button', { name: /browse/i }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('Folder'), '/typed');

    expect(onChange).toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
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
