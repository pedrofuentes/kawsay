import { realpathSync } from 'node:fs';
import { posix, win32 } from 'node:path';
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
  /**
   * Platform whose path semantics govern the `file://` comparison. Defaults to
   * the host platform (`process.platform`); injectable so the Windows path
   * identity is testable on POSIX hosts and on CI. On `win32` the filesystem is
   * case-insensitive, so paths are compared case-insensitively with `\`/`/`
   * normalised; on POSIX the comparison stays case-sensitive.
   */
  readonly platform?: NodeJS.Platform | undefined;
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
    return isPackagedRendererEntry(
      url,
      options.rendererEntryPath,
      options.platform ?? process.platform,
    );
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
 * Both sides are reduced to canonical real paths under the active platform's
 * semantics before comparison, so `file:///C:/app/...` matches `C:\app\...` on
 * Windows without ever trusting a distinct path.
 */
function isPackagedRendererEntry(
  url: URL,
  rendererEntryPath: string | undefined,
  platform: NodeJS.Platform,
): boolean {
  if (rendererEntryPath === undefined) {
    return false;
  }
  const senderPath = canonicalFileUrl(url, platform);
  const entryPath = canonicalPath(rendererEntryPath, platform);
  return samePath(senderPath, entryPath, platform);
}

/**
 * Convert a `file://` URL to a canonical real path for the given platform.
 * `fileURLToPath` decodes percent-escapes and maps `file:///C:/…` → `C:\…` on
 * Windows; a URL that is not a valid path on that platform yields `null` so it
 * can never match (fail-closed).
 */
function canonicalFileUrl(url: URL, platform: NodeJS.Platform): string | null {
  let filePath: string;
  try {
    filePath = fileURLToPath(url, { windows: platform === 'win32' });
  } catch {
    return null;
  }
  return canonicalPath(filePath, platform);
}

/**
 * Resolve symlinks and `..` segments so the comparison is on real paths; fall
 * back to a lexical normalise (in the platform's flavour) when the path does
 * not exist on disk. The fallback is symmetric — both candidates get identical
 * treatment — so a distinct attacker path can never normalise into the entry.
 */
function canonicalPath(value: string, platform: NodeJS.Platform): string {
  const platformPath = platform === 'win32' ? win32 : posix;
  let resolved: string;
  try {
    resolved = realpathSync.native(value);
  } catch {
    resolved = value;
  }
  return platformPath.normalize(resolved);
}

/**
 * Path identity under the active platform: case-insensitive on Windows (the
 * NTFS reality, drive letter included), case-sensitive on POSIX. A `null`
 * (unconvertible) path never matches.
 */
function samePath(a: string | null, b: string | null, platform: NodeJS.Platform): boolean {
  if (a === null || b === null) {
    return false;
  }
  return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function tryParseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}
