import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { openCatalog } from '../../electron/main/db/connection';
import { MIGRATIONS, runMigrations } from '../../electron/main/db/migrate';
import { makeTmpDir, removeTmpDir } from '../helpers/tmp';

function tableNames(db: Database): Set<string> {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all<{ name: string }>();
  return new Set(rows.map((r) => r.name));
}

function columnNames(db: Database, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
  return new Set(rows.map((r) => r.name));
}

function ftsMatch(db: Database, term: string): string[] {
  return db
    .prepare('SELECT i.id FROM items_fts f JOIN items i ON i.rowid = f.rowid WHERE items_fts MATCH ?')
    .all<{ id: string }>(term)
    .map((r) => r.id);
}

function userVersion(db: Database): number {
  return Number(db.pragma('user_version', { simple: true }));
}

describe('catalog connection + migration runner (ARCHITECTURE §4.1/§4.3)', () => {
  let dir: string;
  let db: Database;

  beforeEach(() => {
    dir = makeTmpDir('db-');
    db = openCatalog(join(dir, 'catalog.sqlite3'));
  });

  afterEach(() => {
    db.close();
    removeTmpDir(dir);
  });

  it('opens a file catalog in WAL mode with foreign keys enforced', () => {
    expect(String(db.pragma('journal_mode', { simple: true })).toLowerCase()).toBe('wal');
    expect(Number(db.pragma('foreign_keys', { simple: true }))).toBe(1);
  });

  it('applies every migration and tracks the latest in user_version', () => {
    expect(userVersion(db)).toBe(0);
    runMigrations(db);
    expect(userVersion(db)).toBe(MIGRATIONS.length);
    expect(userVersion(db)).toBe(2);
  });

  it('records every applied migration by name in the migrations table', () => {
    runMigrations(db);
    const names = db.prepare('SELECT name FROM migrations ORDER BY id').all<{ name: string }>();
    expect(names.map((r) => r.name)).toEqual(['001_initial', '002_transcripts']);
  });

  it('is idempotent: re-running applies nothing and never duplicates bookkeeping', () => {
    runMigrations(db);
    runMigrations(db);
    runMigrations(db);
    expect(userVersion(db)).toBe(2);
    const count = db
      .prepare('SELECT COUNT(*) AS n FROM migrations')
      .get<{ n: number }>();
    expect(count?.n).toBe(2);
  });

  it('creates the full dedup-with-provenance schema and the timeline index', () => {
    runMigrations(db);
    const tables = tableNames(db);
    for (const t of [
      'sources',
      'items',
      'item_occurrences',
      'item_assets',
      'tags',
      'item_tags',
      'collections',
      'collection_items',
    ]) {
      expect(tables.has(t)).toBe(true);
    }
    const fts = db
      .prepare("SELECT name FROM sqlite_master WHERE name = 'items_fts'")
      .get<{ name: string }>();
    expect(fts?.name).toBe('items_fts');
    const idx = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_items_timeline'")
      .get<{ name: string }>();
    expect(idx?.name).toBe('idx_items_timeline');
  });

  it('keeps items_fts synchronized through the insert/update/delete triggers', () => {
    runMigrations(db);
    const insert = db.prepare(
      "INSERT INTO items (id, media_type, description, search_meta) VALUES (?, 'message', ?, ?)",
    );
    insert.run('m1', 'birthday at the beach', 'mateo');

    const matchBeach = () =>
      db
        .prepare('SELECT i.id FROM items_fts f JOIN items i ON i.rowid = f.rowid WHERE items_fts MATCH ?')
        .all<{ id: string }>('beach')
        .map((r) => r.id);
    expect(matchBeach()).toEqual(['m1']);

    db.prepare("UPDATE items SET description = 'birthday at the park' WHERE id = 'm1'").run();
    expect(matchBeach()).toEqual([]);
    expect(
      db
        .prepare('SELECT i.id FROM items_fts f JOIN items i ON i.rowid = f.rowid WHERE items_fts MATCH ?')
        .all<{ id: string }>('park')
        .map((r) => r.id),
    ).toEqual(['m1']);

    db.prepare("DELETE FROM items WHERE id = 'm1'").run();
    expect(matchBeach()).toEqual([]);
  });

  it('enforces content_hash uniqueness but allows many NULL-hash message rows', () => {
    runMigrations(db);
    const ins = db.prepare(
      "INSERT INTO items (id, media_type, content_hash) VALUES (?, 'photo', ?)",
    );
    ins.run('p1', 'deadbeef');
    expect(() => ins.run('p2', 'deadbeef')).toThrow();

    const msg = db.prepare("INSERT INTO items (id, media_type, content_hash) VALUES (?, 'message', NULL)");
    msg.run('msg1');
    msg.run('msg2');
    const n = db.prepare("SELECT COUNT(*) AS n FROM items WHERE content_hash IS NULL").get<{ n: number }>();
    expect(n?.n).toBe(2);
  });

  it('cascades occurrence rows when their source is deleted (undo foundation)', () => {
    runMigrations(db);
    db.prepare(
      "INSERT INTO sources (id, source_key, type, label) VALUES ('s1', 'key-1', 'folder', 'Folder')",
    ).run();
    db.prepare("INSERT INTO items (id, media_type, content_hash) VALUES ('i1', 'photo', 'abc')").run();
    db.prepare(
      "INSERT INTO item_occurrences (id, item_id, source_id, source_ref) VALUES ('o1', 'i1', 's1', 'ref')",
    ).run();

    db.prepare("DELETE FROM sources WHERE id = 's1'").run();
    const occ = db.prepare('SELECT COUNT(*) AS n FROM item_occurrences').get<{ n: number }>();
    expect(occ?.n).toBe(0);
    // The item itself is NOT auto-removed by the FK cascade — that is the
    // catalog/undo layer's job (remove an item only when its last occurrence is gone).
    const items = db.prepare('SELECT COUNT(*) AS n FROM items').get<{ n: number }>();
    expect(items?.n).toBe(1);
  });
});

// ── Migration 002: transcript storage + FTS indexing (ADR-0027 §5, AC-19, #135) ──

describe('migration 002 — transcript storage + transcript_status + FTS feed', () => {
  let dir: string;
  let db: Database;

  beforeEach(() => {
    dir = makeTmpDir('db-');
    db = openCatalog(join(dir, 'catalog.sqlite3'));
  });
  afterEach(() => {
    db.close();
    removeTmpDir(dir);
  });

  it('adds the transcripts table, the transcript_status column, and the drain index', () => {
    runMigrations(db);
    expect(tableNames(db).has('transcripts')).toBe(true);
    expect(columnNames(db, 'items').has('transcript_status')).toBe(true);
    expect(columnNames(db, 'transcripts')).toEqual(
      new Set(['item_id', 'text', 'segments', 'language', 'created_at']),
    );
    const idx = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_items_transcript_queue'",
      )
      .get<{ name: string }>();
    expect(idx?.name).toBe('idx_items_transcript_queue');
  });

  it('defaults new items to transcript_status = pending and enforces the status CHECK', () => {
    runMigrations(db);
    db.prepare("INSERT INTO items (id, media_type) VALUES ('a1', 'audio')").run();
    const row = db
      .prepare("SELECT transcript_status FROM items WHERE id = 'a1'")
      .get<{ transcript_status: string }>();
    expect(row?.transcript_status).toBe('pending');
    // 'failed'/'skipped'/'done' are valid; anything else is rejected by the CHECK.
    expect(() =>
      db.prepare("UPDATE items SET transcript_status = 'bogus' WHERE id = 'a1'").run(),
    ).toThrow();
    expect(() =>
      db.prepare("UPDATE items SET transcript_status = 'failed' WHERE id = 'a1'").run(),
    ).not.toThrow();
  });

  it('cascades the transcript row when its item is deleted (attached, never orphaned)', () => {
    runMigrations(db);
    db.prepare("INSERT INTO items (id, media_type) VALUES ('a1', 'audio')").run();
    db.prepare("INSERT INTO transcripts (item_id, text) VALUES ('a1', 'hola mundo')").run();
    db.prepare("DELETE FROM items WHERE id = 'a1'").run();
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM transcripts').get<{ n: number }>()?.n,
    ).toBe(0);
  });

  it('forward-migrates an existing v1 catalog with NO data loss and a searchable items_fts', () => {
    // Bring a catalog up to v1 ONLY, then write real data the way 001 shipped.
    const [initial] = MIGRATIONS;
    runMigrations(db, [initial]);
    expect(userVersion(db)).toBe(1);
    db.prepare(
      "INSERT INTO items (id, media_type, description, search_meta) VALUES ('a1', 'audio', 'voice note', 'AUD_0001')",
    ).run();
    expect(ftsMatch(db, 'AUD_0001')).toEqual(['a1']); // findable before the upgrade

    // Forward-migrate to the latest schema.
    runMigrations(db);
    expect(userVersion(db)).toBe(MIGRATIONS.length);

    // The pre-existing row survives and is backfilled to 'pending'.
    const row = db
      .prepare("SELECT media_type, description, search_meta, transcript_status FROM items WHERE id = 'a1'")
      .get<{ media_type: string; description: string; search_meta: string; transcript_status: string }>();
    expect(row).toMatchObject({
      media_type: 'audio',
      description: 'voice note',
      search_meta: 'AUD_0001',
      transcript_status: 'pending',
    });
    // items_fts is rebuilt correctly — the existing content is still searchable.
    expect(ftsMatch(db, 'AUD_0001')).toEqual(['a1']);
  });
});
