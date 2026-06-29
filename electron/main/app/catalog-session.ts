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
  transcriptViewSchema,
  type ItemCardDTO,
  type LibrarySummaryDTO,
  type SearchResultDTO,
  type TimelinePageDTO,
  type TranscriptViewDTO,
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
import { createTranscriptRepo, type TranscriptRepo } from '../db/transcript-repo';
import { createTranscriptionLibrary } from '../transcription/transcription-library';
import type { TranscriptionLibraryPort } from '../transcription/transcription-orchestrator';
import {
  createThumbnailService,
  type ImageThumbnailer,
  type ThumbnailService,
  type VideoThumbnailer,
} from '../library/thumbnail-service';
import { importers } from '../importers/registry';
import type { IngestionCoordinator } from '../importers/ingestion/coordinator';
import type { IngestionJobSpec } from '../importers/ingestion/protocol';

const ITEM_CARD_TITLE_MAX_LENGTH = 200;
const ITEM_CARD_DESCRIPTION_MAX_LENGTH = 4096;

/** A domain error the IPC layer surfaces to the renderer as a rejected invoke. */
export class CatalogSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CatalogSessionError';
  }
}

/**
 * The decoders the per-library {@link ThumbnailService} uses to turn a confined
 * original into bounded bytes. Injected so the catalog session (and its tests)
 * stay free of Electron/ffmpeg; production wires `nativeImage` + an ffmpeg frame.
 */
export interface CatalogThumbnailers {
  image: ImageThumbnailer;
  video: VideoThumbnailer;
}

/** Default when no thumbnailers are injected: nothing renders (icons everywhere),
 *  so a headless/test session needs no decoders to function. */
const NOOP_THUMBNAILERS: CatalogThumbnailers = {
  image: async () => null,
  video: async () => null,
};

export interface CatalogSessionOptions {
  coordinator: IngestionCoordinator;
  /** Job-id factory (injectable for deterministic tests). */
  newId?: () => string;
  /** Photo/video decoders for the thumbnail service (default: no-op). */
  thumbnailers?: CatalogThumbnailers;
  /**
   * Resolve the per-arch ffmpeg + ffprobe paths for an import job (#175). A lazy
   * thunk (mirrors the transcription orchestrator's resolveJobConfig): it is
   * called when an import STARTS — not at session construction — so a dev/CI
   * checkout without staged binaries only throws if an import is actually run,
   * never at boot. The worker has no `app`, so the host resolves and threads the
   * strings into the job spec.
   */
  resolveMediaBinaries: () => { ffmpegPath: string; ffprobePath: string };
}

export interface CatalogSession {
  createLibrary(input: { path: string; personName?: string }): LibrarySummaryDTO;
  openLibrary(input: { path: string }): LibrarySummaryDTO;
  getTimeline(input: { limit: number; cursor?: string }): TimelinePageDTO;
  search(input: {
    query: string;
    limit: number;
    offset: number;
    source?: SourceType;
  }): SearchResultDTO;
  /** Render one memory's bounded thumbnail by opaque id (U4), or null. */
  getThumbnail(input: { id: string; size?: number }): Promise<string | null>;
  /**
   * Read ONE item's transcript by opaque id (#136) — the renderer-safe view a
   * screen reader can read (status + words + detected language + ms segments).
   * Rejects with {@link CatalogSessionError} when no library is open or the id
   * is unknown; resolves a non-`done` placeholder (no text) for pending/failed/
   * skipped items.
   */
  getTranscript(input: { id: string }): Promise<TranscriptViewDTO>;
  beginImport(input: { sourceType: SourceType; inputPath: string }): { jobId: string };
  cancelImport(input: { jobId: string }): { cancelled: boolean };
  /** The host-side transcription library port for the OPEN library (#157). */
  transcription(): TranscriptionLibraryPort;
  /** Close the open library and tear down every in-flight import (window-close). */
  dispose(): void;
}

interface OpenLibrary {
  summary: LibrarySummary;
  db: CatalogDatabase;
  repo: CatalogRepo;
  thumbnails: ThumbnailService;
  transcripts: TranscriptRepo;
  transcription: TranscriptionLibraryPort;
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
  const boundString = (value: string | null, max: number): string | null =>
    value === null ? null : value.slice(0, max);
  return itemCardSchema.parse({
    id: row.id,
    mediaType: row.mediaType,
    mimeType: row.mimeType,
    captureDate: row.captureDate,
    durationSec: row.durationSec,
    title: boundString(row.title, ITEM_CARD_TITLE_MAX_LENGTH),
    description: boundString(row.description, ITEM_CARD_DESCRIPTION_MAX_LENGTH),
    isFavourite: row.isFavourite,
    width: row.width,
    height: row.height,
    source: row.source,
    // A pure render-ability hint — photos and videos can be shown as a real
    // thumbnail; everything else stays an icon. No path/asset URL leaks here.
    hasThumbnail: row.mediaType === 'photo' || row.mediaType === 'video',
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
  const thumbnailers = options.thumbnailers ?? NOOP_THUMBNAILERS;
  const resolveMediaBinaries = options.resolveMediaBinaries;
  let current: OpenLibrary | undefined;

  function closeCurrent(): void {
    if (current === undefined) return;
    current.db.close();
    current = undefined;
  }

  function adopt(summary: LibrarySummary): LibrarySummaryDTO {
    closeCurrent();
    const db = openCatalog(summary.catalogPath);
    const repo = createCatalogRepo(db);
    const thumbnails = createThumbnailService({
      db,
      root: summary.root,
      image: thumbnailers.image,
      video: thumbnailers.video,
    });
    const transcripts = createTranscriptRepo(db);
    const transcription = createTranscriptionLibrary({
      db,
      root: summary.root,
      catalog: repo,
      transcripts,
    });
    current = { summary, db, repo, thumbnails, transcripts, transcription };
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
      const result = repo.search({
        query: input.query,
        limit: input.limit,
        offset: input.offset,
        source: input.source,
      });
      return { items: result.rows.map(toItemCard), total: result.total };
    },
    async getThumbnail(input) {
      // requireOpen throws synchronously; `async` turns that into a rejected
      // promise so the IPC layer surfaces it as a normal rejected invoke.
      const { thumbnails } = requireOpen();
      return thumbnails.getThumbnail(input.id, input.size);
    },
    async getTranscript(input) {
      // `async` so requireOpen's synchronous throw becomes a rejected invoke,
      // exactly like getThumbnail above.
      const { transcripts } = requireOpen();
      const status = transcripts.getStatus(input.id);
      // null == the id names no item: a hard error (the renderer asked for a
      // memory that isn't in this library), surfaced as a rejected invoke.
      if (status === null) {
        throw new CatalogSessionError(`no such item: ${input.id}`);
      }
      // Only a `done` item has words to read; for pending/failed/skipped we return
      // the status alone (no text/segments) so the UI can show its calm state.
      if (status !== 'done') {
        return transcriptViewSchema.parse({ status, language: null, text: null, segments: [] });
      }
      // A `done` item should have a readable transcript row. If the row is missing
      // (a torn write) or its stored segments JSON is corrupt (loadTranscript
      // throws), don't crash the read or surface a raw error to the calm item view:
      // log a main-process diagnostic and fall back to a non-done view so the UI
      // shows its gentle "not transcribed yet" state instead (#164).
      let record: ReturnType<typeof transcripts.loadTranscript>;
      try {
        record = transcripts.loadTranscript(input.id);
      } catch (error) {
        console.warn(
          '[kawsay] item is marked done but its transcript could not be read; showing a non-done view. item:',
          input.id,
          error,
        );
        return transcriptViewSchema.parse({
          status: 'pending',
          language: null,
          text: null,
          segments: [],
        });
      }
      if (record === null) {
        console.warn(
          `[kawsay] item ${input.id} is marked done but has no transcript row; showing a non-done view`,
        );
        return transcriptViewSchema.parse({
          status: 'pending',
          language: null,
          text: null,
          segments: [],
        });
      }
      return transcriptViewSchema.parse({
        status,
        language: record.language ?? null,
        text: record.text ?? null,
        segments: record.segments ?? [],
      });
    },
    beginImport(input) {
      const library = requireOpen();
      const importer = importers.find((candidate) => candidate.id === input.sourceType);
      if (importer === undefined) {
        throw new CatalogSessionError(`no importer available for source type: ${input.sourceType}`);
      }
      const { ffmpegPath, ffprobePath } = resolveMediaBinaries();
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
        ffmpegPath,
        ffprobePath,
      };
      coordinator.start(job);
      return { jobId };
    },
    cancelImport(input) {
      return { cancelled: coordinator.cancel(input.jobId) };
    },
    transcription() {
      return requireOpen().transcription;
    },
    dispose() {
      coordinator.disposeAll();
      closeCurrent();
    },
  };
}
