import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database, { type Database as Db } from 'better-sqlite3';
import { runMigrations } from '../../electron/main/db/migrate';
import { createCatalogRepo, type CatalogRepo } from '../../electron/main/db/catalog-repo';
import { createTranscriptRepo, type TranscriptRepo } from '../../electron/main/db/transcript-repo';
import { createTranscriptionLibrary } from '../../electron/main/transcription/transcription-library';

function freshCatalog(): Db {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

const ROOT = '/Users/mateo/Mum';

describe('transcription library port (#157 — enumerate + resolve + persist over the catalog)', () => {
  let db: Db;
  let catalog: CatalogRepo;
  let transcripts: TranscriptRepo;
  let sourceId: string;

  beforeEach(() => {
    db = freshCatalog();
    catalog = createCatalogRepo(db);
    transcripts = createTranscriptRepo(db);
    sourceId = catalog.registerSource({ sourceKey: 'folder', type: 'folder', label: 'Folder' });
  });
  afterEach(() => db.close());

  function seedMedia(
    mediaType: 'audio' | 'video' | 'photo',
    hash: string,
    originalPath: string | null,
    durationSec: number | null = null,
  ): string {
    const itemId = catalog.insertItem({
      mediaType,
      contentHash: hash,
      durationSec,
      searchMeta: hash,
    });
    if (originalPath !== null) {
      catalog.addOccurrence({
        itemId,
        sourceId,
        sourceRef: hash,
        originalKind: 'in_place',
        originalPath,
      });
    }
    return itemId;
  }

  it('lists ONLY audio + video items, resolving each to its local source path', () => {
    const audio = seedMedia('audio', 'a', '/Users/mateo/Mum/voice.m4a', 12);
    const video = seedMedia('video', 'v', '/Users/mateo/Mum/clip.mp4', 30);
    seedMedia('photo', 'p', '/Users/mateo/Mum/beach.jpg'); // never transcribable

    const library = createTranscriptionLibrary({ db, root: ROOT, catalog, transcripts });
    const items = library.listItems();

    expect(items.map((i) => i.id).sort()).toEqual([audio, video].sort());
    const byId = new Map(items.map((i) => [i.id, i]));
    expect(byId.get(audio)?.sourcePath).toBe('/Users/mateo/Mum/voice.m4a');
    expect(byId.get(audio)?.durationSec).toBe(12);
    expect(byId.get(video)?.sourcePath).toBe('/Users/mateo/Mum/clip.mp4');
  });

  it('skips an audio item whose original cannot be resolved (no surviving occurrence)', () => {
    seedMedia('audio', 'a', null); // a pure/occurrence-less row resolves to null

    const library = createTranscriptionLibrary({ db, root: ROOT, catalog, transcripts });
    expect(library.listItems()).toEqual([]);
  });

  it('skips (without aborting) an item whose content-addressed original is hostile — AC-14 confinement', () => {
    // A surviving content_addressed occurrence whose hash fails the safe-hash guard
    // makes resolveOriginal THROW (the confinement boundary). The port must swallow
    // it and carry on enumerating the healthy items rather than abort the whole run.
    const hostile = catalog.insertItem({
      mediaType: 'audio',
      contentHash: 'not-a-valid-sha-256', // fails HASH_RE ⇒ resolveOriginal throws
      searchMeta: 'hostile',
    });
    catalog.addOccurrence({
      itemId: hostile,
      sourceId,
      sourceRef: 'hostile',
      originalKind: 'content_addressed',
      originalPath: null,
    });
    const healthy = seedMedia('audio', 'b'.repeat(64), '/Users/mateo/Mum/voice.m4a', 7);

    const library = createTranscriptionLibrary({ db, root: ROOT, catalog, transcripts });
    const items = library.listItems();

    expect(items.map((i) => i.id)).toEqual([healthy]);
  });

  it('reports transcribed-ness via the #135 transcript_status hook (idempotence)', () => {
    const audio = seedMedia('audio', 'a', '/Users/mateo/Mum/voice.m4a');
    const library = createTranscriptionLibrary({ db, root: ROOT, catalog, transcripts });

    expect(library.isTranscribed(audio)).toBe(false);
    transcripts.saveTranscript({ itemId: audio, text: 'hi' });
    expect(library.isTranscribed(audio)).toBe(true);
  });

  it('persists a transcript on success (attached to the item, then marked done)', () => {
    const audio = seedMedia('audio', 'a', '/Users/mateo/Mum/voice.m4a');
    const library = createTranscriptionLibrary({ db, root: ROOT, catalog, transcripts });

    library.saveTranscript({
      itemId: audio,
      text: 'hello mum',
      language: 'en',
      segments: [{ startMs: 0, endMs: 900, text: 'hello mum' }],
    });

    expect(transcripts.getStatus(audio)).toBe('done');
    expect(transcripts.loadTranscript(audio)?.text).toBe('hello mum');
  });

  it('records a non-success terminal status without writing a transcript', () => {
    const audio = seedMedia('audio', 'a', '/Users/mateo/Mum/voice.m4a');
    const library = createTranscriptionLibrary({ db, root: ROOT, catalog, transcripts });

    library.recordStatus(audio, 'failed');
    expect(transcripts.getStatus(audio)).toBe('failed');
    expect(transcripts.loadTranscript(audio)).toBeNull();

    library.recordStatus(audio, 'skipped');
    expect(transcripts.getStatus(audio)).toBe('skipped');
  });
});
