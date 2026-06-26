import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database, { type Database as Db } from 'better-sqlite3';
import { runMigrations } from '../../electron/main/db/migrate';
import { createCatalogRepo, type CatalogRepo } from '../../electron/main/db/catalog-repo';
import {
  createTranscriptRepo,
  createTranscriptStatusSkip,
  type TranscriptRepo,
} from '../../electron/main/db/transcript-repo';

function freshCatalog(): Db {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function count(db: Db, sql: string): number {
  return Number((db.prepare(sql).get<{ n: number }>() as { n: number }).n);
}

// ── persistence: attach a transcript to an EXISTING item (never duplicate) ────

describe('TranscriptRepo (transcript storage attached to items — ADR-0027 §5, #135)', () => {
  let db: Db;
  let catalog: CatalogRepo;
  let repo: TranscriptRepo;
  let itemId: string;

  beforeEach(() => {
    db = freshCatalog();
    catalog = createCatalogRepo(db);
    repo = createTranscriptRepo(db);
    itemId = catalog.insertItem({
      mediaType: 'audio',
      contentHash: 'h-audio',
      searchMeta: 'AUD_0001',
    });
  });
  afterEach(() => db.close());

  it('persists a transcript attached to the existing item and loads it back', () => {
    const result = repo.saveTranscript({
      itemId,
      text: 'feliz cumpleaños abuela',
      language: 'es',
      segments: [
        { startMs: 0, endMs: 1500, text: 'feliz cumpleaños' },
        { startMs: 1500, endMs: 3000, text: 'abuela' },
      ],
    });
    expect(result).toEqual({ itemId, status: 'done', saved: true });

    const loaded = repo.loadTranscript(itemId);
    expect(loaded?.itemId).toBe(itemId);
    expect(loaded?.text).toBe('feliz cumpleaños abuela');
    expect(loaded?.language).toBe('es');
    expect(loaded?.segments).toEqual([
      { startMs: 0, endMs: 1500, text: 'feliz cumpleaños' },
      { startMs: 1500, endMs: 3000, text: 'abuela' },
    ]);
    expect(typeof loaded?.createdAt).toBe('string');

    // Attached to the SAME item — transcription never creates a duplicate item.
    expect(count(db, 'SELECT COUNT(*) n FROM items')).toBe(1);
    expect(count(db, 'SELECT COUNT(*) n FROM transcripts')).toBe(1);
  });

  it('stores a null language and an empty segment list without throwing', () => {
    repo.saveTranscript({ itemId, text: 'hola' });
    const loaded = repo.loadTranscript(itemId);
    expect(loaded?.language).toBeNull();
    expect(loaded?.segments).toEqual([]);
  });

  it('marks the item transcript_status = done after saving (drain signal)', () => {
    expect(repo.getStatus(itemId)).toBe('pending');
    expect(repo.isDone(itemId)).toBe(false);
    repo.saveTranscript({ itemId, text: 'hola', segments: [] });
    expect(repo.getStatus(itemId)).toBe('done');
    expect(repo.isDone(itemId)).toBe(true);
  });

  it('is idempotent: re-saving an already-done item does not duplicate or overwrite', () => {
    repo.saveTranscript({ itemId, text: 'primera toma', segments: [] });
    const second = repo.saveTranscript({ itemId, text: 'OTRA TOMA distinta', segments: [] });

    expect(second).toEqual({ itemId, status: 'done', saved: false }); // already done → skipped
    expect(count(db, 'SELECT COUNT(*) n FROM transcripts')).toBe(1); // no duplicate transcript row
    expect(count(db, 'SELECT COUNT(*) n FROM items')).toBe(1); // no duplicate item
    expect(repo.loadTranscript(itemId)?.text).toBe('primera toma'); // original preserved
  });

  it('refuses to attach a transcript to an unknown item (never creates an item)', () => {
    expect(() => repo.saveTranscript({ itemId: 'ghost', text: 'x', segments: [] })).toThrow(
      /unknown item/,
    );
    expect(count(db, 'SELECT COUNT(*) n FROM items')).toBe(1);
    expect(count(db, 'SELECT COUNT(*) n FROM transcripts')).toBe(0);
  });

  it('transitions transcript_status to failed/skipped via setStatus (worker outcome drain)', () => {
    repo.setStatus(itemId, 'failed');
    expect(repo.getStatus(itemId)).toBe('failed');
    repo.setStatus(itemId, 'skipped');
    expect(repo.getStatus(itemId)).toBe('skipped');
    expect(repo.isDone(itemId)).toBe(false);
  });

  it('getStatus returns null and isDone false for an unknown item', () => {
    expect(repo.getStatus('ghost')).toBeNull();
    expect(repo.isDone('ghost')).toBe(false);
  });

  it('loadTranscript returns null when the item has no transcript yet', () => {
    expect(repo.loadTranscript(itemId)).toBeNull();
  });
});

// ── the #135 idempotence hook the worker batch consumes (skipWhen) ────────────

describe('createTranscriptStatusSkip (the #135 transcript_status idempotence hook)', () => {
  let db: Db;
  let catalog: CatalogRepo;
  let repo: TranscriptRepo;

  beforeEach(() => {
    db = freshCatalog();
    catalog = createCatalogRepo(db);
    repo = createTranscriptRepo(db);
  });
  afterEach(() => db.close());

  it('skips an item already transcribed (done) and processes pending/unknown ones', () => {
    const doneId = catalog.insertItem({ mediaType: 'audio', contentHash: 'h1' });
    const pendingId = catalog.insertItem({ mediaType: 'audio', contentHash: 'h2' });
    repo.saveTranscript({ itemId: doneId, text: 'ya transcrito', segments: [] });

    const skipWhen = createTranscriptStatusSkip(repo);
    expect(skipWhen({ id: doneId })).toBe(true); // already done → skip
    expect(skipWhen({ id: pendingId })).toBe(false); // pending → transcribe
    expect(skipWhen({ id: 'ghost' })).toBe(false); // unknown → transcribe (don't skip)
  });
});

// ── AC-19: a word SPOKEN in a recording is found by the existing FTS5 search ──

describe('FTS finds spoken words (AC-19 — transcript → search_meta, attached to the item)', () => {
  let db: Db;
  let catalog: CatalogRepo;
  let repo: TranscriptRepo;

  beforeEach(() => {
    db = freshCatalog();
    catalog = createCatalogRepo(db);
    repo = createTranscriptRepo(db);
  });
  afterEach(() => db.close());

  it('returns the media item when searching a word spoken in its recording (no duplicate item)', () => {
    const audioId = catalog.insertItem({
      mediaType: 'audio',
      contentHash: 'h-voice',
      searchMeta: 'AUD_0001',
    });
    // A control item with an unrelated body and no transcript.
    catalog.insertItem({
      mediaType: 'message',
      contentHash: null,
      description: 'almuerzo familiar',
    });

    // The spoken word is absent from the index BEFORE transcription.
    expect(catalog.search({ query: 'aguacate', limit: 10, offset: 0 }).rows).toEqual([]);

    repo.saveTranscript({
      itemId: audioId,
      text: 'me encanta el aguacate con limón',
      language: 'es',
      segments: [],
    });

    const res = catalog.search({ query: 'aguacate', limit: 10, offset: 0 });
    expect(res.total).toBe(1);
    expect(res.rows.map((r) => r.id)).toEqual([audioId]);
    expect(res.rows[0].mediaType).toBe('audio');

    // The transcript is MERGED into search_meta — the original filename token still matches.
    expect(
      catalog.search({ query: 'AUD_0001', limit: 10, offset: 0 }).rows.map((r) => r.id),
    ).toEqual([audioId]);
    // Transcription added NO new item — exactly the two we inserted.
    expect(count(db, 'SELECT COUNT(*) n FROM items')).toBe(2);
  });

  it('does NOT match a word that was never spoken in the recording', () => {
    const audioId = catalog.insertItem({ mediaType: 'audio', contentHash: 'h-voice' });
    repo.saveTranscript({ itemId: audioId, text: 'hola que tal', segments: [] });
    expect(catalog.search({ query: 'aguacate', limit: 10, offset: 0 }).rows).toEqual([]);
  });

  it('feeds transcript text into search_meta, NOT the message-body description (ADR-0027 §5)', () => {
    const audioId = catalog.insertItem({ mediaType: 'audio', contentHash: 'h-voice' });
    repo.saveTranscript({ itemId: audioId, text: 'palabra hablada', segments: [] });
    const row = db
      .prepare('SELECT description, search_meta FROM items WHERE id = ?')
      .get<{ description: string | null; search_meta: string | null }>(audioId);
    expect(row?.description).toBeNull(); // description (message body / caption) is untouched
    expect(row?.search_meta).toContain('palabra'); // transcript lands in the FTS-synced search_meta
  });

  it('narrows exactly when filtered by source (extends AC-7) and still attaches to the item', () => {
    const sourceId = catalog.registerSource({ sourceKey: 'k', type: 'whatsapp', label: 'Mum' });
    const audioId = catalog.insertItem({ mediaType: 'audio', contentHash: 'h-voice' });
    catalog.addOccurrence({ itemId: audioId, sourceId, sourceRef: 'voice/1.opus' });
    repo.saveTranscript({ itemId: audioId, text: 'mensaje de voz importante', segments: [] });

    expect(
      catalog
        .search({ query: 'importante', limit: 10, offset: 0, source: 'whatsapp' })
        .rows.map((r) => r.id),
    ).toEqual([audioId]);
    expect(
      catalog.search({ query: 'importante', limit: 10, offset: 0, source: 'folder' }).rows,
    ).toEqual([]);
  });
});
