import { promises as fsp } from 'node:fs';
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
  async exists(path): Promise<boolean> {
    try {
      await fsp.access(path);
      return true;
    } catch {
      return false;
    }
  },
};
