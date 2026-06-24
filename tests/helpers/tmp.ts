import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// Project-local scratch root (under the always-gitignored node_modules/.cache),
// so catalog/originals tests get real temp directories without ever touching
// the OS /tmp tree.
const TMP_ROOT = join(process.cwd(), 'node_modules', '.cache', 'kawsay-test');

/** Create a fresh, unique temp directory for a test and return its absolute path. */
export function makeTmpDir(prefix = 'kawsay-'): string {
  mkdirSync(TMP_ROOT, { recursive: true });
  return mkdtempSync(join(TMP_ROOT, prefix));
}

/** Remove a temp directory created by {@link makeTmpDir} (best effort). */
export function removeTmpDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}
