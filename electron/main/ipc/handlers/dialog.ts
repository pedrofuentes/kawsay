import {
  DIALOG_OPEN_DIRECTORY,
  DIALOG_OPEN_FILE,
  ipcContract,
  type IpcRequest,
  type IpcResponse,
} from '@shared/ipc/contract';

/**
 * The native open-dialog capability the handlers need, narrowed to a structural
 * subset of Electron's `dialog.showOpenDialog` so this module unit-tests without
 * an Electron runtime (the real binding lives in electron/main/index.ts). The
 * caller has already bound it to the focused window; the handler only chooses
 * the (hardcoded) `properties` and forwards the whitelisted options.
 */
export interface OpenDialogResultLike {
  readonly canceled: boolean;
  readonly filePaths: readonly string[];
}
export interface OpenDialogOptionsLike {
  readonly title?: string;
  readonly defaultPath?: string;
  readonly properties: ('openDirectory' | 'openFile')[];
}
export type ShowOpenDialog = (options: OpenDialogOptionsLike) => Promise<OpenDialogResultLike>;

export interface DialogHandlerDeps {
  readonly showOpenDialog: ShowOpenDialog;
}

/** Whitelisted renderer-supplied options (already zod-validated by the contract). */
type DialogOpenRequest = IpcRequest<typeof DIALOG_OPEN_DIRECTORY>;

/**
 * Build the options actually handed to `showOpenDialog`. `properties` is fixed by
 * the handler — the renderer can NEVER choose it — and only the two whitelisted
 * keys are copied across, and only when set (no `undefined` keys leak through).
 */
function buildOptions(
  property: 'openDirectory' | 'openFile',
  request: DialogOpenRequest,
): OpenDialogOptionsLike {
  const options: {
    title?: string;
    defaultPath?: string;
    properties: ['openDirectory' | 'openFile'];
  } = {
    properties: [property],
  };
  if (request.title !== undefined) {
    options.title = request.title;
  }
  if (request.defaultPath !== undefined) {
    options.defaultPath = request.defaultPath;
  }
  return options;
}

/** The selected absolute path, or null when the user cancelled / chose nothing. */
async function openWith(
  deps: DialogHandlerDeps,
  property: 'openDirectory' | 'openFile',
  request: DialogOpenRequest,
): Promise<string | null> {
  const result = await deps.showOpenDialog(buildOptions(property, request));
  const [first] = result.filePaths;
  return result.canceled || first === undefined ? null : first;
}

/**
 * `dialog:openDirectory` handler logic: prompt for a single folder, returning the
 * chosen absolute path (or null on cancel), shaped to the contract's response.
 */
export async function handleOpenDirectory(
  deps: DialogHandlerDeps,
  request: DialogOpenRequest,
): Promise<IpcResponse<typeof DIALOG_OPEN_DIRECTORY>> {
  const path = await openWith(deps, 'openDirectory', request);
  return ipcContract[DIALOG_OPEN_DIRECTORY].response.parse(path);
}

/**
 * `dialog:openFile` handler logic: prompt for a single file (e.g. an export
 * archive), returning the chosen absolute path (or null on cancel).
 */
export async function handleOpenFile(
  deps: DialogHandlerDeps,
  request: DialogOpenRequest,
): Promise<IpcResponse<typeof DIALOG_OPEN_FILE>> {
  const path = await openWith(deps, 'openFile', request);
  return ipcContract[DIALOG_OPEN_FILE].response.parse(path);
}
