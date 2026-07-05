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
    expect(cats[0].name.length).toBeGreaterThan(0);

    const assignment = categories.resolveAssignment('t1', cats[0].id);
    expect(assignment).toMatchObject({
      source: 'auto',
      state: 'assigned',
      signal: 'theme-cluster',
    });
    // Identical vectors ⇒ cosine to the centroid is 1 (clamped into [0, 1]).
    expect(assignment?.confidence).toBeCloseTo(1, 5);
    expect(assignment?.explanation && assignment.explanation.length).toBeGreaterThan(0);

    expect(requests[0].themes?.items.map((it) => it.id).sort()).toEqual(['t1', 't2']);
    expect(requests[0].places).toBeUndefined();
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
