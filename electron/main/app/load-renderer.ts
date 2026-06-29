export interface RendererLoadableWindow {
  loadFile(path: string): Promise<void>;
  loadURL(url: string): Promise<void>;
}

export interface LoadRendererOptions {
  rendererEntryPath: string;
  rendererDevUrl?: string | undefined;
  onLoadFailure: (error: unknown) => void;
}

export async function loadRenderer(
  window: RendererLoadableWindow,
  options: LoadRendererOptions,
): Promise<void> {
  try {
    if (options.rendererDevUrl === undefined) {
      await window.loadFile(options.rendererEntryPath);
    } else {
      await window.loadURL(options.rendererDevUrl);
    }
  } catch (error) {
    options.onLoadFailure(error);
  }
}
