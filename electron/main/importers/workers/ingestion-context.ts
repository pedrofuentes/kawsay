// Worker-side composition of the heavy per-job collaborators (AC-9). This is the
// thin glue the off-thread worker runs to assemble the REAL importer/db/repo/
// deps/thumbnailer from a job spec — the only place the worker touches the
// filesystem, SQLite, ffmpeg, and exif. It is kept separate from the worker's
// control logic (ingestion-job.ts) so that logic stays unit-testable with a fake
// context, while this concrete wiring is exercised at runtime.

import { openCatalog } from '../../db/connection';
import { createCatalogRepo } from '../../db/catalog-repo';
import { createFfmpegThumbnailGenerator, createImporterDeps, unavailableExtractArchive } from '../deps';
import { importers } from '../registry';
import type { IngestionJobSpec } from '../ingestion/protocol';
import type { IngestionContext } from './ingestion-job';

/**
 * Open the catalog and resolve the connector for one job. The archive extractor
 * is the C2-provided `unavailableExtractArchive` placeholder for now: folder
 * imports never call it, and an archive import fails loudly until C2 lands.
 */
export function openIngestionContext(job: IngestionJobSpec): IngestionContext {
  const importer = importers.find((candidate) => candidate.id === job.sourceType);
  if (importer === undefined) {
    throw new Error(`no importer available for source type: ${job.sourceType}`);
  }
  const db = openCatalog(job.catalogPath);
  return {
    importer,
    db,
    repo: createCatalogRepo(db),
    deps: createImporterDeps({
      extractArchive: unavailableExtractArchive,
      ffprobePath: job.ffprobePath,
    }),
    generateThumbnail: createFfmpegThumbnailGenerator({ ffmpegPath: job.ffmpegPath }),
    close: () => db.close(),
  };
}
