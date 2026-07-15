import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import Database, { type Database as Db } from 'better-sqlite3';
import { runMigrations } from '../../electron/main/db/migrate';
import {
  createCatalogRepo,
  mergeTokens,
  toFtsMatchQuery,
  toIsoUtc,
  type CatalogRepo,
} from '../../electron/main/db/catalog-repo';
import { makeTmpDir, removeTmpDir } from '../helpers/tmp';

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

  describe('setFavourite (#434 favourite-toggle write path)', () => {
    it('marks an item favourite and persists it in the is_favourite column', () => {
      const id = repo.insertItem({ mediaType: 'photo', contentHash: 'h-fav' });
      expect(repo.getItemsByIds([id])[0]?.isFavourite).toBe(false);

      const result = repo.setFavourite({ id, favourite: true });

      expect(result).toBe(true);
      const row = db
        .prepare('SELECT is_favourite FROM items WHERE id = ?')
        .get<{ is_favourite: number }>(id);
      expect(row?.is_favourite).toBe(1);
      expect(repo.getItemsByIds([id])[0]?.isFavourite).toBe(true);
    });

    it('unmarks a favourite item back to false', () => {
      const id = repo.insertItem({ mediaType: 'photo', contentHash: 'h-unfav' });
      repo.setFavourite({ id, favourite: true });

      const result = repo.setFavourite({ id, favourite: false });

      expect(result).toBe(false);
      expect(repo.getItemsByIds([id])[0]?.isFavourite).toBe(false);
    });

    it('is idempotent — setting the same value twice leaves exactly one row and the same value', () => {
      const id = repo.insertItem({ mediaType: 'photo', contentHash: 'h-idem' });
      repo.setFavourite({ id, favourite: true });
      repo.setFavourite({ id, favourite: true });

      expect(count(db, 'SELECT COUNT(*) n FROM items')).toBe(1);
      expect(repo.getItemsByIds([id])[0]?.isFavourite).toBe(true);
    });

    it('returns null when the id names no item (unknown id is not silently ignored)', () => {
      const result = repo.setFavourite({ id: 'no-such-id', favourite: true });
      expect(result).toBeNull();
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

  describe('search — source filter (AC-7)', () => {
    let whatsapp: string;
    let folder: string;

    // Seed a message-shaped memory matching "familia" and pin it to one source.
    function seedFrom(description: string, sourceId: string, ref: string, hash: string): string {
      const itemId = repo.insertItem({ mediaType: 'message', description, contentHash: hash });
      repo.addOccurrence({ itemId, sourceId, sourceRef: ref });
      return itemId;
    }

    beforeEach(() => {
      whatsapp = repo.registerSource({ sourceKey: 'wa', type: 'whatsapp', label: 'Mum WhatsApp' });
      folder = repo.registerSource({ sourceKey: 'fold', type: 'folder', label: 'Photos folder' });
      // Two WhatsApp-sourced memories and one folder-sourced memory — every one matches "familia".
      seedFrom('familia en la playa', whatsapp, 'wa/1', 'h-wa-1');
      seedFrom('familia en la montaña', whatsapp, 'wa/2', 'h-wa-2');
      seedFrom('familia con la abuela', folder, 'fold/1', 'h-fold-1');
    });

    it('narrows a query to a single connector source, leaving every other source out', () => {
      const res = repo.search({ query: 'familia', limit: 10, offset: 0, source: 'whatsapp' });
      expect(res.total).toBe(2);
      expect(res.rows).toHaveLength(2);
      expect(res.rows.every((r) => r.source === 'whatsapp')).toBe(true);
    });

    it('returns memories from every source when no source filter is given (back-compat)', () => {
      const res = repo.search({ query: 'familia', limit: 10, offset: 0 });
      expect(res.total).toBe(3);
      expect(new Set(res.rows.map((r) => r.source))).toEqual(new Set(['whatsapp', 'folder']));
    });

    it('composes the source filter with limit/offset paging over the filtered set', () => {
      const all = repo.search({ query: 'familia', limit: 10, offset: 0, source: 'whatsapp' });
      expect(all.total).toBe(2);
      const page0 = repo.search({ query: 'familia', limit: 1, offset: 0, source: 'whatsapp' });
      const page1 = repo.search({ query: 'familia', limit: 1, offset: 1, source: 'whatsapp' });
      expect(page0.rows).toHaveLength(1);
      expect(page1.rows).toHaveLength(1);
      expect(page0.total).toBe(2);
      expect(page1.total).toBe(2);
      expect(page0.rows[0]?.source).toBe('whatsapp');
      expect(page0.rows[0]?.id).not.toBe(page1.rows[0]?.id);
      expect(new Set([page0.rows[0]?.id, page1.rows[0]?.id])).toEqual(
        new Set(all.rows.map((r) => r.id)),
      );
    });

    it('finds a memory shared across sources from either side, and never invents an out-of-filter row', () => {
      // One deduped logical item with occurrences in BOTH whatsapp and folder (but not linkedin).
      const shared = repo.insertItem({
        mediaType: 'photo',
        description: 'familia reunion',
        contentHash: 'h-shared',
      });
      repo.addOccurrence({ itemId: shared, sourceId: whatsapp, sourceRef: 'wa/shared' });
      repo.addOccurrence({ itemId: shared, sourceId: folder, sourceRef: 'fold/shared' });

      const fromWhatsapp = repo.search({ query: 'reunion', limit: 10, offset: 0, source: 'whatsapp' });
      const fromFolder = repo.search({ query: 'reunion', limit: 10, offset: 0, source: 'folder' });
      const fromLinkedin = repo.search({ query: 'reunion', limit: 10, offset: 0, source: 'linkedin' });
      expect(fromWhatsapp.rows.map((r) => r.id)).toEqual([shared]);
      expect(fromFolder.rows.map((r) => r.id)).toEqual([shared]);
      // No occurrence from LinkedIn → the shared item must never surface under that filter.
      expect(fromLinkedin.rows).toHaveLength(0);
      expect(fromLinkedin.total).toBe(0);
    });

    it("projects each result row's connector source for display", () => {
      const res = repo.search({ query: 'playa', limit: 10, offset: 0 });
      expect(res.rows).toHaveLength(1);
      expect(res.rows[0]?.source).toBe('whatsapp');
    });
  });

  describe('getItemsByIds (semantic-hit hydration — ADR-0029 / M4-1b)', () => {
    let whatsapp: string;
    let folder: string;

    beforeEach(() => {
      whatsapp = repo.registerSource({ sourceKey: 'wa', type: 'whatsapp', label: 'WhatsApp' });
      folder = repo.registerSource({ sourceKey: 'fold', type: 'folder', label: 'Folder' });
    });

    it('hydrates the requested ids with the full ItemRow projection, including source', () => {
      const a = repo.insertItem({ mediaType: 'message', description: 'uno', contentHash: 'h-a' });
      repo.addOccurrence({ itemId: a, sourceId: whatsapp, sourceRef: 'wa/1' });
      const b = repo.insertItem({ mediaType: 'photo', description: 'dos', contentHash: 'h-b' });
      repo.addOccurrence({ itemId: b, sourceId: folder, sourceRef: 'fold/1' });

      const rows = repo.getItemsByIds([a, b]);

      expect(new Set(rows.map((r) => r.id))).toEqual(new Set([a, b]));
      expect(new Set(rows.map((r) => r.source))).toEqual(new Set(['whatsapp', 'folder']));
      // A full projection (not just ids): a payload field round-trips.
      expect(rows.find((r) => r.id === a)?.description).toBe('uno');
    });

    it('ignores unknown ids and returns [] for an empty id list', () => {
      const a = repo.insertItem({ mediaType: 'message', contentHash: 'h-a' });
      repo.addOccurrence({ itemId: a, sourceId: whatsapp, sourceRef: 'wa/1' });

      expect(repo.getItemsByIds([])).toEqual([]);
      expect(repo.getItemsByIds(['no-such-id', a]).map((r) => r.id)).toEqual([a]);
    });

    it('applies the same source filter as search (never hydrates an out-of-source item)', () => {
      const wa = repo.insertItem({ mediaType: 'message', contentHash: 'h-wa' });
      repo.addOccurrence({ itemId: wa, sourceId: whatsapp, sourceRef: 'wa/1' });
      const fo = repo.insertItem({ mediaType: 'photo', contentHash: 'h-fo' });
      repo.addOccurrence({ itemId: fo, sourceId: folder, sourceRef: 'fold/1' });

      expect(repo.getItemsByIds([wa, fo], 'whatsapp').map((r) => r.id)).toEqual([wa]);
    });

    it('finds a memory shared across sources under either source filter (AC-7 parity)', () => {
      const shared = repo.insertItem({ mediaType: 'photo', contentHash: 'h-shared' });
      repo.addOccurrence({ itemId: shared, sourceId: whatsapp, sourceRef: 'wa/s' });
      repo.addOccurrence({ itemId: shared, sourceId: folder, sourceRef: 'fold/s' });

      expect(repo.getItemsByIds([shared], 'whatsapp').map((r) => r.id)).toEqual([shared]);
      expect(repo.getItemsByIds([shared], 'folder').map((r) => r.id)).toEqual([shared]);
      expect(repo.getItemsByIds([shared], 'linkedin')).toHaveLength(0);
    });
  });
});

describe('setFavourite persists across a restart (#434 — file-backed db, not the in-memory fixture)', () => {
  it('is readable by a brand-new connection + repo opened over the same catalog file', () => {
    const dir = makeTmpDir('fav-restart');
    const path = join(dir, 'catalog.sqlite3');
    try {
      // "Session 1": write the favourite, then close — mirrors an app quit.
      const firstDb = new Database(path);
      firstDb.pragma('foreign_keys = ON');
      runMigrations(firstDb);
      const firstRepo = createCatalogRepo(firstDb);
      const id = firstRepo.insertItem({ mediaType: 'photo', contentHash: 'h-restart' });
      const result = firstRepo.setFavourite({ id, favourite: true });
      expect(result).toBe(true);
      firstDb.close();

      // "Session 2": a fresh connection/repo over the SAME file — mirrors a relaunch.
      const secondDb = new Database(path);
      const secondRepo = createCatalogRepo(secondDb);
      expect(secondRepo.getItemsByIds([id])[0]?.isFavourite).toBe(true);
      secondDb.close();
    } finally {
      removeTmpDir(dir);
    }
  });
});
