// On-demand, id-keyed media RESOLUTION for the `kawsay-media:` protocol (#428) —
// the large-file sibling of the bounded-`data:`-URL thumbnail service (ADR-0022).
// A memory is played by its opaque catalog id ONLY; this service does the whole
// privileged resolution main-side:
//
//   1. look up the item's media_type/mime_type by id — only photo/audio/video are
//      playable; everything else short-circuits to null WITHOUT touching disk;
//   2. resolve the original through `resolveServableOriginal`, the §2.4 SERVE-TIME
//      confinement boundary: content-addressed blobs stay under the library root,
//      and an in-place file's REAL path (symlinks resolved) must still sit inside a
//      registered source root the user chose — closing the import→serve TOCTOU. It
//      THROWS on an escaping path rather than handing back one (a renderer-supplied
//      path is impossible — the renderer never provides one);
//   3. return the confined absolute path + a content-type, so the protocol handler
//      can stream the LOCAL file (with range support) and never opens a socket
//      (AC-4).
//
// Pure Node (no Electron), so the resolve→confine path unit-tests under Vitest
// exactly as in production — mirroring the thumbnail service.
import { resolveServableOriginal } from './originals-store';
import type { CatalogDatabase } from '../db/connection';
import type { MediaType } from '@shared/catalog';

/** The media kinds that can be served as bytes for playback / full-size viewing. */
const PLAYABLE_MEDIA: ReadonlySet<MediaType> = new Set<MediaType>(['photo', 'audio', 'video']);

/** A resolved, confined media file ready to stream — PINNED by an open fd (never a
 *  path), so the file that was validated is the exact file that is streamed. */
export interface MediaFileDescriptor {
  /** An open, read-only fd on the confined regular file. The CALLER must close it. */
  fd: number;
  /** The file size from `fstat` on the same fd (drives Content-Length / Range). */
  size: number;
  /** The content-type to serve (stored mime, else derived from the extension). */
  mimeType: string;
  mediaType: MediaType;
}

export interface MediaFileServiceOptions {
  db: CatalogDatabase;
  /** Absolute library root — the confinement anchor for original resolution. */
  root: string;
}

export interface MediaFileService {
  /**
   * Resolve one memory's confined original by opaque id, PINNED by an open fd, plus
   * its size + content-type — or null (unknown id, non-playable media, or no
   * surviving/servable/on-disk original). THROWS — exactly like {@link
   * resolveServableOriginal} — if the resolved path would escape its servable roots
   * or is not a regular file (a bad content-address, or an in-place symlink swap), so
   * a hostile row can never yield a servable file. The CALLER owns and must close the
   * returned fd.
   */
  resolve(id: string): MediaFileDescriptor | null;
}

/** Minimal extension→content-type fallback for the rare row with no stored mime.
 *  Kept deliberately small (the common playable formats); anything unrecognised
 *  degrades to a generic binary type, which the media element still handles. */
const EXT_MIME: Readonly<Record<string, string>> = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/opus',
  '.flac': 'audio/flac',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.avif': 'image/avif',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.bmp': 'image/bmp',
};

/** Content-type from the stored mime, else the catalog's `original_ext` — derived
 *  from the DB, NOT the filesystem path, so no path is touched after validation. */
function contentTypeFor(storedMime: string | null, ext: string | null): string {
  const trimmed = storedMime?.trim();
  if (trimmed) return trimmed;
  if (ext) {
    const dotted = (ext.startsWith('.') ? ext : `.${ext}`).toLowerCase();
    const byExt = EXT_MIME[dotted];
    if (byExt) return byExt;
  }
  return 'application/octet-stream';
}

export function createMediaFileService(options: MediaFileServiceOptions): MediaFileService {
  const { db, root } = options;
  const rowStmt = db.prepare(
    'SELECT media_type AS mediaType, mime_type AS mimeType, original_ext AS ext FROM items WHERE id = @id',
  );

  return {
    resolve(id) {
      const row = rowStmt.get<{ mediaType: MediaType; mimeType: string | null; ext: string | null }>(
        { id },
      );
      if (row === undefined) return null;
      // Non-playable media is decided from the catalog alone — no original is ever
      // resolved or read.
      if (!PLAYABLE_MEDIA.has(row.mediaType)) return null;

      // resolveServableOriginal is the SERVE-TIME confinement boundary: it realpaths +
      // confines ONCE, then PINS the validated file by an open fd. It THROWS on an
      // escaping path / non-regular file (a bad content-address, or an in-place file
      // whose realpath escapes its source root) rather than returning one — the throw
      // deliberately propagates (the handler turns it into a 404, no bytes). The
      // returned fd is owned by the caller (the protocol handler), which closes it.
      const servable = resolveServableOriginal(db, root, id);
      if (servable === null) return null;

      return {
        fd: servable.fd,
        size: servable.size,
        mimeType: contentTypeFor(row.mimeType, row.ext),
        mediaType: row.mediaType,
      };
    },
  };
}
