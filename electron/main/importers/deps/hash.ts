import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type { FileHasher } from '../types';

/**
 * Streaming SHA-256 → lowercase hex (the content address, §4.4). Streamed so a
 * multi-gigabyte original is hashed with bounded memory (ARCHITECTURE §5.1).
 */
export const hashFile: FileHasher = (path: string): Promise<string> =>
  new Promise<string>((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('error', reject);
    stream.on('data', (chunk: string | Buffer) => hash.update(chunk));
    stream.on('end', () => {
      resolve(hash.digest('hex'));
    });
  });
