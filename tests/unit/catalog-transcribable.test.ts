import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database, { type Database as Db } from 'better-sqlite3';
import { runMigrations } from '../../electron/main/db/migrate';
import { createCatalogRepo, type CatalogRepo } from '../../electron/main/db/catalog-repo';

function freshCatalog(): Db {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

describe('CatalogRepo.listTranscribableItems (#157 — enumerate audio/video for transcription)', () => {
  let db: Db;
  let repo: CatalogRepo;
  afterEach(() => db.close());
  beforeEach(() => {
    db = freshCatalog();
    repo = createCatalogRepo(db);
  });

  it('returns every audio and video item with its duration, and nothing else', () => {
    const audio = repo.insertItem({
      mediaType: 'audio',
      contentHash: 'a',
      durationSec: 8,
      searchMeta: 'a',
    });
    const video = repo.insertItem({
      mediaType: 'video',
      contentHash: 'v',
      durationSec: 42,
      searchMeta: 'v',
    });
    repo.insertItem({ mediaType: 'photo', contentHash: 'p', searchMeta: 'p' });
    repo.insertItem({ mediaType: 'document', contentHash: 'd', searchMeta: 'd' });
    repo.insertItem({ mediaType: 'message', contentHash: null, searchMeta: 'm' });

    const items = repo.listTranscribableItems();

    expect(items.map((i) => i.id).sort()).toEqual([audio, video].sort());
    const byId = new Map(items.map((i) => [i.id, i]));
    expect(byId.get(audio)?.durationSec).toBe(8);
    expect(byId.get(video)?.durationSec).toBe(42);
  });

  it('exposes a null duration when unknown (the timeout scaler degrades gracefully)', () => {
    const audio = repo.insertItem({ mediaType: 'audio', contentHash: 'a', searchMeta: 'a' });
    const [item] = repo.listTranscribableItems();
    expect(item.id).toBe(audio);
    expect(item.durationSec).toBeNull();
  });

  it('returns an empty list for a library with no audio/video', () => {
    repo.insertItem({ mediaType: 'photo', contentHash: 'p', searchMeta: 'p' });
    expect(repo.listTranscribableItems()).toEqual([]);
  });
});
