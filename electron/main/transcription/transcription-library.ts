// The host-side transcription LIBRARY port (M2, #157). It adapts the open catalog
// into the seam the orchestrator drives: ENUMERATE the audio/video corpus (catalog
// query) with each item resolved to its confined local original (AC-14, via
// `resolveOriginal`), REPORT idempotence through the #135 transcript_status hook,
// and PERSIST each outcome (a transcript on success, a failed/skipped status
// otherwise) through the #135 transcript repo. It owns NO worker and NO IPC — it is
// purely the catalog ↔ orchestrator boundary, so it unit-tests over an in-memory DB.

import type { CatalogDatabase } from '../db/connection';
import type { CatalogRepo } from '../db/catalog-repo';
import type { TranscriptRepo } from '../db/transcript-repo';
import { resolveOriginal } from '../library/originals-store';
import type {
  TranscriptionLibraryItem,
  TranscriptionLibraryPort,
  TranscriptionSaveInput,
} from './transcription-orchestrator';

export interface CreateTranscriptionLibraryOptions {
  /** The open, migrated catalog connection (for original resolution). */
  db: CatalogDatabase;
  /** The library root, the confinement boundary for content-addressed originals. */
  root: string;
  /** Enumerates the transcribable corpus (audio/video). */
  catalog: Pick<CatalogRepo, 'listTranscribableItems'>;
  /** Persists transcripts + drives the transcript_status drain (#135). */
  transcripts: TranscriptRepo;
}

/**
 * Build the transcription library port over the open catalog. `listItems` joins
 * the audio/video enumeration with original resolution, dropping any item whose
 * original cannot be resolved (a pure message, an undone occurrence) or whose
 * resolution THROWS (the AC-14 confinement boundary rejecting a hostile path) — a
 * bad item is silently skipped, never transcribed and never a crash.
 */
export function createTranscriptionLibrary(
  options: CreateTranscriptionLibraryOptions,
): TranscriptionLibraryPort {
  const { db, root, catalog, transcripts } = options;

  return {
    listItems() {
      const items: TranscriptionLibraryItem[] = [];
      for (const { id, durationSec } of catalog.listTranscribableItems()) {
        let sourcePath: string | null;
        try {
          sourcePath = resolveOriginal(db, root, id);
        } catch {
          // resolveOriginal is the confinement boundary (AC-14): a hostile
          // content-addressed original throws. Skip it and carry on.
          continue;
        }
        // A pure message or an item whose every occurrence was undone resolves to
        // null — there is nothing on disk to transcribe.
        if (sourcePath === null) continue;
        items.push({ id, sourcePath, durationSec });
      }
      return items;
    },

    isTranscribed(id) {
      return transcripts.isDone(id);
    },

    saveTranscript(input: TranscriptionSaveInput) {
      transcripts.saveTranscript({
        itemId: input.itemId,
        text: input.text,
        language: input.language,
        segments: input.segments,
      });
    },

    recordStatus(id, status) {
      transcripts.setStatus(id, status);
    },
  };
}
