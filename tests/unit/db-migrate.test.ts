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

  it('applies the initial migration and tracks it in user_version', () => {
    expect(userVersion(db)).toBe(0);
    runMigrations(db);
    expect(userVersion(db)).toBe(MIGRATIONS.length);
    expect(userVersion(db)).toBe(1);
  });

  it('records every applied migration by name in the migrations table', () => {
    runMigrations(db);
    const names = db.prepare('SELECT name FROM migrations ORDER BY id').all<{ name: string }>();
    expect(names.map((r) => r.name)).toEqual(['001_initial']);
  });

  it('is idempotent: re-running applies nothing and never duplicates bookkeeping', () => {
    runMigrations(db);
    runMigrations(db);
    runMigrations(db);
    expect(userVersion(db)).toBe(1);
    const count = db
      .prepare('SELECT COUNT(*) AS n FROM migrations')
      .get<{ n: number }>();
    expect(count?.n).toBe(1);
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
