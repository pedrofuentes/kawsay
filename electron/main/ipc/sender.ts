export interface TrustedSenderOptions {
  /**
   * When the renderer is served by the Vite dev server, its http origin is also
   * trusted. Absent in production, where ONLY `file://` is accepted.
   */
  readonly devServerUrl?: string | undefined;
}

/**
 * Decide whether an IPC message's sender frame may be trusted (ARCHITECTURE
 * §2.3). The packaged renderer is served from `file://`; in development it is
 * the configured dev-server origin. Everything else — remote origins, opaque
 * or malformed URLs — is rejected. Never throws.
 */
export function isTrustedSenderUrl(senderUrl: string, options: TrustedSenderOptions = {}): boolean {
  const url = tryParseUrl(senderUrl);
  if (url === null) {
    return false;
  }
  if (url.protocol === 'file:') {
    return true;
  }
  if (options.devServerUrl !== undefined) {
    const devServer = tryParseUrl(options.devServerUrl);
    return devServer !== null && url.origin === devServer.origin;
  }
  return false;
}

function tryParseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}
