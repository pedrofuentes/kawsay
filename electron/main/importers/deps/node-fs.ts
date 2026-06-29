import { createReadStream, promises as fsp } from 'node:fs';
import { dirname } from 'node:path';
import type { Readable } from 'node:stream';
import type { FileStat, FsLike } from '../types';

/**
 * The production {@link FsLike}: a thin, structural adapter over
 * node:fs/promises so importers depend on the narrow injected seam (the DI
 * boundary, §3.1) rather than on Node directly.
 */
export const nodeFs: FsLike = {
  readFile: (path) => fsp.readFile(path),
  readDir: (path) => fsp.readdir(path),
  async stat(path): Promise<FileStat> {
    // lstat (NOT stat) so symlinks are never followed: a symlinked directory
    // must report as neither file nor directory, otherwise the folder walker
    // would descend it and a symlink cycle (dir → ancestor) would recurse
    // unboundedly, or a link out of the selected root would ingest files the
    // user never chose (e.g. ~/.ssh). The walker ignores entries that are
    // neither file nor directory, so a symlink is skipped (issue #51).
    const stats = await fsp.lstat(path);
    return {
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      isFile: () => stats.isFile(),
      isDirectory: () => stats.isDirectory(),
    };
  },
  realpath: (path) => fsp.realpath(path),
  async exists(path): Promise<boolean> {
    try {
      await fsp.access(path);
      return true;
    } catch {
      return false;
    }
  },
  openReadStream(path): Readable {
    // Stream, never readFile: a Takeout Gmail .mbox can be multi-GB, so it is
    // parsed message-by-message under a bounded memory ceiling (AC-11).
    return createReadStream(path);
  },
  async writeFile(path, data): Promise<void> {
    // Materialize bytes embedded in a container export (e.g. a .mbox
    // attachment) so the worker can hash + content-address them like any
    // archive original. Parents are created so callers can target nested
    // scratch paths without a separate mkdir.
    await fsp.mkdir(dirname(path), { recursive: true });
    await fsp.writeFile(path, data);
  },
};
