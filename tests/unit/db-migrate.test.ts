import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { openCatalog } from '../../electron/main/db/connection';
import { MIGRATIONS, runMigrations } from '../../electron/main/db/migrate';
import { createCatalogRepo } from '../../electron/main/db/catalog-repo';
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
    .prepare(
      'SELECT i.id FROM items_fts f JOIN items i ON i.rowid = f.rowid WHERE items_fts MATCH ?',
    )
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
    expect(userVersion(db)).toBe(5);
  });

  it('records every applied migration by name in the migrations table', () => {
    runMigrations(db);
    const names = db.prepare('SELECT name FROM migrations ORDER BY id').all<{ name: string }>();
    expect(names.map((r) => r.name)).toEqual([
      '001_initial',
      '002_transcripts',
      '003_embeddings',
      '004_item_embeddings_model_dim_index',
      '005_categories',
    ]);
  });

  it('is idempotent: re-running applies nothing and never duplicates bookkeeping', () => {
    runMigrations(db);
    runMigrations(db);
    runMigrations(db);
    expect(userVersion(db)).toBe(5);
    const count = db.prepare('SELECT COUNT(*) AS n FROM migrations').get<{ n: number }>();
    expect(count?.n).toBe(5);
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
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_items_timeline'",
      )
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
        .prepare(
          'SELECT i.id FROM items_fts f JOIN items i ON i.rowid = f.rowid WHERE items_fts MATCH ?',
        )
        .all<{ id: string }>('beach')
        .map((r) => r.id);
    expect(matchBeach()).toEqual(['m1']);

    db.prepare("UPDATE items SET description = 'birthday at the park' WHERE id = 'm1'").run();
    expect(matchBeach()).toEqual([]);
    expect(
      db
        .prepare(
          'SELECT i.id FROM items_fts f JOIN items i ON i.rowid = f.rowid WHERE items_fts MATCH ?',
        )
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

    const msg = db.prepare(
      "INSERT INTO items (id, media_type, content_hash) VALUES (?, 'message', NULL)",
    );
    msg.run('msg1');
    msg.run('msg2');
    const n = db
      .prepare('SELECT COUNT(*) AS n FROM items WHERE content_hash IS NULL')
      .get<{ n: number }>();
    expect(n?.n).toBe(2);
  });

  it('cascades occurrence rows when their source is deleted (undo foundation)', () => {
    runMigrations(db);
    db.prepare(
      "INSERT INTO sources (id, source_key, type, label) VALUES ('s1', 'key-1', 'folder', 'Folder')",
    ).run();
    db.prepare(
      "INSERT INTO items (id, media_type, content_hash) VALUES ('i1', 'photo', 'abc')",
    ).run();
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
    expect(db.prepare('SELECT COUNT(*) AS n FROM transcripts').get<{ n: number }>()?.n).toBe(0);
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
      .prepare(
        "SELECT media_type, description, search_meta, transcript_status FROM items WHERE id = 'a1'",
      )
      .get<{
        media_type: string;
        description: string;
        search_meta: string;
        transcript_status: string;
      }>();
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

// ── Migration 003: item_embeddings + embed_status drain (ADR-0029, M4-1) ─────

describe('migration 003 — item_embeddings + embed_status drain (ADR-0029)', () => {
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

  it('brings the catalog to schema version 3 and records 003_embeddings', () => {
    runMigrations(db, MIGRATIONS.slice(0, 3));
    expect(userVersion(db)).toBe(3);
    const names = db.prepare('SELECT name FROM migrations ORDER BY id').all<{ name: string }>();
    expect(names.map((r) => r.name)).toContain('003_embeddings');
  });

  it('adds item_embeddings with the expected columns, the embed_status column, and both indexes', () => {
    runMigrations(db);
    expect(tableNames(db).has('item_embeddings')).toBe(true);
    expect(columnNames(db, 'item_embeddings')).toEqual(
      new Set(['item_id', 'kind', 'model_id', 'dim', 'vector', 'created_at']),
    );
    expect(columnNames(db, 'items').has('embed_status')).toBe(true);
    for (const idx of ['idx_item_embeddings_item', 'idx_items_embed_queue']) {
      const row = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
        .get<{ name: string }>(idx);
      expect(row?.name).toBe(idx);
    }
  });

  it('defaults new items to embed_status = pending and enforces the status CHECK', () => {
    runMigrations(db);
    db.prepare("INSERT INTO items (id, media_type) VALUES ('i1', 'photo')").run();
    expect(
      db.prepare("SELECT embed_status FROM items WHERE id = 'i1'").get<{ embed_status: string }>()
        ?.embed_status,
    ).toBe('pending');
    // 'done'/'error'/'skipped' are valid; anything else is rejected by the CHECK.
    expect(() =>
      db.prepare("UPDATE items SET embed_status = 'bogus' WHERE id = 'i1'").run(),
    ).toThrow();
    for (const status of ['done', 'error', 'skipped']) {
      expect(() =>
        db.prepare('UPDATE items SET embed_status = ? WHERE id = ?').run(status, 'i1'),
      ).not.toThrow();
    }
  });

  it('enforces UNIQUE(item_id, model_id), defaults kind=text, and stamps a UTC created_at', () => {
    runMigrations(db);
    db.prepare("INSERT INTO items (id, media_type) VALUES ('i1', 'photo')").run();
    const insert = db.prepare(
      'INSERT INTO item_embeddings (item_id, model_id, dim, vector) VALUES (?, ?, ?, ?)',
    );
    insert.run('i1', 'model-a', 2, Buffer.alloc(8));
    // A second vector for the SAME (item, model) violates the UNIQUE key.
    expect(() => insert.run('i1', 'model-a', 2, Buffer.alloc(8))).toThrow();
    // A different model for the same item is allowed (provenance is explicit).
    expect(() => insert.run('i1', 'model-b', 2, Buffer.alloc(8))).not.toThrow();

    const row = db
      .prepare(
        "SELECT kind, created_at FROM item_embeddings WHERE item_id = 'i1' AND model_id = 'model-a'",
      )
      .get<{ kind: string; created_at: string }>();
    expect(row?.kind).toBe('text'); // ADR-0029 provenance column, defaulted for the text slice
    expect(row?.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('enforces the dim/vector integrity CHECK (vector byte length = dim*4, dim > 0)', () => {
    runMigrations(db);
    db.prepare("INSERT INTO items (id, media_type) VALUES ('i1', 'photo')").run();
    const insert = db.prepare(
      'INSERT INTO item_embeddings (item_id, model_id, dim, vector) VALUES (?, ?, ?, ?)',
    );
    // dim claims 2 (⇒ 8 bytes) but the float32 BLOB is only 4 bytes: rejected.
    expect(() => insert.run('i1', 'model-short', 2, Buffer.alloc(4))).toThrow();
    // dim claims 1 (⇒ 4 bytes) but the BLOB is 8 bytes: rejected.
    expect(() => insert.run('i1', 'model-long', 1, Buffer.alloc(8))).toThrow();
    // dim ≤ 0 is rejected even with a byte-consistent (empty) BLOB.
    expect(() => insert.run('i1', 'model-zero', 0, Buffer.alloc(0))).toThrow();
    // A BLOB of exactly dim*4 bytes with dim > 0 is accepted.
    expect(() => insert.run('i1', 'model-ok', 2, Buffer.alloc(8))).not.toThrow();
  });

  it('cascades item_embeddings rows when their item is deleted (a removable rendition)', () => {
    runMigrations(db);
    db.prepare("INSERT INTO items (id, media_type) VALUES ('i1', 'photo')").run();
    db.prepare(
      'INSERT INTO item_embeddings (item_id, model_id, dim, vector) VALUES (?, ?, ?, ?)',
    ).run('i1', 'model-a', 2, Buffer.alloc(8));
    db.prepare("DELETE FROM items WHERE id = 'i1'").run();
    expect(db.prepare('SELECT COUNT(*) AS n FROM item_embeddings').get<{ n: number }>()?.n).toBe(0);
  });

  it('forward-migrates a v2 catalog with NO data loss and a still-searchable items_fts', () => {
    // Bring the catalog to v2 only, then write data the way 002 shipped.
    runMigrations(db, MIGRATIONS.slice(0, 2));
    expect(userVersion(db)).toBe(2);
    db.prepare(
      "INSERT INTO items (id, media_type, description, search_meta) VALUES ('a1', 'audio', 'voice note', 'AUD_0001')",
    ).run();
    expect(ftsMatch(db, 'AUD_0001')).toEqual(['a1']);

    runMigrations(db);
    expect(userVersion(db)).toBe(MIGRATIONS.length);

    // The pre-existing row survives and is backfilled to embed_status = pending.
    const row = db
      .prepare("SELECT description, search_meta, embed_status FROM items WHERE id = 'a1'")
      .get<{ description: string; search_meta: string; embed_status: string }>();
    expect(row).toMatchObject({
      description: 'voice note',
      search_meta: 'AUD_0001',
      embed_status: 'pending',
    });
    // items_fts is untouched by 003 — the existing content stays searchable.
    expect(ftsMatch(db, 'AUD_0001')).toEqual(['a1']);
  });

  it('AC-29: the live FTS search() path returns identical results before and after migration 003', () => {
    // A v2 catalog seeded with known text; capture exact-search output BEFORE 003.
    runMigrations(db, MIGRATIONS.slice(0, 2));
    const repo = createCatalogRepo(db);
    const seed: [string, string, string][] = [
      ['m1', 'feliz cumpleaños en la playa', 'mateo familia'],
      ['m2', 'almuerzo familiar con la abuela', 'abuela familia'],
      ['m3', 'la playa al atardecer', 'mateo'],
    ];
    for (const [id, description, searchMeta] of seed) {
      repo.insertItem({ id, mediaType: 'message', description, searchMeta });
    }
    const queries = ['playa', 'familia', 'cumple', 'abuela'];
    const before = queries.map((query) => repo.search({ query, limit: 10, offset: 0 }));

    // Apply migration 003 — additive infrastructure that never touches items_fts.
    runMigrations(db, MIGRATIONS.slice(0, 3));
    expect(userVersion(db)).toBe(3);
    const after = queries.map((query) => repo.search({ query, limit: 10, offset: 0 }));

    // AC-7 preserved byte-for-byte: 003 does not change what the live path returns.
    expect(after).toEqual(before);
  });
});

// ── Migration 004: item_embeddings(model_id, dim) composite index (#215) ─────

describe('migration 004 — item_embeddings(model_id, dim) composite index (#215)', () => {
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

  it('brings the catalog to version 4 and records the 004 migration', () => {
    runMigrations(db, MIGRATIONS.slice(0, 4));
    expect(userVersion(db)).toBe(4);
    const names = db.prepare('SELECT name FROM migrations ORDER BY id').all<{ name: string }>();
    expect(names.map((r) => r.name)).toContain('004_item_embeddings_model_dim_index');
  });

  it('creates idx_item_embeddings_model_dim on (model_id, dim)', () => {
    runMigrations(db);
    const idx = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_item_embeddings_model_dim'",
      )
      .get<{ name: string }>();
    expect(idx?.name).toBe('idx_item_embeddings_model_dim');

    // The index columns are exactly (model_id, dim), in that order — the
    // semanticSearch `WHERE model_id = @modelId AND dim = @dim` scan predicate.
    const cols = db
      .prepare("PRAGMA index_info('idx_item_embeddings_model_dim')")
      .all<{ seqno: number; name: string }>()
      .sort((a, b) => a.seqno - b.seqno)
      .map((r) => r.name);
    expect(cols).toEqual(['model_id', 'dim']);
  });

  it('is idempotent: re-running keeps version 4 and one model_dim index', () => {
    runMigrations(db, MIGRATIONS.slice(0, 4));
    runMigrations(db, MIGRATIONS.slice(0, 4));
    expect(userVersion(db)).toBe(4);
    const n = db
      .prepare(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'index' AND name = 'idx_item_embeddings_model_dim'",
      )
      .get<{ n: number }>();
    expect(n?.n).toBe(1);
  });

  it('forward-migrates a v3 catalog, adding the index without data loss', () => {
    // Bring the catalog to v3 only, then write an embedding the way 003 shipped.
    runMigrations(db, MIGRATIONS.slice(0, 3));
    expect(userVersion(db)).toBe(3);
    db.prepare("INSERT INTO items (id, media_type) VALUES ('i1', 'photo')").run();
    db.prepare(
      'INSERT INTO item_embeddings (item_id, model_id, dim, vector) VALUES (?, ?, ?, ?)',
    ).run('i1', 'model-a', 2, Buffer.alloc(8));

    // Forward-migrate to the latest schema — 004 only adds the composite index.
    runMigrations(db);
    expect(userVersion(db)).toBe(MIGRATIONS.length);
    const idx = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_item_embeddings_model_dim'",
      )
      .get<{ name: string }>();
    expect(idx?.name).toBe('idx_item_embeddings_model_dim');

    // The pre-existing embedding row is untouched by the additive index.
    const row = db
      .prepare("SELECT model_id, dim FROM item_embeddings WHERE item_id = 'i1'")
      .get<{ model_id: string; dim: number }>();
    expect(row).toMatchObject({ model_id: 'model-a', dim: 2 });
  });
});

// ── Migration 005: categories + item_categories + collections provenance + a
//    per-item category_status drain (ADR-0030, M4-2/M4-3). Purely ADDITIVE — no
//    items_fts column change, so exact/semantic search stays byte-identical. ────

describe('migration 005 — categories, item_categories, collections provenance, category_status (ADR-0030)', () => {
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

  it('brings the catalog to schema version 5 and records 005_categories', () => {
    runMigrations(db);
    expect(userVersion(db)).toBe(5);
    const names = db.prepare('SELECT name FROM migrations ORDER BY id').all<{ name: string }>();
    expect(names.map((r) => r.name)).toContain('005_categories');
  });

  it('adds the categories and item_categories tables with exactly the specified columns', () => {
    runMigrations(db);
    expect(tableNames(db).has('categories')).toBe(true);
    expect(tableNames(db).has('item_categories')).toBe(true);
    expect(columnNames(db, 'categories')).toEqual(
      new Set(['id', 'kind', 'name', 'source_key', 'created_at']),
    );
    expect(columnNames(db, 'item_categories')).toEqual(
      new Set([
        'item_id',
        'category_id',
        'source',
        'state',
        'signal',
        'confidence',
        'explanation',
        'created_at',
      ]),
    );
  });

  it('adds the origin + category_id provenance columns on collections and category_status on items', () => {
    runMigrations(db);
    for (const col of ['origin', 'category_id']) {
      expect(columnNames(db, 'collections').has(col)).toBe(true);
    }
    expect(columnNames(db, 'items').has('category_status')).toBe(true);
  });

  it('creates the source_key partial-unique, kind, category, collections, and drain indexes', () => {
    runMigrations(db);
    for (const idx of [
      'idx_categories_source_key',
      'idx_categories_kind',
      'idx_item_categories_category',
      'idx_collections_category',
      'idx_items_category_queue',
    ]) {
      const row = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
        .get<{ name: string }>(idx);
      expect(row?.name).toBe(idx);
    }
  });

  it('enforces the categories.kind CHECK (person|place|theme)', () => {
    runMigrations(db);
    const ins = db.prepare("INSERT INTO categories (id, kind, name) VALUES (?, ?, 'X')");
    for (const kind of ['person', 'place', 'theme']) {
      expect(() => ins.run(`c-${kind}`, kind)).not.toThrow();
    }
    expect(() => ins.run('c-bad', 'foo')).toThrow();
  });

  it('keeps auto categories idempotent via the partial-UNIQUE source_key index, exempting NULLs', () => {
    runMigrations(db);
    const ins = db.prepare(
      "INSERT INTO categories (id, kind, name, source_key) VALUES (?, 'place', ?, ?)",
    );
    ins.run('c1', 'Cusco', 'gaz:cusco');
    // The same stable signal ⇒ a re-cluster can NOT duplicate the auto category.
    expect(() => ins.run('c2', 'Cusco (dup)', 'gaz:cusco')).toThrow();
    // A user-created category (NULL source_key) is exempt — many may coexist.
    const insNull = db.prepare(
      "INSERT INTO categories (id, kind, name, source_key) VALUES (?, 'theme', ?, NULL)",
    );
    insNull.run('u1', 'Beach days');
    insNull.run('u2', 'Birthdays');
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM categories WHERE source_key IS NULL').get<{
        n: number;
      }>()?.n,
    ).toBe(2);
  });

  it('defaults item_categories to source=auto/state=assigned, stamps created_at, and bounds confidence to [0,1] or NULL', () => {
    runMigrations(db);
    db.prepare("INSERT INTO items (id, media_type) VALUES ('i1', 'photo')").run();
    db.prepare("INSERT INTO categories (id, kind, name) VALUES ('c1', 'place', 'Cusco')").run();
    db.prepare(
      "INSERT INTO item_categories (item_id, category_id, signal, confidence, explanation) VALUES ('i1', 'c1', 'gps', 0.9, 'Near Cusco, Perú')",
    ).run();
    const row = db
      .prepare(
        "SELECT source, state, created_at FROM item_categories WHERE item_id = 'i1' AND category_id = 'c1' AND source = 'auto'",
      )
      .get<{ source: string; state: string; created_at: string }>();
    expect(row?.source).toBe('auto');
    expect(row?.state).toBe('assigned');
    expect(row?.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    // confidence: NULL (a certain, user-made assignment) and the [0,1] boundaries are accepted…
    const upd = db.prepare(
      "UPDATE item_categories SET confidence = ? WHERE item_id = 'i1' AND category_id = 'c1' AND source = 'auto'",
    );
    for (const c of [null, 0, 1, 0.42]) {
      expect(() => upd.run(c)).not.toThrow();
    }
    // …anything outside [0,1] is rejected by the CHECK.
    expect(() => upd.run(2)).toThrow();
    expect(() => upd.run(-0.5)).toThrow();
  });

  it('enforces the item_categories source / state / signal CHECK vocabularies', () => {
    runMigrations(db);
    db.prepare("INSERT INTO items (id, media_type) VALUES ('i1', 'photo')").run();
    db.prepare("INSERT INTO categories (id, kind, name) VALUES ('c1', 'place', 'Cusco')").run();
    // Each bad row is rejected by its own CHECK — none persists, so the PK never masks it.
    expect(() =>
      db
        .prepare(
          "INSERT INTO item_categories (item_id, category_id, source) VALUES ('i1', 'c1', 'bogus')",
        )
        .run(),
    ).toThrow();
    expect(() =>
      db
        .prepare(
          "INSERT INTO item_categories (item_id, category_id, source, state) VALUES ('i1', 'c1', 'user', 'x')",
        )
        .run(),
    ).toThrow();
    expect(() =>
      db
        .prepare(
          "INSERT INTO item_categories (item_id, category_id, signal) VALUES ('i1', 'c1', 'nonsense')",
        )
        .run(),
    ).toThrow();
    // A valid user 'removed' tombstone (source=user, state=removed, signal=user) is accepted.
    expect(() =>
      db
        .prepare(
          "INSERT INTO item_categories (item_id, category_id, source, state, signal) VALUES ('i1', 'c1', 'user', 'removed', 'user')",
        )
        .run(),
    ).not.toThrow();
  });

  it('allows one auto + one user row per (item, category) but rejects a duplicate source (PK)', () => {
    runMigrations(db);
    db.prepare("INSERT INTO items (id, media_type) VALUES ('i1', 'photo')").run();
    db.prepare("INSERT INTO categories (id, kind, name) VALUES ('c1', 'place', 'Cusco')").run();
    const ins = db.prepare(
      'INSERT INTO item_categories (item_id, category_id, source, state) VALUES (?, ?, ?, ?)',
    );
    ins.run('i1', 'c1', 'auto', 'assigned');
    // The user row COEXISTS with the auto row (dedup-with-provenance; user wins at read time).
    ins.run('i1', 'c1', 'user', 'removed');
    // A second 'auto' row for the same (item, category) violates the composite PK.
    expect(() => ins.run('i1', 'c1', 'auto', 'assigned')).toThrow();
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM item_categories WHERE item_id = 'i1' AND category_id = 'c1'",
        )
        .get<{ n: number }>()?.n,
    ).toBe(2);
  });

  it('defaults collections.origin=user and enforces the origin CHECK (user|suggested|dismissed)', () => {
    runMigrations(db);
    db.prepare("INSERT INTO collections (id, name) VALUES ('col1', 'My album')").run();
    const row = db
      .prepare("SELECT origin, category_id FROM collections WHERE id = 'col1'")
      .get<{ origin: string; category_id: string | null }>();
    expect(row?.origin).toBe('user');
    expect(row?.category_id).toBeNull();
    expect(() =>
      db.prepare("UPDATE collections SET origin = 'x' WHERE id = 'col1'").run(),
    ).toThrow();
    for (const origin of ['user', 'suggested', 'dismissed']) {
      expect(() =>
        db.prepare('UPDATE collections SET origin = ? WHERE id = ?').run(origin, 'col1'),
      ).not.toThrow();
    }
  });

  it('defaults items.category_status=pending and enforces its CHECK (pending|done|skipped|error)', () => {
    runMigrations(db);
    db.prepare("INSERT INTO items (id, media_type) VALUES ('i1', 'photo')").run();
    expect(
      db.prepare("SELECT category_status FROM items WHERE id = 'i1'").get<{
        category_status: string;
      }>()?.category_status,
    ).toBe('pending');
    expect(() =>
      db.prepare("UPDATE items SET category_status = 'x' WHERE id = 'i1'").run(),
    ).toThrow();
    for (const status of ['pending', 'done', 'skipped', 'error']) {
      expect(() =>
        db.prepare('UPDATE items SET category_status = ? WHERE id = ?').run(status, 'i1'),
      ).not.toThrow();
    }
  });

  it('cascades item_categories when its item is deleted, and when its category is deleted', () => {
    runMigrations(db);
    db.prepare("INSERT INTO items (id, media_type) VALUES ('i1', 'photo')").run();
    db.prepare("INSERT INTO categories (id, kind, name) VALUES ('c1', 'place', 'Cusco')").run();
    db.prepare(
      "INSERT INTO item_categories (item_id, category_id, source) VALUES ('i1', 'c1', 'auto')",
    ).run();
    // Deleting the item removes its derived assignment (ON DELETE CASCADE).
    db.prepare("DELETE FROM items WHERE id = 'i1'").run();
    expect(db.prepare('SELECT COUNT(*) AS n FROM item_categories').get<{ n: number }>()?.n).toBe(0);

    // Deleting the category also cascades its assignments.
    db.prepare("INSERT INTO items (id, media_type) VALUES ('i2', 'photo')").run();
    db.prepare(
      "INSERT INTO item_categories (item_id, category_id, source) VALUES ('i2', 'c1', 'auto')",
    ).run();
    db.prepare("DELETE FROM categories WHERE id = 'c1'").run();
    expect(db.prepare('SELECT COUNT(*) AS n FROM item_categories').get<{ n: number }>()?.n).toBe(0);
  });

  it('sets collections.category_id NULL when its category is deleted (link orphaned, collection kept)', () => {
    runMigrations(db);
    db.prepare("INSERT INTO categories (id, kind, name) VALUES ('c1', 'place', 'Cusco')").run();
    db.prepare(
      "INSERT INTO collections (id, name, origin, category_id) VALUES ('col1', 'Cusco trip', 'suggested', 'c1')",
    ).run();
    db.prepare("DELETE FROM categories WHERE id = 'c1'").run();
    const row = db
      .prepare("SELECT origin, category_id FROM collections WHERE id = 'col1'")
      .get<{ origin: string; category_id: string | null }>();
    // The provenance link is orphaned (SET NULL)…
    expect(row?.category_id).toBeNull();
    // …but the collection itself survives.
    expect(row?.origin).toBe('suggested');
  });

  it('is idempotent: re-running keeps version 5 and does not duplicate the new tables', () => {
    runMigrations(db);
    runMigrations(db);
    expect(userVersion(db)).toBe(5);
    const n = db
      .prepare(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('categories', 'item_categories')",
      )
      .get<{ n: number }>();
    expect(n?.n).toBe(2);
  });

  it('forward-migrates a v4 catalog with NO data loss and a still-searchable items_fts', () => {
    // Bring the catalog to v4 only, then write data the way 004 shipped.
    runMigrations(db, MIGRATIONS.slice(0, 4));
    expect(userVersion(db)).toBe(4);
    db.prepare(
      "INSERT INTO items (id, media_type, description, search_meta) VALUES ('a1', 'audio', 'voice note', 'AUD_0001')",
    ).run();
    db.prepare("INSERT INTO collections (id, name) VALUES ('col1', 'Album')").run();
    expect(ftsMatch(db, 'AUD_0001')).toEqual(['a1']);

    // Forward-migrate to the latest schema — 005 is additive.
    runMigrations(db);
    expect(userVersion(db)).toBe(MIGRATIONS.length);

    // The pre-existing rows survive and are backfilled to the new defaults.
    const item = db
      .prepare("SELECT description, search_meta, category_status FROM items WHERE id = 'a1'")
      .get<{ description: string; search_meta: string; category_status: string }>();
    expect(item).toMatchObject({
      description: 'voice note',
      search_meta: 'AUD_0001',
      category_status: 'pending',
    });
    const col = db
      .prepare("SELECT origin, category_id FROM collections WHERE id = 'col1'")
      .get<{ origin: string; category_id: string | null }>();
    expect(col).toMatchObject({ origin: 'user', category_id: null });
    // items_fts is untouched by 005 — the existing content stays searchable.
    expect(ftsMatch(db, 'AUD_0001')).toEqual(['a1']);
  });

  it('AC-29: the live FTS search() path returns identical results before and after migration 005', () => {
    // A v4 catalog seeded with known text; capture exact-search output BEFORE 005.
    runMigrations(db, MIGRATIONS.slice(0, 4));
    const repo = createCatalogRepo(db);
    const seed: [string, string, string][] = [
      ['m1', 'feliz cumpleaños en la playa', 'mateo familia'],
      ['m2', 'almuerzo familiar con la abuela', 'abuela familia'],
      ['m3', 'la playa al atardecer', 'mateo'],
    ];
    for (const [id, description, searchMeta] of seed) {
      repo.insertItem({ id, mediaType: 'message', description, searchMeta });
    }
    const queries = ['playa', 'familia', 'cumple', 'abuela'];
    const before = queries.map((query) => repo.search({ query, limit: 10, offset: 0 }));

    // Apply migration 005 — additive schema that never touches items_fts.
    runMigrations(db);
    expect(userVersion(db)).toBe(5);
    const after = queries.map((query) => repo.search({ query, limit: 10, offset: 0 }));

    // AC-7 preserved byte-for-byte: 005 does not change what the live path returns.
    expect(after).toEqual(before);
  });
});
