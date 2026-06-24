import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database, { type Database as Db } from 'better-sqlite3';
import { runMigrations } from '../../electron/main/db/migrate';
import {
  createCatalogRepo,
  mergeTokens,
  toFtsMatchQuery,
  toIsoUtc,
  type CatalogRepo,
} from '../../electron/main/db/catalog-repo';

function freshCatalog(): Db {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function count(db: Db, sql: string): number {
  return Number((db.prepare(sql).get<{ n: number }>() as { n: number }).n);
}

describe('mergeTokens (de-duplicated token union, AC-7)', () => {
  it('unions tokens from both sides, preserving first-seen order', () => {
    expect(mergeTokens('mateo beach', 'beach 2019 mateo')).toBe('mateo beach 2019');
  });
  it('tolerates null/empty operands', () => {
    expect(mergeTokens(null, 'a b')).toBe('a b');
    expect(mergeTokens('a b', null)).toBe('a b');
    expect(mergeTokens(null, null)).toBe('');
    expect(mergeTokens('  a   b ', '')).toBe('a b');
  });
});

describe('toIsoUtc (canonical capture_date)', () => {
  it('renders a Date as an ISO-8601 UTC instant with a Z suffix', () => {
    expect(toIsoUtc(new Date(Date.UTC(2019, 5, 14, 13, 45, 30)))).toBe('2019-06-14T13:45:30.000Z');
  });
});

describe('toFtsMatchQuery (FTS5 input hardening)', () => {
  it('builds a per-token prefix query, escaping quotes', () => {
    expect(toFtsMatchQuery('hola mundo')).toBe('"hola"* "mundo"*');
    expect(toFtsMatchQuery('a"b')).toBe('"a""b"*');
  });
  it('returns null when nothing tokenizable remains (no FTS syntax errors)', () => {
    expect(toFtsMatchQuery('   ')).toBeNull();
    expect(toFtsMatchQuery('-- () *')).toBeNull();
  });
});

describe('CatalogRepo (dedup-with-provenance, ADR-0003)', () => {
  let db: Db;
  let repo: CatalogRepo;

  beforeEach(() => {
    db = freshCatalog();
    repo = createCatalogRepo(db);
  });
  afterEach(() => db.close());

  describe('registerSource', () => {
    it('reuses the row id for the same source_key (stable identity, idempotent re-import)', () => {
      const first = repo.registerSource({ sourceKey: 'sha-1', type: 'whatsapp', label: 'Mum backup' });
      const again = repo.registerSource({ sourceKey: 'sha-1', type: 'whatsapp', label: 'Mum backup (re)' });
      expect(again).toBe(first);
      expect(count(db, 'SELECT COUNT(*) n FROM sources')).toBe(1);
      const label = db.prepare('SELECT label FROM sources WHERE id = ?').get<{ label: string }>(first);
      expect(label?.label).toBe('Mum backup (re)');
    });
    it('allocates a distinct id for a different source_key', () => {
      const a = repo.registerSource({ sourceKey: 'k-a', type: 'folder', label: 'A' });
      const b = repo.registerSource({ sourceKey: 'k-b', type: 'folder', label: 'B' });
      expect(a).not.toBe(b);
      expect(count(db, 'SELECT COUNT(*) n FROM sources')).toBe(2);
    });
  });

  describe('insertItem', () => {
    it('dedups by content_hash and returns the same item id', () => {
      const id1 = repo.insertItem({ mediaType: 'photo', contentHash: 'h-photo', originalExt: '.jpg' });
      const id2 = repo.insertItem({ mediaType: 'photo', contentHash: 'h-photo', originalExt: '.jpg' });
      expect(id2).toBe(id1);
      expect(count(db, 'SELECT COUNT(*) n FROM items')).toBe(1);
    });

    it('fills missing fields without clobbering existing ones (COALESCE merge)', () => {
      const id = repo.insertItem({ mediaType: 'photo', contentHash: 'h', captureDate: null, mimeType: null });
      repo.insertItem({
        mediaType: 'photo',
        contentHash: 'h',
        captureDate: '2019-06-14T13:45:30.000Z',
        captureDateSrc: 'exif',
        mimeType: 'image/jpeg',
      });
      // A later record with a different date must NOT overwrite the now-set value.
      repo.insertItem({ mediaType: 'photo', contentHash: 'h', captureDate: '2000-01-01T00:00:00.000Z' });
      const row = db
        .prepare('SELECT capture_date, capture_date_src, mime_type FROM items WHERE id = ?')
        .get<{ capture_date: string; capture_date_src: string; mime_type: string }>(id);
      expect(row?.capture_date).toBe('2019-06-14T13:45:30.000Z');
      expect(row?.capture_date_src).toBe('exif');
      expect(row?.mime_type).toBe('image/jpeg');
    });

    it('never dedups NULL-hash messages (each is its own 1:1 item)', () => {
      const a = repo.insertItem({ mediaType: 'message', description: 'hi' });
      const b = repo.insertItem({ mediaType: 'message', description: 'hi' });
      expect(a).not.toBe(b);
      expect(count(db, 'SELECT COUNT(*) n FROM items')).toBe(2);
    });

    it('merges search_meta tokens across sources so dedup keeps cross-source search (AC-7)', () => {
      repo.insertItem({ mediaType: 'photo', contentHash: 'h', searchMeta: 'IMG_0001 mum' });
      const id = repo.insertItem({ mediaType: 'photo', contentHash: 'h', searchMeta: 'birthday mum' });
      const row = db.prepare('SELECT search_meta FROM items WHERE id = ?').get<{ search_meta: string }>(id);
      expect(row?.search_meta).toBe('IMG_0001 mum birthday');
      // The AFTER UPDATE trigger must have re-synced FTS for BOTH sources' tokens.
      const byFilename = repo.search({ query: 'IMG_0001', limit: 10, offset: 0 });
      const byCaption = repo.search({ query: 'birthday', limit: 10, offset: 0 });
      expect(byFilename.rows.map((r) => r.id)).toEqual([id]);
      expect(byCaption.rows.map((r) => r.id)).toEqual([id]);
    });
  });

  describe('addOccurrence', () => {
    it('keeps one occurrence per source for a deduped item, and is idempotent on re-import', () => {
      const sourceA = repo.registerSource({ sourceKey: 'A', type: 'whatsapp', label: 'A' });
      const sourceB = repo.registerSource({ sourceKey: 'B', type: 'google_takeout', label: 'B' });
      const itemId = repo.insertItem({ mediaType: 'photo', contentHash: 'shared', originalExt: '.jpg' });

      const occA = repo.addOccurrence({
        itemId,
        sourceId: sourceA,
        sourceRef: 'chat/IMG_0001.jpg',
        originalKind: 'content_addressed',
      });
      const occB = repo.addOccurrence({
        itemId,
        sourceId: sourceB,
        sourceRef: 'Takeout/Photos/IMG_0001.jpg',
        originalKind: 'content_addressed',
      });
      expect(occA.inserted).toBe(true);
      expect(occB.inserted).toBe(true);
      expect(occA.id).not.toBe(occB.id);
      expect(count(db, 'SELECT COUNT(*) n FROM item_occurrences')).toBe(2);

      // Re-importing source A (same item/source/ref) must not duplicate.
      const occARe = repo.addOccurrence({
        itemId,
        sourceId: sourceA,
        sourceRef: 'chat/IMG_0001.jpg',
        originalKind: 'content_addressed',
      });
      expect(occARe.inserted).toBe(false);
      expect(occARe.id).toBe(occA.id);
      expect(count(db, 'SELECT COUNT(*) n FROM item_occurrences')).toBe(2);
    });
  });

  describe('addAsset', () => {
    it('upserts a rendition keyed by (item, kind)', () => {
      const itemId = repo.insertItem({ mediaType: 'photo', contentHash: 'h' });
      repo.addAsset({ itemId, kind: 'thumbnail', path: 'derived/thumbnails/aa/h.webp' });
      repo.addAsset({ itemId, kind: 'thumbnail', path: 'derived/thumbnails/aa/h-v2.webp', width: 320 });
      expect(count(db, 'SELECT COUNT(*) n FROM item_assets')).toBe(1);
      const row = db
        .prepare("SELECT path, width FROM item_assets WHERE item_id = ? AND kind = 'thumbnail'")
        .get<{ path: string; width: number }>(itemId);
      expect(row?.path).toBe('derived/thumbnails/aa/h-v2.webp');
      expect(row?.width).toBe(320);
    });
  });

  describe('queryTimeline (composite keyset cursor, NULLS LAST — AC-6/AC-8)', () => {
    beforeEach(() => {
      const rows: [string, string | null][] = [
        ['a', '2020-01-03T00:00:00.000Z'],
        ['b', '2020-01-02T00:00:00.000Z'],
        ['c', '2020-01-02T00:00:00.000Z'],
        ['d', '2020-01-01T00:00:00.000Z'],
        ['e', null],
        ['f', null],
      ];
      for (const [id, captureDate] of rows) {
        repo.insertItem({ id, mediaType: 'photo', contentHash: `hash-${id}`, captureDate });
      }
    });

    it('orders by capture_date DESC, then id DESC, with undated rows last', () => {
      const page = repo.queryTimeline({ limit: 10 });
      expect(page.rows.map((r) => r.id)).toEqual(['a', 'c', 'b', 'd', 'f', 'e']);
      expect(page.nextCursor).toBeNull();
    });

    it('paginates through equal timestamps and into the NULL tail with no skips or duplicates', () => {
      const collected: string[] = [];
      let cursor = null as ReturnType<CatalogRepo['queryTimeline']>['nextCursor'];
      for (let guard = 0; guard < 10; guard += 1) {
        const page = repo.queryTimeline({ limit: 2, cursor });
        collected.push(...page.rows.map((r) => r.id));
        cursor = page.nextCursor;
        if (cursor === null) break;
      }
      expect(collected).toEqual(['a', 'c', 'b', 'd', 'f', 'e']);
    });
  });

  describe('search (FTS5)', () => {
    beforeEach(() => {
      repo.insertItem({ mediaType: 'message', description: 'feliz cumpleaños en la playa', searchMeta: 'mateo familia' });
      repo.insertItem({ mediaType: 'message', description: 'almuerzo familiar', searchMeta: 'abuela familia' });
    });

    it('matches by token prefix and reports the total', () => {
      const res = repo.search({ query: 'cumple', limit: 10, offset: 0 });
      expect(res.total).toBe(1);
      expect(res.rows).toHaveLength(1);
      expect(res.rows[0]?.description).toContain('cumpleaños');
    });

    it('returns an empty result (never throws) for a query with no tokenizable content', () => {
      expect(repo.search({ query: '   -- ', limit: 10, offset: 0 })).toEqual({ rows: [], total: 0 });
    });

    it('honours limit/offset paging over the match set', () => {
      const all = repo.search({ query: 'familia', limit: 10, offset: 0 });
      expect(all.total).toBe(2);
      const page0 = repo.search({ query: 'familia', limit: 1, offset: 0 });
      const page1 = repo.search({ query: 'familia', limit: 1, offset: 1 });
      expect(page0.rows).toHaveLength(1);
      expect(page1.rows).toHaveLength(1);
      expect(page0.total).toBe(2);
      expect(page0.rows[0]?.id).not.toBe(page1.rows[0]?.id);
      expect(new Set([page0.rows[0]?.id, page1.rows[0]?.id])).toEqual(
        new Set(all.rows.map((r) => r.id)),
      );
    });
  });
});
