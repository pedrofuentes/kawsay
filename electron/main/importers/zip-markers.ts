import * as yauzl from 'yauzl';

function toPosixZipName(name: string): string {
  return name.replace(/\\/g, '/');
}

export async function zipHasEntryName(
  inputPath: string,
  markers: readonly string[],
): Promise<boolean> {
  let zipfile: yauzl.ZipFile | undefined;
  try {
    zipfile = await yauzl.openPromise(inputPath, {
      lazyEntries: true,
      decodeStrings: true,
      validateEntrySizes: false,
    });

    return await new Promise<boolean>((resolve, reject) => {
      let settled = false;
      const finish = (value: boolean): void => {
        if (settled) return;
        settled = true;
        zipfile?.close();
        resolve(value);
      };
      zipfile?.once('error', (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      });
      zipfile?.on('entry', (entry: yauzl.Entry) => {
        const name = toPosixZipName(entry.fileName);
        if (markers.some((marker) => name.includes(marker))) {
          finish(true);
          return;
        }
        zipfile?.readEntry();
      });
      zipfile?.once('end', () => finish(false));
      zipfile?.readEntry();
    });
  } finally {
    zipfile?.close();
  }
}
