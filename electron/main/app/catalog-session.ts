// The catalog application service — the single seam every catalog/library/import
// IPC handler calls into (ARCHITECTURE §2.3). It owns the currently-open library
// (a main-thread read connection for the timeline/search), turns the validated
// request DTOs into domain calls, and projects the domain results back onto the
// renderer-safe DTOs (no filesystem paths leak out). Heavy imports are handed to
// the injected {@link IngestionCoordinator}, which runs them off-thread (AC-9).
//
// The coordinator is injected so this service is fully unit-testable with a fake
// (no real worker thread); everything else here is pure Node and runs under
// Vitest exactly as in production.

import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { SourceType } from '@shared/catalog';
import {
  itemCardSchema,
  type ItemCardDTO,
  type LibrarySummaryDTO,
  type SearchResultDTO,
  type TimelinePageDTO,
} from '@shared/ipc/schemas';
import {
  createLibrary as createLibraryOnDisk,
  openLibrary as openLibraryOnDisk,
  type LibrarySummary,
} from '../library/library-service';
import { openCatalog, type CatalogDatabase } from '../db/connection';
import {
  createCatalogRepo,
  type CatalogRepo,
  type ItemRow,
  type TimelineCursor,
} from '../db/catalog-repo';
import { importers } from '../importers/registry';
import type { IngestionCoordinator } from '../importers/ingestion/coordinator';
import type { IngestionJobSpec } from '../importers/ingestion/protocol';

/** A domain error the IPC layer surfaces to the renderer as a rejected invoke. */
export class CatalogSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CatalogSessionError';
  }
}

export interface CatalogSessionOptions {
  coordinator: IngestionCoordinator;
  /** Job-id factory (injectable for deterministic tests). */
  newId?: () => string;
}

export interface CatalogSession {
  createLibrary(input: { path: string; personName?: string }): LibrarySummaryDTO;
  openLibrary(input: { path: string }): LibrarySummaryDTO;
  getTimeline(input: { limit: number; cursor?: string }): TimelinePageDTO;
  search(input: { query: string; limit: number; offset: number }): SearchResultDTO;
  beginImport(input: { sourceType: SourceType; inputPath: string }): { jobId: string };
  cancelImport(input: { jobId: string }): { cancelled: boolean };
  /** Close the open library and tear down every in-flight import (window-close). */
  dispose(): void;
}

interface OpenLibrary {
  summary: LibrarySummary;
  db: CatalogDatabase;
  repo: CatalogRepo;
}

const timelineCursorSchema = z.strictObject({
  captureDate: z.string().nullable(),
  id: z.string().min(1),
});

function encodeCursor(cursor: TimelineCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(raw: string): TimelineCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new CatalogSessionError('invalid timeline cursor');
  }
  const result = timelineCursorSchema.safeParse(parsed);
  if (!result.success) throw new CatalogSessionError('invalid timeline cursor');
  return result.data;
}

/** Project an internal catalog row onto the renderer-safe tile — dropping every
 *  filesystem / content-addressing field. */
function toItemCard(row: ItemRow): ItemCardDTO {
  return itemCardSchema.parse({
    id: row.id,
    mediaType: row.mediaType,
    mimeType: row.mimeType,
    captureDate: row.captureDate,
    durationSec: row.durationSec,
    title: row.title,
    description: row.description,
    isFavourite: row.isFavourite,
    width: row.width,
    height: row.height,
  });
}

function toLibraryDto(summary: LibrarySummary): LibrarySummaryDTO {
  // Deliberately omit catalogPath — the on-disk SQLite location stays internal.
  return {
    root: summary.root,
    name: summary.name,
    createdAt: summary.createdAt,
    schemaVersion: summary.schemaVersion,
  };
}

export function createCatalogSession(options: CatalogSessionOptions): CatalogSession {
  const { coordinator } = options;
  const newId = options.newId ?? (() => randomUUID());
  let current: OpenLibrary | undefined;

  function closeCurrent(): void {
    if (current === undefined) return;
    current.db.close();
    current = undefined;
  }

  function adopt(summary: LibrarySummary): LibrarySummaryDTO {
    closeCurrent();
    const db = openCatalog(summary.catalogPath);
    current = { summary, db, repo: createCatalogRepo(db) };
    return toLibraryDto(summary);
  }

  function requireOpen(): OpenLibrary {
    if (current === undefined) {
      throw new CatalogSessionError('no library is open');
    }
    return current;
  }

  return {
    createLibrary(input) {
      return adopt(createLibraryOnDisk({ root: input.path, personName: input.personName }));
    },
    openLibrary(input) {
      return adopt(openLibraryOnDisk({ root: input.path }));
    },
    getTimeline(input) {
      const { repo } = requireOpen();
      const cursor = input.cursor === undefined ? null : decodeCursor(input.cursor);
      const page = repo.queryTimeline({ limit: input.limit, cursor });
      return {
        items: page.rows.map(toItemCard),
        nextCursor: page.nextCursor === null ? null : encodeCursor(page.nextCursor),
      };
    },
    search(input) {
      const { repo } = requireOpen();
      const result = repo.search({ query: input.query, limit: input.limit, offset: input.offset });
      return { items: result.rows.map(toItemCard), total: result.total };
    },
    beginImport(input) {
      const library = requireOpen();
      const importer = importers.find((candidate) => candidate.id === input.sourceType);
      if (importer === undefined) {
        throw new CatalogSessionError(`no importer available for source type: ${input.sourceType}`);
      }
      const sourceId = library.repo.registerSource({
        sourceKey: `${input.sourceType}:${input.inputPath}`,
        type: input.sourceType,
        label: basename(input.inputPath) || input.sourceType,
        originPath: input.inputPath,
        rootPath: input.inputPath,
      });
      const jobId = newId();
      const job: IngestionJobSpec = {
        jobId,
        sourceType: input.sourceType,
        inputPath: input.inputPath,
        libraryRoot: library.summary.root,
        catalogPath: library.summary.catalogPath,
        sourceId,
        workDir: join(library.summary.root, 'extract', sourceId),
      };
      coordinator.start(job);
      return { jobId };
    },
    cancelImport(input) {
      return { cancelled: coordinator.cancel(input.jobId) };
    },
    dispose() {
      coordinator.disposeAll();
      closeCurrent();
    },
  };
}
