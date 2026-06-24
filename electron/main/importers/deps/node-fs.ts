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
    const stats = await fsp.stat(path);
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
