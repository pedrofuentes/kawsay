import type { CatalogRecord, Importer, ImportContext, ImportResult } from './types';

/**
 * Drive an importer's `discover → parse → normalize → emit` generator to
 * completion, invoking `onRecord` for each emitted {@link CatalogRecord} and
 * returning the importer's final {@link ImportResult}. This is the consumption
 * loop the ingestion worker uses; isolating it keeps that loop unit-testable
 * against fake importers without an Electron or worker runtime.
 */
export async function drainImporter(
  importer: Importer,
  inputPath: string,
  ctx: ImportContext,
  onRecord: (record: CatalogRecord) => void,
): Promise<ImportResult> {
  const generator = importer.import(inputPath, ctx);
  try {
    let next = await generator.next();
    while (!next.done) {
      onRecord(next.value);
      next = await generator.next();
    }
    return next.value;
  } catch (error) {
    await generator.return(undefined as never).catch(() => undefined);
    throw error;
  }
}
