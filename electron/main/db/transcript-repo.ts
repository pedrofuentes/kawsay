import { mergeTokens } from './catalog-repo';
import type { CatalogDatabase } from './connection';

// Transcript persistence for M2 (ADR-0027 §5, AC-19, issue #135). A transcript
// produced by the #134 worker is ATTACHED to its EXISTING media item — never a new
// or duplicate item (dedup-with-provenance, ADR-0003). Three jobs:
//   1. store the transcript (full text + per-segment offsets + detected language)
//      in a normalized `transcripts` row keyed 1:1 by item id;
//   2. feed the spoken words into the item's FTS-synced `search_meta` column (NOT
//      the message-body `description`), so the EXISTING external-content FTS5 search
//      (`items_fts`) covers transcripts — the UPDATE fires the shipped `items_fts_au`
//      trigger, keeping the index in sync with no column-set change (ADR-0027 §5);
//   3. drive the per-item `transcript_status` drain (pending → done | failed |
//      skipped), analogous to `thumb_status`, and expose the idempotence predicate
//      the worker batch consumes (skip an item already `done`).
// Re-running is safe: an item already `done` is skipped, and the search_meta feed is
// a de-duplicated token merge, so it never grows or duplicates on a re-save (AC-20).
// This module persists ONLY — it renders nothing (UI is #136).

/** The per-item transcription drain states (mirrors the items.transcript_status CHECK). */
export const TRANSCRIPT_STATUSES = ['pending', 'done', 'failed', 'skipped'] as const;
export type TranscriptStatus = (typeof TRANSCRIPT_STATUSES)[number];

/** One transcript segment with millisecond offsets (mirrors the worker's TranscriptSegment). */
export interface TranscriptSegmentInput {
  startMs: number;
  endMs: number;
  text: string;
}

/** A transcript to persist, attached to an EXISTING media item (never a new item). */
export interface SaveTranscriptInput {
  /** The id of the existing media item the transcript belongs to. */
  itemId: string;
  /** Full transcript text; also fed (token-merged) into the item's `search_meta`. */
  text: string;
  /** Whisper-detected language, or null when none was detected. */
  language?: string | null;
  /** Per-segment offsets; stored as JSON. Defaults to an empty list. */
  segments?: readonly TranscriptSegmentInput[];
}

/** The outcome of {@link TranscriptRepo.saveTranscript}. */
export interface SaveTranscriptResult {
  itemId: string;
  /** Always `done` here — either freshly saved, or already done (idempotent skip). */
  status: TranscriptStatus;
  /** False when the item was already `done`, so the call was an idempotent no-op. */
  saved: boolean;
}

/** A transcript as loaded back from storage. */
export interface TranscriptRecord {
  itemId: string;
  text: string;
  language: string | null;
  segments: TranscriptSegmentInput[];
  createdAt: string;
}

/** The transcript data-access layer over an open, migrated catalog database. */
export interface TranscriptRepo {
  /**
   * Persist a transcript attached to the existing item, feed its text into the
   * item's `search_meta` (FTS coverage), and mark `transcript_status = 'done'`.
   * Idempotent: an item already `done` is skipped (`saved: false`); throws if the
   * item does not exist (a transcript never creates an item).
   */
  saveTranscript(input: SaveTranscriptInput): SaveTranscriptResult;
  /** Load a transcript for an item, or null when none has been stored. */
  loadTranscript(itemId: string): TranscriptRecord | null;
  /** The item's transcript drain status, or null when the item does not exist. */
  getStatus(itemId: string): TranscriptStatus | null;
  /** Set the item's transcript drain status (the worker records failed/skipped outcomes). */
  setStatus(itemId: string, status: TranscriptStatus): void;
  /** True iff the item has been transcribed (`transcript_status = 'done'`). */
  isDone(itemId: string): boolean;
}

interface StatusRow {
  transcript_status: TranscriptStatus;
}
interface SearchMetaRow {
  search_meta: string | null;
}
interface RawTranscriptRow {
  item_id: string;
  text: string;
  segments: string | null;
  language: string | null;
  created_at: string;
}

/** Parse the stored segments JSON back into a typed list (empty when absent/blank). */
function parseSegments(json: string | null): TranscriptSegmentInput[] {
  if (json === null || json.length === 0) return [];
  return JSON.parse(json) as TranscriptSegmentInput[];
}

/**
 * Build the transcript data-access layer over an open, migrated database. Mirrors
 * the catalog-repo single-writer pattern: each write is one prepared statement, and
 * the save runs in a transaction so the transcript row, the `search_meta` FTS feed,
 * and the `transcript_status` flip commit (or roll back) together.
 */
export function createTranscriptRepo(db: CatalogDatabase): TranscriptRepo {
  const selectStatusStmt = db.prepare('SELECT transcript_status FROM items WHERE id = ?');
  const selectSearchMetaStmt = db.prepare('SELECT search_meta FROM items WHERE id = ?');
  const selectTranscriptStmt = db.prepare(
    'SELECT item_id, text, segments, language, created_at FROM transcripts WHERE item_id = ?',
  );

  const upsertTranscriptStmt = db.prepare(`
    INSERT INTO transcripts (item_id, text, segments, language)
    VALUES (@itemId, @text, @segments, @language)
    ON CONFLICT(item_id) DO UPDATE SET
      text       = excluded.text,
      segments   = excluded.segments,
      language   = excluded.language,
      created_at = datetime('now')
  `);
  const markDoneStmt = db.prepare(`
    UPDATE items
       SET search_meta       = @searchMeta,
           transcript_status = 'done',
           updated_at        = datetime('now')
     WHERE id = @itemId
  `);
  const setStatusStmt = db.prepare(`
    UPDATE items SET transcript_status = @status, updated_at = datetime('now') WHERE id = @itemId
  `);

  const getStatus = (itemId: string): TranscriptStatus | null =>
    selectStatusStmt.get<StatusRow>(itemId)?.transcript_status ?? null;

  return {
    saveTranscript(input) {
      const status = getStatus(input.itemId);
      if (status === null) {
        // A transcript ATTACHES to an existing item — it never creates one (ADR-0027 §5).
        throw new Error(
          `transcript-repo: cannot attach a transcript to unknown item ${input.itemId}`,
        );
      }
      if (status === 'done') {
        // Already transcribed — re-running never duplicates or overwrites (AC-20).
        return { itemId: input.itemId, status: 'done', saved: false };
      }

      const segments = JSON.stringify(input.segments ?? []);
      const language = input.language ?? null;
      const persist = db.transaction(() => {
        upsertTranscriptStmt.run({ itemId: input.itemId, text: input.text, segments, language });
        // Feed the spoken words into the FTS-synced search_meta (fires items_fts_au).
        // mergeTokens de-duplicates, so a re-save is idempotent — search_meta never grows.
        const current = selectSearchMetaStmt.get<SearchMetaRow>(input.itemId);
        const searchMeta = mergeTokens(current?.search_meta ?? null, input.text);
        markDoneStmt.run({ itemId: input.itemId, searchMeta });
      });
      persist();
      return { itemId: input.itemId, status: 'done', saved: true };
    },

    loadTranscript(itemId) {
      const row = selectTranscriptStmt.get<RawTranscriptRow>(itemId);
      if (row === undefined) return null;
      return {
        itemId: row.item_id,
        text: row.text,
        language: row.language,
        segments: parseSegments(row.segments),
        createdAt: row.created_at,
      };
    },

    getStatus,

    setStatus(itemId, status) {
      setStatusStmt.run({ itemId, status });
    },

    isDone(itemId) {
      return getStatus(itemId) === 'done';
    },
  };
}

/**
 * Build the worker batch's `skipWhen(item)` idempotence hook (the #135 seam): an
 * item is skipped iff its `transcript_status` is already `done`, so a re-run never
 * re-transcribes finished items. An unknown item is NOT skipped (it is processed).
 */
export function createTranscriptStatusSkip(
  repo: Pick<TranscriptRepo, 'isDone'>,
): (item: { id: string }) => boolean {
  return (item) => repo.isDone(item.id);
}
