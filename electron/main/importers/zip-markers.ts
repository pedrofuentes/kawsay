import * as yauzl from 'yauzl';

function toPosixZipName(name: string): string {
  return name.replace(/\\/g, '/');
}

const ZIP_ENTRY_NAME_CACHE_LIMIT = 32;
const zipEntryNameCache = new Map<string, Promise<readonly string[]>>();

async function readZipEntryNames(inputPath: string): Promise<readonly string[]> {
  let zipfile: yauzl.ZipFile | undefined;
  try {
    zipfile = await yauzl.openPromise(inputPath, {
      lazyEntries: true,
      decodeStrings: true,
      validateEntrySizes: false,
    });

    return await new Promise<readonly string[]>((resolve, reject) => {
      const names: string[] = [];
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        zipfile?.close();
        resolve(names);
      };
      zipfile?.once('error', (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      });
      zipfile?.on('entry', (entry: yauzl.Entry) => {
        names.push(toPosixZipName(entry.fileName));
        zipfile?.readEntry();
      });
      zipfile?.once('end', finish);
      zipfile?.readEntry();
    });
  } finally {
    zipfile?.close();
  }
}

function zipEntryNames(inputPath: string): Promise<readonly string[]> {
  const cached = zipEntryNameCache.get(inputPath);
  if (cached !== undefined) {
    zipEntryNameCache.delete(inputPath);
    zipEntryNameCache.set(inputPath, cached);
    return cached;
  }
  if (zipEntryNameCache.size >= ZIP_ENTRY_NAME_CACHE_LIMIT) {
    const oldest = zipEntryNameCache.keys().next().value;
    if (oldest !== undefined) {
      zipEntryNameCache.delete(oldest);
    }
  }
  const pending = readZipEntryNames(inputPath).catch((error: unknown) => {
    zipEntryNameCache.delete(inputPath);
    throw error;
  });
  zipEntryNameCache.set(inputPath, pending);
  return pending;
}

export async function zipHasEntryName(
  inputPath: string,
  markers: readonly string[],
): Promise<boolean> {
  const names = await zipEntryNames(inputPath);
  return names.some((name) => markers.some((marker) => name.includes(marker)));
}
