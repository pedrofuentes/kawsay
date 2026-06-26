// A defense-in-depth guard for the media subprocess seam (AC-4, ARCHITECTURE
// §7.2). ffprobe/ffmpeg are fed paths discovered by walking the user's chosen
// folders, but F3c makes those tools renderer-reachable through the import flow.
// The top-level input handed to them must always be a LOCAL filesystem path,
// never a URL or a Windows UNC/device path — otherwise a crafted path could steer
// ffmpeg/ffprobe onto a remote protocol or SMB/CIFS share and egress, which the
// app has no OS-level firewall to stop at the user's runtime. This pairs with
// `-protocol_whitelist file` (which blocks EMBEDDED external references inside a
// crafted local container).

/** A typed refusal: a media subprocess input was a URL or remote/UNC path, not a local file. */
export class NonLocalMediaPathError extends Error {
  constructor(path: string) {
    super(`media subprocess input must be a local file, not a URL or UNC/device path: ${path}`);
    this.name = 'NonLocalMediaPathError';
  }
}

// A leading `scheme://` (e.g. http://, https://, ftp://, rtmp://, file://). A
// Windows drive path (`C:\…` or `C:/…`) has only a single slash after the colon
// and so is correctly treated as local.
const URL_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

// Two leading separators mark a Windows UNC path (`\\host\share\…` and its
// forward-slash `//host/share/…` form) or a device/namespace path (`\\.\dev`,
// `\\?\C:\…`). ffmpeg/ffprobe would reach a remote SMB/CIFS share or a device
// through these, so they egress just like a URL and must be refused. A normal
// POSIX absolute path has a SINGLE leading slash and is unaffected.
const UNC_OR_DEVICE = /^[\\/]{2}/;

/** Throw {@link NonLocalMediaPathError} unless `path` is a local filesystem path. */
export function assertLocalMediaPath(path: string): void {
  if (URL_SCHEME.test(path) || UNC_OR_DEVICE.test(path)) {
    throw new NonLocalMediaPathError(path);
  }
}
