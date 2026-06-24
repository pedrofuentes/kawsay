import { realpathSync } from 'node:fs';
import { normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface TrustedSenderOptions {
  /**
   * Absolute filesystem path of the packaged renderer entry (the resolved
   * `out/renderer/index.html` under the app root). A `file://` sender is trusted
   * ONLY when its real path equals this. Absent ⇒ NO `file://` sender is trusted.
   */
  readonly rendererEntryPath?: string | undefined;
  /**
   * When the renderer is served by the Vite dev server, its http origin is also
   * trusted. Absent in production, where ONLY the renderer entry is accepted.
   */
  readonly devServerUrl?: string | undefined;
}

/**
 * Decide whether an IPC message's sender frame may be trusted (ARCHITECTURE
 * §2.3). The packaged renderer is the single `file://` document we trust — and
 * ONLY that exact file, never any other local document, since an attacker can
 * drop HTML on disk that also loads over `file://`. In development the
 * configured dev-server origin is trusted instead. Everything else — remote
 * origins, sibling local files, opaque or malformed URLs — is rejected. Never
 * throws.
 */
export function isTrustedSenderUrl(senderUrl: string, options: TrustedSenderOptions = {}): boolean {
  const url = tryParseUrl(senderUrl);
  if (url === null) {
    return false;
  }
  if (url.protocol === 'file:') {
    return isPackagedRendererEntry(url, options.rendererEntryPath);
  }
  if (options.devServerUrl !== undefined) {
    const devServer = tryParseUrl(options.devServerUrl);
    return devServer !== null && url.origin === devServer.origin;
  }
  return false;
}

/**
 * True only when `url` resolves to exactly the configured packaged renderer
 * entry. Any other local file — including siblings inside the app directory —
 * is rejected, so attacker-dropped HTML can never impersonate the renderer.
 */
function isPackagedRendererEntry(url: URL, rendererEntryPath: string | undefined): boolean {
  if (rendererEntryPath === undefined) {
    return false;
  }
  let senderPath: string;
  try {
    senderPath = fileURLToPath(url);
  } catch {
    return false;
  }
  return canonicalPath(senderPath) === canonicalPath(rendererEntryPath);
}

/**
 * Resolve symlinks and `..` segments so the comparison is on real paths; fall
 * back to a lexical normalise when the path does not exist on disk.
 */
function canonicalPath(value: string): string {
  try {
    return realpathSync.native(value);
  } catch {
    return normalize(value);
  }
}

function tryParseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}
