// Unit tests for the categorization orchestrator (T-M4-2g / #269). Mirrors the
// embedding-orchestrator test style: a real in-memory better-sqlite3 catalog with
// migrations applied (NO DB mocking), real leaf collaborators (categories repo,
// gazetteer, cluster passes), and a recording inline cluster transport that stands
// in for the worker thread. The oracles are discriminating: concrete category_status
// values, category rows keyed by source_key, and assignment provenance (signal /
// confidence / explanation) — never merely "it ran".

import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as Db } from 'better-sqlite3';

import { runMigrations } from '../../electron/main/db/migrate';
import { createCatalogRepo } from '../../electron/main/db/catalog-repo';
import { createEmbeddingsRepo } from '../../electron/main/db/embeddings-repo';
import {
  createCategoriesRepo,
  type CategoriesRepo,
} from '../../electron/main/categorize/categories-repo';
import {
  createGazetteer,
  placeSourceKey,
  type Gazetteer,
  type GazetteerEntry,
} from '../../electron/main/categorize/gazetteer';
import { clusterPlaces } from '../../electron/main/categorize/places-cluster';
import { clusterThemes, themeSourceKey } from '../../electron/main/categorize/themes-cluster';
import { EMBED_DIM, EMBED_MODEL_ID } from '../../electron/main/search/embed-cli';
import {
  CATEGORIZATION_CONSENT_KEY,
  PLACE_ASSIGNMENT_CONFIDENCE,
  buildCategorizeText,
  createCategorizationOrchestrator,
  createCategorizationStore,
  resolveCategorizationStatus,
  type CategorizableItem,
  type CategorizationOrchestrator,
  type CategorizationRunSnapshot,
  type CategorizationStatus,
  type CategorizationStore,
  type ClusterRequest,
  type ClusterResponse,
  type ClusterTransport,
} from '../../electron/main/categorize/categorization-orchestrator';
import type { MediaType } from '@shared/catalog';

// ── Fixtures ────────────────────────────────────────────────────────────────

const openDbs: Db[] = [];

afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
  vi.restoreAllMocks();
});

function freshCatalog(): Db {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  openDbs.push(db);
  return db;
}

/** A constant unit vector; two items sharing a fill have cosine similarity 1. */
function vec(fill: number): Float32Array {
  return Float32Array.from({ length: EMBED_DIM }, () => fill);
}

// Two GeoNames cities; a centroid near Cusco reverse-geocodes to Cusco.
const CUSCO: GazetteerEntry = {
  id: 3941584,
  name: 'Cusco',
  lat: -13.5319,
  lon: -71.9675,
  admin1: '08',
  country: 'PE',
};
const LIMA: GazetteerEntry = {
  id: 3936456,
  name: 'Lima',
  lat: -12.0464,
  lon: -77.0428,
  admin1: '15',
  country: 'PE',
};
const GAZETTEER_FIXTURE: readonly GazetteerEntry[] = [CUSCO, LIMA];

// Three coordinates a few metres apart, all effectively "at" Cusco.
const CUSCO_A = { lat: -13.532, lon: -71.9675 };
const CUSCO_B = { lat: -13.5325, lon: -71.968 };
const CUSCO_C = { lat: -13.5318, lon: -71.967 };

interface SeedItem {
  id: string;
  gpsLat?: number | null;
  gpsLon?: number | null;
  description?: string | null;
  searchMeta?: string | null;
  /** Fill for a DONE embedding vector; omitted ⇒ the item has no embedding. */
  embed?: number;
  mediaType?: MediaType;
}

/** Run the two cluster passes inline — the in-test stand-in for the worker thread. */
function runInline(request: ClusterRequest): ClusterResponse {
  const response: ClusterResponse = {};
  if (request.places !== undefined) {
    response.places = clusterPlaces(request.places.points, request.places.options);
  }
  if (request.themes !== undefined) {
    response.themes = clusterThemes(request.themes.items, request.themes.options);
  }
  return response;
}

interface HarnessOptions {
  seed?: readonly SeedItem[];
  gazetteer?: Gazetteer;
  transport?: ClusterTransport;
  getStatus?: () => CategorizationStatus;
  wrapCategories?: (real: CategoriesRepo) => CategoriesRepo;
  store?: CategorizationStore;
  batchSize?: number;
  signal?: AbortSignal;
  onProgress?: (snapshot: CategorizationRunSnapshot) => void;
}

function harness(options: HarnessOptions = {}): {
  db: Db;
  orchestrator: CategorizationOrchestrator;
  categories: CategoriesRepo;
  requests: ClusterRequest[];
  emitted: CategorizationRunSnapshot[];
} {
  const db = freshCatalog();
  const catalog = createCatalogRepo(db);
  const embeddings = createEmbeddingsRepo(db);
  for (const item of options.seed ?? []) {
    catalog.insertItem({
      id: item.id,
      mediaType: item.mediaType ?? (item.gpsLat != null ? 'photo' : 'message'),
      gpsLat: item.gpsLat ?? null,
      gpsLon: item.gpsLon ?? null,
      description: item.description ?? null,
      searchMeta: item.searchMeta ?? null,
    });
    if (item.embed !== undefined) {
      embeddings.upsertEmbedding(item.id, EMBED_MODEL_ID, vec(item.embed));
    }
  }

  const realCategories = createCategoriesRepo(db);
  const categories = options.wrapCategories
    ? options.wrapCategories(realCategories)
    : realCategories;
  const store = options.store ?? createCategorizationStore(db);
  const gazetteer = options.gazetteer ?? createGazetteer(GAZETTEER_FIXTURE);

  const requests: ClusterRequest[] = [];
  const transport: ClusterTransport = options.transport ?? {
    run: (request) => {
      requests.push(request);
      return Promise.resolve(runInline(request));
    },
  };

  const emitted: CategorizationRunSnapshot[] = [];
  const orchestrator = createCategorizationOrchestrator({
    store,
    categories,
    gazetteer,
    transport,
    getStatus: options.getStatus ?? (() => ({ available: true })),
    // Relaxed thresholds so small fixtures still form clusters; the leaf modules
    // own the default-threshold behaviour, this suite owns the orchestration.
    placesOptions: { epsMeters: 2000, minPts: 2 },
    themesOptions: { minClusterSize: 2 },
    onProgress: (snapshot) => {
      emitted.push(snapshot);
      options.onProgress?.(snapshot);
    },
    ...(options.batchSize !== undefined ? { batchSize: options.batchSize } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  });

  return { db, orchestrator, categories, requests, emitted };
}

function categoryStatusOf(db: Db, id: string): string {
  const row = db
    .prepare('SELECT category_status FROM items WHERE id = ?')
    .get<{ category_status: string }>(id);
  return row?.category_status ?? '';
}

interface RawCategory {
  id: string;
  kind: string;
  name: string;
  source_key: string | null;
}

function allCategories(db: Db): RawCategory[] {
  return db
    .prepare('SELECT id, kind, name, source_key FROM categories ORDER BY source_key')
    .all<RawCategory>();
}

// ── buildCategorizeText ───────────────────────────────────────────────────────

describe('buildCategorizeText', () => {
  it('joins the non-empty description and search metadata', () => {
    expect(buildCategorizeText({ description: 'Beach day', searchMeta: 'Cusco 2019' })).toBe(
      'Beach day\nCusco 2019',
    );
  });

  it('returns just the present field when the other is null or blank', () => {
    expect(buildCategorizeText({ description: 'Only this', searchMeta: null })).toBe('Only this');
    expect(buildCategorizeText({ description: '   ', searchMeta: 'Meta' })).toBe('Meta');
  });

  it('returns null when there is no text at all', () => {
    expect(buildCategorizeText({ description: null, searchMeta: null })).toBeNull();
    expect(buildCategorizeText({ description: '  ', searchMeta: '' })).toBeNull();
  });
});

// ── resolveCategorizationStatus (the typed UNAVAILABLE sentinel) ──────────────

describe('resolveCategorizationStatus', () => {
  it('refuses when the user has not opted in, regardless of signals', () => {
    expect(
      resolveCategorizationStatus({ optedIn: false, placesAvailable: true, themesAvailable: true }),
    ).toEqual({ available: false, reason: 'not-opted-in' });
  });

  it('refuses when opted in but neither a place nor a theme signal is available', () => {
    expect(
      resolveCategorizationStatus({
        optedIn: true,
        placesAvailable: false,
        themesAvailable: false,
      }),
    ).toEqual({ available: false, reason: 'no-signal' });
  });

  it('is available when opted in and at least one signal is present', () => {
    expect(
      resolveCategorizationStatus({
        optedIn: true,
        placesAvailable: true,
        themesAvailable: false,
      }),
    ).toEqual({ available: true });
    expect(
      resolveCategorizationStatus({
        optedIn: true,
        placesAvailable: false,
        themesAvailable: true,
      }),
    ).toEqual({ available: true });
  });

  it('exposes a stable consent key for the opt-in store (successor #270)', () => {
    expect(CATEGORIZATION_CONSENT_KEY).toBe('categorizationOptedIn');
  });
});

// ── The store (real in-memory DB, no mocking) ─────────────────────────────────

describe('createCategorizationStore', () => {
  it('lists only pending items and yields an embedding only when embed_status is done', () => {
    const db = freshCatalog();
    const catalog = createCatalogRepo(db);
    const embeddings = createEmbeddingsRepo(db);
    catalog.insertItem({ id: 'a', mediaType: 'message', description: 'x' });
    embeddings.upsertEmbedding('a', EMBED_MODEL_ID, vec(0.5));
    const store = createCategorizationStore(db);

    const [withVec] = store.listPendingCategorization(null, 10);
    expect(withVec.embedding).not.toBeNull();
    expect(withVec.embedding).toHaveLength(EMBED_DIM);

    // The vector row survives, but flipping the drain flag off must hide it.
    db.prepare("UPDATE items SET embed_status = 'error' WHERE id = 'a'").run();
    expect(store.listPendingCategorization(null, 10)[0].embedding).toBeNull();

    // A done categorization is no longer pending.
    store.markCategorized('a');
    expect(store.listPendingCategorization(null, 10)).toHaveLength(0);
  });

  it('paginates by ascending id via the afterId keyset', () => {
    const db = freshCatalog();
    const catalog = createCatalogRepo(db);
    for (const id of ['a', 'b', 'c']) catalog.insertItem({ id, mediaType: 'message' });
    const store = createCategorizationStore(db);

    const first = store.listPendingCategorization(null, 2);
    expect(first.map((i) => i.id)).toEqual(['a', 'b']);
    const next = store.listPendingCategorization('b', 2);
    expect(next.map((i) => i.id)).toEqual(['c']);
  });

  // Regression cover for #340: the pending keyset is served by a split first
  // vs subsequent-page SQL (no `OR (@afterId IS NULL OR i.id > @afterId)`) so
  // migration 005's partial `idx_items_category_queue` index can serve the
  // ordered scan. The ordering / boundary semantics MUST be identical to a
  // single-statement drain — this test walks every page and asserts the
  // concatenation equals a single "all pending, ordered by id" read, and that
  // an afterId equal to the last id yields no rows.
  it('walks every keyset page in strict ascending id order across a mixed corpus', () => {
    const db = freshCatalog();
    const catalog = createCatalogRepo(db);
    // Interleave non-pending statuses to prove the partial-index scan skips
    // them and the split first/subsequent SQL still emits the SAME ordered
    // sequence a single query would.
    const ids = ['i1', 'i2', 'i3', 'i4', 'i5', 'i6', 'i7'];
    for (const id of ids) catalog.insertItem({ id, mediaType: 'message' });
    const store = createCategorizationStore(db);
    // Flip a few out of the pending set: `i2` done, `i5` error, `i6` skipped.
    store.markCategorized('i2');
    store.markCategoryFailed('i5');
    store.markCategorySkipped('i6');
    const expectedPending = ['i1', 'i3', 'i4', 'i7'];

    // A single-page read of every pending row (the reference ordering).
    const oneShot = store.listPendingCategorization(null, 100).map((i) => i.id);
    expect(oneShot).toEqual(expectedPending);

    // Walk with batchSize 2 — exercises the first-page branch (afterId=null)
    // AND the subsequent-page branch (afterId set) and must produce the same
    // ordered sequence.
    const walked: string[] = [];
    let afterId: string | null = null;
    for (;;) {
      const page = store.listPendingCategorization(afterId, 2);
      if (page.length === 0) break;
      for (const item of page) walked.push(item.id);
      afterId = page[page.length - 1].id;
      if (page.length < 2) break;
    }
    expect(walked).toEqual(expectedPending);

    // After the last id, the subsequent-page branch yields an empty page.
    expect(store.listPendingCategorization('i7', 10)).toHaveLength(0);
  });
});

// ── The gate: refuse with NO side effects ─────────────────────────────────────

describe('gating', () => {
  it('refuses (no side effects) when categorization is not opted in', async () => {
    const listPendingCategorization = vi.fn<CategorizationStore['listPendingCategorization']>(
      () => [],
    );
    const store: CategorizationStore = {
      listPendingCategorization,
      markCategorized: vi.fn(),
      markCategoryFailed: vi.fn(),
      markCategorySkipped: vi.fn(),
    };
    const { orchestrator, db } = harness({
      seed: [{ id: 'a', gpsLat: CUSCO_A.lat, gpsLon: CUSCO_A.lon }],
      store,
      getStatus: () => ({ available: false, reason: 'not-opted-in' }),
    });

    const result = await orchestrator.run();

    expect(result.outcome).toBe('refused');
    expect(result.reason).toBe('not-opted-in');
    expect(listPendingCategorization).not.toHaveBeenCalled();
    expect(allCategories(db)).toHaveLength(0);
    expect(categoryStatusOf(db, 'a')).toBe('pending');
  });

  it('refuses (no side effects) when no signal or asset is available', async () => {
    const listPendingCategorization = vi.fn<CategorizationStore['listPendingCategorization']>(
      () => [],
    );
    const store: CategorizationStore = {
      listPendingCategorization,
      markCategorized: vi.fn(),
      markCategoryFailed: vi.fn(),
      markCategorySkipped: vi.fn(),
    };
    const { orchestrator } = harness({
      store,
      getStatus: () => ({ available: false, reason: 'no-signal' }),
    });

    const result = await orchestrator.run();

    expect(result.outcome).toBe('refused');
    expect(result.reason).toBe('no-signal');
    expect(listPendingCategorization).not.toHaveBeenCalled();
  });

  it('never touches the store or status until run() is called', () => {
    const listPendingCategorization = vi.fn<CategorizationStore['listPendingCategorization']>(
      () => [],
    );
    const getStatus = vi.fn<() => CategorizationStatus>(() => ({ available: true }));
    createCategorizationOrchestrator({
      store: {
        listPendingCategorization,
        markCategorized: vi.fn(),
        markCategoryFailed: vi.fn(),
        markCategorySkipped: vi.fn(),
      },
      categories: createCategoriesRepo(freshCatalog()),
      gazetteer: createGazetteer(GAZETTEER_FIXTURE),
      transport: { run: () => Promise.resolve({}) },
      getStatus,
    });
    expect(getStatus).not.toHaveBeenCalled();
    expect(listPendingCategorization).not.toHaveBeenCalled();
  });
});

// ── Happy paths ───────────────────────────────────────────────────────────────

describe('places pipeline', () => {
  it('clusters GPS items, reverse-geocodes, and auto-assigns a place category', async () => {
    const { orchestrator, db, categories, requests } = harness({
      seed: [
        { id: 'p1', gpsLat: CUSCO_A.lat, gpsLon: CUSCO_A.lon },
        { id: 'p2', gpsLat: CUSCO_B.lat, gpsLon: CUSCO_B.lon },
        { id: 'p3', gpsLat: CUSCO_C.lat, gpsLon: CUSCO_C.lon },
      ],
    });

    const result = await orchestrator.run();

    expect(result.outcome).toBe('completed');
    expect(result.counts.categorized).toBe(3);
    for (const id of ['p1', 'p2', 'p3']) expect(categoryStatusOf(db, id)).toBe('done');

    const cats = allCategories(db);
    expect(cats).toHaveLength(1);
    expect(cats[0]).toMatchObject({
      kind: 'place',
      name: 'Cusco, 08, PE',
      source_key: placeSourceKey(CUSCO.id),
    });

    const assignment = categories.resolveAssignment('p1', cats[0].id);
    expect(assignment).not.toBeNull();
    expect(assignment).toMatchObject({
      source: 'auto',
      state: 'assigned',
      signal: 'gps',
      confidence: PLACE_ASSIGNMENT_CONFIDENCE,
    });
    expect(assignment?.explanation).toContain('Cusco');

    // Only a places request was posted (no embeddings to theme-cluster).
    expect(requests).toHaveLength(1);
    expect(requests[0].places?.points.map((pt) => pt.id).sort()).toEqual(['p1', 'p2', 'p3']);
    expect(requests[0].themes).toBeUndefined();
  });

  // Regression cover for #338: a gazetteer that returns an empty display label
  // (`{ label: '', sourceKey }`) MUST fall back to the `coordLabel(centroid)`
  // "lat, lon" name (4-decimal format), not a blank string. Without this cover
  // a regression could silently produce blank place-category names.
  it('falls back to a coordinate label when the gazetteer returns an empty label', async () => {
    const sourceKey = placeSourceKey(9_999_001);
    const fakeGazetteer: Gazetteer = {
      size: 1,
      reverseGeocode: () => ({ label: '', sourceKey }),
    };
    const { orchestrator, db, categories } = harness({
      gazetteer: fakeGazetteer,
      seed: [
        { id: 'q1', gpsLat: CUSCO_A.lat, gpsLon: CUSCO_A.lon },
        { id: 'q2', gpsLat: CUSCO_B.lat, gpsLon: CUSCO_B.lon },
        { id: 'q3', gpsLat: CUSCO_C.lat, gpsLon: CUSCO_C.lon },
      ],
    });

    const result = await orchestrator.run();

    expect(result.outcome).toBe('completed');
    expect(result.counts.categorized).toBe(3);
    for (const id of ['q1', 'q2', 'q3']) expect(categoryStatusOf(db, id)).toBe('done');

    const cats = allCategories(db);
    expect(cats).toHaveLength(1);
    expect(cats[0]).toMatchObject({ kind: 'place', source_key: sourceKey });

    // The cluster centroid is the mean of the three CUSCO_* coords (all near
    // -13.5321, -71.9675). Pin the CONCRETE coordLabel format: two numbers
    // formatted with 4 decimals joined by ", " — not merely a non-empty string
    // (the empty label itself is non-empty after concatenation).
    expect(cats[0].name).toMatch(/^-?\d+\.\d{4}, -?\d+\.\d{4}$/);
    const meanLat = (CUSCO_A.lat + CUSCO_B.lat + CUSCO_C.lat) / 3;
    const meanLon = (CUSCO_A.lon + CUSCO_B.lon + CUSCO_C.lon) / 3;
    expect(cats[0].name).toBe(`${meanLat.toFixed(4)}, ${meanLon.toFixed(4)}`);

    // The assignment's explanation surfaces the coordinate label too (proving
    // the fallback flows through to the per-member auto-assignment, not just
    // the category row).
    const assignment = categories.resolveAssignment('q1', cats[0].id);
    expect(assignment).toMatchObject({ signal: 'gps', confidence: PLACE_ASSIGNMENT_CONFIDENCE });
    expect(assignment?.explanation).toContain(cats[0].name);
  });
});

describe('themes pipeline', () => {
  it('clusters embedded items, labels the cluster, and auto-assigns a theme category', async () => {
    const { orchestrator, db, categories, requests } = harness({
      seed: [
        { id: 't1', embed: 0.5, description: 'beach sunset waves' },
        { id: 't2', embed: 0.5, description: 'beach sunset waves' },
      ],
    });

    const result = await orchestrator.run();

    expect(result.outcome).toBe('completed');
    expect(result.counts.categorized).toBe(2);
    for (const id of ['t1', 't2']) expect(categoryStatusOf(db, id)).toBe('done');

    const cats = allCategories(db);
    expect(cats).toHaveLength(1);
    expect(cats[0].kind).toBe('theme');
    expect(cats[0].source_key).toBe(themeSourceKey(['t1', 't2']));
    // Pin the CONCRETE derived salient-term label (deriveThemeLabels ranks the three
    // shared terms tf/df, ties broken ascending → "Beach sunset waves"), NOT merely a
    // non-empty string: the size-based fallback ("2 similar items") is also non-empty,
    // so only an exact match proves the orchestrator wires the real label through and
    // catches a regression that drops labelling (Sentinel PR #335 🔴).
    expect(cats[0].name).toBe('Beach sunset waves');

    const assignment = categories.resolveAssignment('t1', cats[0].id);
    expect(assignment).toMatchObject({
      source: 'auto',
      state: 'assigned',
      signal: 'theme-cluster',
    });
    // Identical vectors ⇒ cosine to the centroid is 1 (clamped into [0, 1]).
    expect(assignment?.confidence).toBeCloseTo(1, 5);
    // The explanation also surfaces the derived label (not just a generic string).
    expect(assignment?.explanation).toContain('Beach sunset waves');

    expect(requests[0].themes?.items.map((it) => it.id).sort()).toEqual(['t1', 't2']);
    expect(requests[0].places).toBeUndefined();
  });

  it('names a theme by the size fallback ONLY when labelling yields no salient term', async () => {
    const { orchestrator, db, categories } = harness({
      seed: [
        // Identical vectors ⇒ they cluster; all-stopword text ⇒ deriveThemeLabels
        // returns an empty label, so the orchestrator must fall back to a size name.
        { id: 's1', embed: 0.5, description: 'the and of a to' },
        { id: 's2', embed: 0.5, description: 'the and of a to' },
      ],
    });

    const result = await orchestrator.run();

    expect(result.outcome).toBe('completed');
    for (const id of ['s1', 's2']) expect(categoryStatusOf(db, id)).toBe('done');

    const cats = allCategories(db);
    expect(cats).toHaveLength(1);
    expect(cats[0].kind).toBe('theme');
    // This fallback string is the ONLY name a labelled theme can carry when the label
    // is empty — it pins the empty-label branch (the counterpart to the positive test).
    expect(cats[0].name).toBe('2 similar items');

    // The empty-label explanation omits the " — <label>" suffix entirely.
    const assignment = categories.resolveAssignment('s1', cats[0].id);
    expect(assignment?.explanation).toBe('Grouped with 2 similar items');
  });

  it('consumes only embed_status=done rows (embed-first, categorize-second)', async () => {
    const { orchestrator, db, requests } = harness({
      seed: [
        { id: 't1', embed: 0.5, description: 'forest hike trail' },
        { id: 't2', embed: 0.5, description: 'forest hike trail' },
        // No embedding and no GPS ⇒ still pending-embed ⇒ excluded from themes, skipped.
        { id: 'z-pending', description: 'not yet embedded' },
      ],
    });

    await orchestrator.run();

    const themedIds = requests[0].themes?.items.map((it) => it.id) ?? [];
    expect(themedIds).toContain('t1');
    expect(themedIds).toContain('t2');
    expect(themedIds).not.toContain('z-pending');
    expect(categoryStatusOf(db, 'z-pending')).toBe('skipped');
  });

  it('folds an item carrying both signals into a place AND a theme category', async () => {
    const { orchestrator, db, categories } = harness({
      seed: [
        {
          id: 'x',
          gpsLat: CUSCO_A.lat,
          gpsLon: CUSCO_A.lon,
          embed: 0.5,
          description: 'plaza trip',
        },
        { id: 'g', gpsLat: CUSCO_B.lat, gpsLon: CUSCO_B.lon },
        { id: 'e', embed: 0.5, description: 'plaza trip' },
      ],
    });

    const result = await orchestrator.run();

    expect(result.outcome).toBe('completed');
    expect(categoryStatusOf(db, 'x')).toBe('done');

    const cats = allCategories(db);
    const place = cats.find((c) => c.kind === 'place');
    const theme = cats.find((c) => c.kind === 'theme');
    if (place === undefined || theme === undefined) {
      throw new Error('expected both a place and a theme category');
    }
    expect(categories.resolveAssignment('x', place.id)?.signal).toBe('gps');
    expect(categories.resolveAssignment('x', theme.id)?.signal).toBe('theme-cluster');
  });
});

describe('progress inFlight (distinct-count de-dup, #341)', () => {
  it('counts an item carrying BOTH signals once in the in-flight corpus, not twice', async () => {
    const { orchestrator, emitted } = harness({
      seed: [
        // 'x' carries BOTH a GPS signal AND an embedding, so it lands in the places
        // pass AND the themes pass — a naive places(2) + themes(2) sum would be 4.
        {
          id: 'x',
          gpsLat: CUSCO_A.lat,
          gpsLon: CUSCO_A.lon,
          embed: 0.5,
          description: 'plaza trip',
        },
        { id: 'g', gpsLat: CUSCO_B.lat, gpsLon: CUSCO_B.lon },
        { id: 'e', embed: 0.5, description: 'plaza trip' },
      ],
    });

    const result = await orchestrator.run();
    expect(result.outcome).toBe('completed');

    // During the clustering pass inFlight is set to the DISTINCT corpus size and
    // then reset to 0, so the peak emitted inFlight is the distinct count. The
    // both-signals item 'x' is de-duped by the `distinct` Set: 3 ids in flight,
    // NOT the naive 4. A double-count regression (gps + theme length) fails here.
    const peakInFlight = Math.max(...emitted.map((snapshot) => snapshot.counts.inFlight));
    expect(peakInFlight).toBe(3);
    expect(emitted.some((snapshot) => snapshot.counts.inFlight === 4)).toBe(false);
  });
});

describe('the category_status drain', () => {
  it('skips an item with neither GPS nor an embedding', async () => {
    const { orchestrator, db, requests } = harness({
      seed: [{ id: 's1', description: 'a lonely note' }],
    });

    const result = await orchestrator.run();

    expect(result.outcome).toBe('completed');
    expect(result.counts.skipped).toBe(1);
    expect(categoryStatusOf(db, 's1')).toBe('skipped');
    expect(allCategories(db)).toHaveLength(0);
    // No signal in the corpus ⇒ no cluster request is posted at all.
    expect(requests).toHaveLength(0);
  });

  it('is idempotent: a re-run reprocesses nothing and creates no duplicate category', async () => {
    const { orchestrator, db } = harness({
      seed: [
        { id: 'p1', gpsLat: CUSCO_A.lat, gpsLon: CUSCO_A.lon },
        { id: 'p2', gpsLat: CUSCO_B.lat, gpsLon: CUSCO_B.lon },
      ],
    });

    const first = await orchestrator.run();
    expect(first.outcome).toBe('completed');
    expect(allCategories(db)).toHaveLength(1);

    const second = await orchestrator.run();
    expect(second.outcome).toBe('idle');
    expect(allCategories(db)).toHaveLength(1);
  });

  it('reports idle for an empty catalog', async () => {
    const { orchestrator, requests } = harness({ seed: [] });
    const result = await orchestrator.run();
    expect(result.outcome).toBe('idle');
    expect(requests).toHaveLength(0);
  });

  it('accumulates every keyset page before clustering (global pass over all items)', async () => {
    const { orchestrator, db, requests } = harness({
      batchSize: 2,
      seed: [
        { id: 'p1', gpsLat: CUSCO_A.lat, gpsLon: CUSCO_A.lon },
        { id: 'p2', gpsLat: CUSCO_B.lat, gpsLon: CUSCO_B.lon },
        { id: 'p3', gpsLat: CUSCO_C.lat, gpsLon: CUSCO_C.lon },
        { id: 'p4', gpsLat: CUSCO_A.lat, gpsLon: CUSCO_A.lon },
        { id: 'p5', gpsLat: CUSCO_B.lat, gpsLon: CUSCO_B.lon },
      ],
    });

    const result = await orchestrator.run();

    expect(result.outcome).toBe('completed');
    expect(result.counts.categorized).toBe(5);
    // A single global places request carries ALL five points despite batchSize 2.
    expect(requests).toHaveLength(1);
    expect(requests[0].places?.points).toHaveLength(5);
    expect(allCategories(db)).toHaveLength(1);
  });
});

// ── Resilience: one bad item/cluster never aborts the run ─────────────────────

describe('resilience', () => {
  it('errors only the item whose assignAuto throws; the rest complete', async () => {
    const { orchestrator, db, categories } = harness({
      seed: [
        { id: 'bad', gpsLat: CUSCO_A.lat, gpsLon: CUSCO_A.lon },
        { id: 'ok1', gpsLat: CUSCO_B.lat, gpsLon: CUSCO_B.lon },
        { id: 'ok2', gpsLat: CUSCO_C.lat, gpsLon: CUSCO_C.lon },
      ],
      wrapCategories: (real) => ({
        ...real,
        assignAuto: (input) => {
          if (input.itemId === 'bad') throw new Error('boom');
          real.assignAuto(input);
        },
      }),
    });

    const result = await orchestrator.run();

    expect(result.outcome).toBe('completed');
    expect(result.counts.failed).toBe(1);
    expect(result.counts.categorized).toBe(2);
    expect(categoryStatusOf(db, 'bad')).toBe('error');
    expect(categoryStatusOf(db, 'ok1')).toBe('done');
    expect(categoryStatusOf(db, 'ok2')).toBe('done');

    const cat = allCategories(db)[0];
    expect(categories.resolveAssignment('bad', cat.id)).toBeNull();
    expect(categories.resolveAssignment('ok1', cat.id)?.state).toBe('assigned');
  });

  it('errors a whole cluster whose category upsert throws; other clusters proceed', async () => {
    const { orchestrator, db } = harness({
      seed: [
        { id: 'p1', gpsLat: CUSCO_A.lat, gpsLon: CUSCO_A.lon },
        { id: 'p2', gpsLat: CUSCO_B.lat, gpsLon: CUSCO_B.lon },
        { id: 't1', embed: 0.5, description: 'river canyon' },
        { id: 't2', embed: 0.5, description: 'river canyon' },
      ],
      wrapCategories: (real) => ({
        ...real,
        upsertCategory: (input) => {
          if (input.kind === 'place') throw new Error('boom');
          return real.upsertCategory(input);
        },
      }),
    });

    const result = await orchestrator.run();

    expect(result.outcome).toBe('completed');
    expect(categoryStatusOf(db, 'p1')).toBe('error');
    expect(categoryStatusOf(db, 'p2')).toBe('error');
    expect(categoryStatusOf(db, 't1')).toBe('done');
    expect(categoryStatusOf(db, 't2')).toBe('done');

    const cats = allCategories(db);
    expect(cats).toHaveLength(1);
    expect(cats[0].kind).toBe('theme');
  });

  it('errors every read item when the whole clustering pass throws', async () => {
    const { orchestrator, db } = harness({
      seed: [
        { id: 'a', gpsLat: CUSCO_A.lat, gpsLon: CUSCO_A.lon },
        { id: 'b', gpsLat: CUSCO_B.lat, gpsLon: CUSCO_B.lon },
      ],
      transport: { run: () => Promise.reject(new Error('worker crashed')) },
    });

    const result = await orchestrator.run();

    expect(result.outcome).toBe('completed');
    expect(result.counts.failed).toBe(2);
    expect(categoryStatusOf(db, 'a')).toBe('error');
    expect(categoryStatusOf(db, 'b')).toBe('error');
    expect(allCategories(db)).toHaveLength(0);
  });

  it('logs a local diagnostic (no telemetry, no raw-error leak) when the whole clustering pass throws (#374)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { orchestrator, db } = harness({
      seed: [
        { id: 'a', gpsLat: CUSCO_A.lat, gpsLon: CUSCO_A.lon },
        { id: 'b', gpsLat: CUSCO_B.lat, gpsLon: CUSCO_B.lon },
      ],
      // The rejection message deliberately carries a file path + free text so the
      // test can prove neither leaks into the log line.
      transport: {
        run: () => Promise.reject(new Error('worker crashed near /Users/someone/photo.jpg')),
      },
    });

    const result = await orchestrator.run();

    // The recovery behaviour is unchanged — every read item still errors and the
    // run carries on to a terminal state.
    expect(result.counts.failed).toBe(2);
    expect(categoryStatusOf(db, 'a')).toBe('error');

    // The pass no longer fails SILENTLY: exactly one main-process diagnostic is
    // emitted, carrying the kawsay prefix and naming the clustering pass so a
    // field report can distinguish a worker crash from a clean drain.
    expect(warn).toHaveBeenCalledTimes(1);
    const [message] = warn.mock.calls[0];
    expect(String(message)).toContain('[kawsay]');
    expect(String(message)).toMatch(/clustering/i);
    // Local-only + privacy: the raw error message (which can carry a file path or
    // item text) MUST NOT reach the log — only a name/code diagnostic crosses it.
    const serialized = JSON.stringify(warn.mock.calls);
    expect(serialized).not.toContain('worker crashed');
    expect(serialized).not.toContain('photo.jpg');
  });

  it('contains a throw from the failure-marker and still settles the run', async () => {
    let served = false;
    const item: CategorizableItem = {
      id: 'a',
      gpsLat: CUSCO_A.lat,
      gpsLon: CUSCO_A.lon,
      description: null,
      searchMeta: null,
      embedding: null,
    };
    const markCategoryFailed = vi.fn(() => {
      throw new Error('disk full');
    });
    const store: CategorizationStore = {
      listPendingCategorization: vi.fn(() => (served ? [] : ((served = true), [item]))),
      markCategorized: vi.fn(),
      markCategoryFailed,
      markCategorySkipped: vi.fn(),
    };
    const { orchestrator } = harness({
      store,
      transport: { run: () => Promise.reject(new Error('crash')) },
    });

    const result = await orchestrator.run();

    expect(result.outcome).toBe('completed');
    expect(result.counts.failed).toBe(1);
    expect(markCategoryFailed).toHaveBeenCalledWith('a');
  });

  it('contains a throw from the skip-marker', async () => {
    let served = false;
    const item: CategorizableItem = {
      id: 'a',
      gpsLat: null,
      gpsLon: null,
      description: null,
      searchMeta: null,
      embedding: null,
    };
    const markCategorySkipped = vi.fn(() => {
      throw new Error('disk full');
    });
    const store: CategorizationStore = {
      listPendingCategorization: vi.fn(() => (served ? [] : ((served = true), [item]))),
      markCategorized: vi.fn(),
      markCategoryFailed: vi.fn(),
      markCategorySkipped,
    };
    const { orchestrator } = harness({ store });

    const result = await orchestrator.run();

    expect(result.outcome).toBe('completed');
    expect(result.counts.skipped).toBe(1);
    expect(markCategorySkipped).toHaveBeenCalledWith('a');
  });

  it('contains a throw from the done-marker', async () => {
    let served = false;
    // A lone GPS point is DBSCAN noise ⇒ no cluster ⇒ the item still had a signal,
    // so it drains to done; the done-marker throws and must be contained.
    const item: CategorizableItem = {
      id: 'a',
      gpsLat: CUSCO_A.lat,
      gpsLon: CUSCO_A.lon,
      description: null,
      searchMeta: null,
      embedding: null,
    };
    const markCategorized = vi.fn(() => {
      throw new Error('disk full');
    });
    const store: CategorizationStore = {
      listPendingCategorization: vi.fn(() => (served ? [] : ((served = true), [item]))),
      markCategorized,
      markCategoryFailed: vi.fn(),
      markCategorySkipped: vi.fn(),
    };
    const { orchestrator } = harness({ store });

    const result = await orchestrator.run();

    expect(result.outcome).toBe('completed');
    expect(result.counts.categorized).toBe(1);
    expect(markCategorized).toHaveBeenCalledWith('a');
  });
});

// ── Cooperative cancellation ──────────────────────────────────────────────────

describe('cancellation', () => {
  it('stops cleanly mid-drain: processed items keep status, the rest stay pending', async () => {
    const ref: { current: CategorizationOrchestrator | null } = { current: null };
    const { orchestrator, db } = harness({
      // No signal ⇒ each item drains to skipped one at a time; cancel after the first.
      seed: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      onProgress: (snapshot) => {
        if (snapshot.lastItem?.id === 'a') ref.current?.cancel();
      },
    });
    ref.current = orchestrator;

    const result = await orchestrator.run();

    expect(result.outcome).toBe('cancelled');
    expect(categoryStatusOf(db, 'a')).toBe('skipped');
    expect(categoryStatusOf(db, 'b')).toBe('pending');
    expect(categoryStatusOf(db, 'c')).toBe('pending');
  });

  it('honours a cancel raised during the clustering pass (before any write)', async () => {
    const controller = new AbortController();
    const { orchestrator, db } = harness({
      seed: [
        { id: 'a', gpsLat: CUSCO_A.lat, gpsLon: CUSCO_A.lon },
        { id: 'b', gpsLat: CUSCO_B.lat, gpsLon: CUSCO_B.lon },
      ],
      signal: controller.signal,
      transport: {
        run: (request) => {
          controller.abort();
          return Promise.resolve(runInline(request));
        },
      },
    });

    const result = await orchestrator.run();

    expect(result.outcome).toBe('cancelled');
    expect(categoryStatusOf(db, 'a')).toBe('pending');
    expect(categoryStatusOf(db, 'b')).toBe('pending');
    expect(allCategories(db)).toHaveLength(0);
  });

  it('cancel() before any run is a no-op that reports nothing cancelled', () => {
    const { orchestrator } = harness({ seed: [] });
    expect(orchestrator.cancel()).toEqual({ cancelled: false });
  });
});

// ── Single-flight ─────────────────────────────────────────────────────────────

describe('single-flight', () => {
  it('a second concurrent run() returns busy without overlapping', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { orchestrator } = harness({
      seed: [
        { id: 'a', gpsLat: CUSCO_A.lat, gpsLon: CUSCO_A.lon },
        { id: 'b', gpsLat: CUSCO_B.lat, gpsLon: CUSCO_B.lon },
      ],
      transport: {
        run: async (request) => {
          await gate;
          return runInline(request);
        },
      },
    });

    const first = orchestrator.run();
    const second = await orchestrator.run();
    expect(second.outcome).toBe('busy');

    release();
    expect((await first).outcome).toBe('completed');
  });
});

// ── Zero network egress (strict local-only) ───────────────────────────────────

describe('zero egress', () => {
  it('never reaches for the network during a normal run', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { orchestrator } = harness({
      seed: [
        { id: 'p1', gpsLat: CUSCO_A.lat, gpsLon: CUSCO_A.lon },
        { id: 'p2', gpsLat: CUSCO_B.lat, gpsLon: CUSCO_B.lon },
        { id: 't1', embed: 0.5, description: 'desert dunes' },
        { id: 't2', embed: 0.5, description: 'desert dunes' },
      ],
    });

    await orchestrator.run();

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
