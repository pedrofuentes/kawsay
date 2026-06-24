// A defense-in-depth guard for the media subprocess seam (AC-4, ARCHITECTURE
// §7.2). ffprobe/ffmpeg are fed paths discovered by walking the user's chosen
// folders, but F3c makes those tools renderer-reachable through the import flow.
// The top-level input handed to them must always be a LOCAL filesystem path,
// never a URL — otherwise a crafted path could steer ffmpeg/ffprobe onto a
// remote protocol and egress, which the app has no OS-level firewall to stop at
// the user's runtime. This pairs with `-protocol_whitelist file` (which blocks
// EMBEDDED external references inside a crafted local container).

/** A typed refusal: a media subprocess input was a URL, not a local file. */
export class NonLocalMediaPathError extends Error {
  constructor(path: string) {
    super(`media subprocess input must be a local file, not a URL: ${path}`);
    this.name = 'NonLocalMediaPathError';
  }
}

// A leading `scheme://` (e.g. http://, https://, ftp://, rtmp://, file://). A
// Windows drive path (`C:\…` or `C:/…`) has only a single slash after the colon
// and so is correctly treated as local.
const URL_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

/** Throw {@link NonLocalMediaPathError} unless `path` is a local filesystem path. */
export function assertLocalMediaPath(path: string): void {
  if (URL_SCHEME.test(path)) {
    throw new NonLocalMediaPathError(path);
  }
}
