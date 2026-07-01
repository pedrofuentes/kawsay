import { afterEach, describe, expect, it, vi } from 'vitest';
import Database, { type Database as Db } from 'better-sqlite3';
import { runMigrations } from '../../electron/main/db/migrate';
import { createCatalogRepo } from '../../electron/main/db/catalog-repo';
import {
  createEmbeddingsRepo,
  type PendingEmbeddingItem,
} from '../../electron/main/db/embeddings-repo';
import {
  buildPassageText,
  createEmbeddingOrchestrator,
  type EmbeddingOrchestrator,
  type EmbeddingStore,
} from '../../electron/main/search/embedding-orchestrator';
import {
  EMBED_DIM,
  EMBED_MODEL_ID,
  PASSAGE_PREFIX,
  type EmbedderStatus,
} from '../../electron/main/search/embed-cli';
import type { MediaType } from '@shared/catalog';

// The embedding-generation orchestrator (M4-1b-seam-2 · ADR-0029 Decision 1). It is
// the WRITE PATH of smart search: it drains items whose `embed_status = 'pending'`,
// turns each item's text into a `passage:`-prefixed embedding via the seam-1
// `embed-cli` embedder, and stores it through the EmbeddingsRepo — off the renderer
// thread, batched (one subprocess call per batch), resilient (one bad item/batch
// never aborts the run), and cancellable (cooperatively, between batches). The
// binary/model are bundled LATER, so the embedder is UNAVAILABLE today: the
// governing contract is GRACEFUL DEGRADATION — an unavailable embedder makes the
// orchestrator REFUSE with no side effects (never a throw, never a DB write), exactly
// like live search falling back to exact FTS (AC-7). Only the embedder is mocked;
// the drain runs over a real in-memory migrated catalog so the `embed_status`
// transitions (pending → done | error | skipped) are exercised end-to-end.

// ── Fixtures ────────────────────────────────────────────────────────────────

const dbs: Db[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});

function freshCatalog(): Db {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  dbs.push(db);
  return db;
}

/** A finite 384-dim vector (values are irrelevant to storage; only dim + finiteness matter). */
function vec384(fill = 0.0125): Float32Array {
  return Float32Array.from({ length: EMBED_DIM }, () => fill);
}

/** A ready embedder over an injected batch embed function. */
function embedderStub(
  embed: (texts: readonly string[]) => Promise<Float32Array[]>,
): EmbedderStatus {
  return { available: true, embed };
}

function statusOf(db: Db, id: string): string {
  return (
    db.prepare('SELECT embed_status FROM items WHERE id = ?').get<{ embed_status: string }>(id)
      ?.embed_status ?? ''
  );
}

interface SeedItem {
  id: string;
  description?: string | null;
  searchMeta?: string | null;
  mediaType?: MediaType;
}

interface HarnessOptions {
  seed?: SeedItem[];
  /** The batch embed function (defaults to one finite 384-vector per text). */
  embed?: (texts: readonly string[]) => Promise<Float32Array[]>;
  /** Override the whole embedder status (e.g. an UNAVAILABLE sentinel). */
  embedder?: EmbedderStatus;
  batchSize?: number;
  signal?: AbortSignal;
}

function harness(options: HarnessOptions = {}) {
  const db = freshCatalog();
  const catalog = createCatalogRepo(db);
  const repo = createEmbeddingsRepo(db);
  for (const item of options.seed ?? []) {
    catalog.insertItem({
      id: item.id,
      mediaType: item.mediaType ?? 'message',
      description: item.description ?? null,
      searchMeta: item.searchMeta ?? null,
    });
  }

  // Record every text batch handed to the embedder (asserts prefixing + batching).
  const embedCalls: string[][] = [];
  const rawEmbed = options.embed ?? (async (texts: readonly string[]) => texts.map(() => vec384()));
  const recordingEmbed = async (texts: readonly string[]): Promise<Float32Array[]> => {
    embedCalls.push([...texts]);
    return rawEmbed(texts);
  };
  const embedder: EmbedderStatus = options.embedder ?? embedderStub(recordingEmbed);

  const emitted: ReturnType<EmbeddingOrchestrator['status']>[] = [];
  const orchestrator = createEmbeddingOrchestrator({
    store: repo,
    getEmbedder: () => embedder,
    ...(options.batchSize !== undefined ? { batchSize: options.batchSize } : {}),
    onProgress: (snapshot) => emitted.push(snapshot),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  });

  return { db, catalog, repo, orchestrator, emitted, embedCalls };
}

// ── buildPassageText (the description + searchMeta join) ─────────────────────

describe('buildPassageText — the embeddable text of a pending item', () => {
  const item = (over: Partial<PendingEmbeddingItem>): PendingEmbeddingItem => ({
    id: 'i',
    mediaType: 'message',
    description: null,
    searchMeta: null,
    ...over,
  });

  it('returns null when there is NO embeddable text (both parts null)', () => {
    expect(buildPassageText(item({}))).toBeNull();
  });

  it('returns null when both parts are whitespace-only', () => {
    expect(buildPassageText(item({ description: '   ', searchMeta: '\t \n' }))).toBeNull();
  });

  it('uses the description alone when searchMeta is null', () => {
    expect(buildPassageText(item({ description: 'abuela cocinando' }))).toBe('abuela cocinando');
  });

  it('uses searchMeta alone when the description is null', () => {
    expect(buildPassageText(item({ searchMeta: 'playa.jpg' }))).toBe('playa.jpg');
  });

  it('joins the non-null parts (description + searchMeta)', () => {
    const text = buildPassageText(item({ description: 'una carta', searchMeta: 'mama · 2019' }));
    expect(text).toContain('una carta');
    expect(text).toContain('mama · 2019');
  });
});

// ── Gate: UNAVAILABLE embedder refuses with no side effects ──────────────────

describe('embedding orchestrator — gate (UNAVAILABLE embedder degrades to FTS, no side effects)', () => {
  it('refuses when the embedder is UNAVAILABLE: no items touched, no throw', async () => {
    const { orchestrator, repo, embedCalls } = harness({
      seed: [
        { id: 'a', description: 'hola' },
        { id: 'b', description: 'chau' },
      ],
      embedder: { available: false, reason: 'model-unavailable' },
    });

    const result = await orchestrator.run();

    expect(result.outcome).toBe('refused');
    expect(result.reason).toBe('model-unavailable');
    expect(result.counts).toEqual({ embedded: 0, failed: 0, skipped: 0, inFlight: 0 });
    // Nothing embedded, nothing drained: both items are STILL pending.
    expect(repo.listPendingEmbeddings(10).map((r) => r.id)).toEqual(['a', 'b']);
    expect(repo.getEmbedding('a', EMBED_MODEL_ID)).toBeNull();
    expect(embedCalls).toHaveLength(0);
    expect(orchestrator.status().state).toBe('idle');
  });

  it('NEVER auto-starts: merely constructing the orchestrator resolves nothing', () => {
    const store: EmbeddingStore = {
      listPendingEmbeddings: vi.fn(() => []),
      upsertEmbedding: vi.fn(),
      markEmbedFailed: vi.fn(),
      markEmbedSkipped: vi.fn(),
    };
    const getEmbedder = vi.fn(() => embedderStub(async () => []));

    createEmbeddingOrchestrator({ store, getEmbedder });

    expect(getEmbedder).not.toHaveBeenCalled();
    expect(store.listPendingEmbeddings).not.toHaveBeenCalled();
  });
});

// ── The happy-path drain ─────────────────────────────────────────────────────

describe('embedding orchestrator — drains pending items into stored embeddings', () => {
  it('embeds every pending item and flips the drain to done (384-dim vectors, correct model)', async () => {
    const { orchestrator, repo, db, emitted, embedCalls } = harness({
      seed: [
        { id: 'a', description: 'msg a' },
        { id: 'b', description: 'msg b' },
        { id: 'c', description: 'msg c' },
      ],
    });

    const result = await orchestrator.run();

    expect(result.outcome).toBe('completed');
    expect(result.counts).toMatchObject({ embedded: 3, failed: 0, skipped: 0, inFlight: 0 });
    for (const id of ['a', 'b', 'c']) {
      expect(statusOf(db, id)).toBe('done');
      const record = repo.getEmbedding(id, EMBED_MODEL_ID);
      expect(record).not.toBeNull();
      expect(record?.dim).toBe(EMBED_DIM);
      expect(record?.modelId).toBe(EMBED_MODEL_ID);
    }
    // Drained: nothing left pending.
    expect(repo.listPendingEmbeddings(10)).toEqual([]);
    // ONE subprocess call for the whole batch, each text `passage:`-prefixed.
    expect(embedCalls).toHaveLength(1);
    expect(embedCalls[0]).toEqual([
      `${PASSAGE_PREFIX}msg a`,
      `${PASSAGE_PREFIX}msg b`,
      `${PASSAGE_PREFIX}msg c`,
    ]);
    // Terminal progress snapshot: complete, no work in flight.
    expect(emitted.at(-1)).toMatchObject({
      state: 'complete',
      counts: { embedded: 3, failed: 0, skipped: 0, inFlight: 0 },
      lastItem: { id: 'c', status: 'embedded' },
    });
  });

  it('processes the corpus in batches — one embedder call per page (never per item)', async () => {
    const { orchestrator, embedCalls } = harness({
      seed: [
        { id: 'a', description: 'a' },
        { id: 'b', description: 'b' },
        { id: 'c', description: 'c' },
        { id: 'd', description: 'd' },
        { id: 'e', description: 'e' },
      ],
      batchSize: 2,
    });

    const result = await orchestrator.run();

    expect(result.counts.embedded).toBe(5);
    // 5 items / batch 2 ⇒ pages of [a,b], [c,d], [e] ⇒ exactly three calls.
    expect(embedCalls.map((c) => c.length)).toEqual([2, 2, 1]);
  });

  it('is a calm no-op (idle) when there is nothing pending to embed', async () => {
    const { orchestrator, embedCalls } = harness({ seed: [] });

    const result = await orchestrator.run();

    expect(result.outcome).toBe('idle');
    expect(result.counts).toEqual({ embedded: 0, failed: 0, skipped: 0, inFlight: 0 });
    expect(embedCalls).toHaveLength(0);
    expect(orchestrator.status().state).toBe('idle');
  });
});

// ── Skip: an item with no embeddable text ────────────────────────────────────

describe('embedding orchestrator — skips items with no embeddable text', () => {
  it('marks a text-less item skipped and never sends it to the embedder', async () => {
    const { orchestrator, repo, db, embedCalls } = harness({
      seed: [
        { id: 'empty', description: null, searchMeta: null, mediaType: 'photo' },
        { id: 'text', description: 'a caption' },
      ],
    });

    const result = await orchestrator.run();

    expect(result.counts).toMatchObject({ embedded: 1, skipped: 1, failed: 0 });
    expect(statusOf(db, 'empty')).toBe('skipped');
    expect(statusOf(db, 'text')).toBe('done');
    expect(repo.getEmbedding('empty', EMBED_MODEL_ID)).toBeNull();
    // Only the item WITH text reached the embedder.
    expect(embedCalls).toEqual([[`${PASSAGE_PREFIX}a caption`]]);
  });
});

// ── Resilience: one item/batch failing never aborts the run ──────────────────

describe('embedding orchestrator — resilience (a failure never aborts the run)', () => {
  it('an embedder error on one batch fails only those items; the rest complete', async () => {
    let calls = 0;
    const { orchestrator, db, repo } = harness({
      seed: [
        { id: 'a', description: 'a' },
        { id: 'b', description: 'b' },
        { id: 'c', description: 'c' },
        { id: 'd', description: 'd' },
      ],
      batchSize: 2,
      embed: async (texts) => {
        calls += 1;
        if (calls === 1) throw new Error('embed subprocess crashed');
        return texts.map(() => vec384());
      },
    });

    const result = await orchestrator.run();

    expect(result.outcome).toBe('completed');
    expect(result.counts).toMatchObject({ embedded: 2, failed: 2 });
    // First page [a,b] failed → 'error'; second page [c,d] succeeded → 'done'.
    expect(statusOf(db, 'a')).toBe('error');
    expect(statusOf(db, 'b')).toBe('error');
    expect(statusOf(db, 'c')).toBe('done');
    expect(statusOf(db, 'd')).toBe('done');
    expect(repo.getEmbedding('a', EMBED_MODEL_ID)).toBeNull();
    expect(repo.getEmbedding('c', EMBED_MODEL_ID)).not.toBeNull();
    // A failed item leaves 'pending' (it is 'error'), so it is not re-drained.
    expect(repo.listPendingEmbeddings(10)).toEqual([]);
  });

  it('treats a WRONG-DIMENSION vector as a failure — it is marked error, never stored', async () => {
    const { orchestrator, db, repo } = harness({
      seed: [
        { id: 'a', description: 'a' },
        { id: 'b', description: 'b' },
        { id: 'c', description: 'c' },
      ],
      embed: async (texts) =>
        texts.map((_text, index) =>
          // 'b' comes back with the wrong dimensionality (a broken embed).
          index === 1 ? Float32Array.from([0.1, 0.2, 0.3]) : vec384(),
        ),
    });

    const result = await orchestrator.run();

    expect(result.counts).toMatchObject({ embedded: 2, failed: 1 });
    expect(statusOf(db, 'b')).toBe('error');
    expect(repo.getEmbedding('b', EMBED_MODEL_ID)).toBeNull();
    expect(statusOf(db, 'a')).toBe('done');
    expect(statusOf(db, 'c')).toBe('done');
  });

  it('treats a batch whose vector count ≠ item count as a whole-batch failure', async () => {
    const { orchestrator, db } = harness({
      seed: [
        { id: 'a', description: 'a' },
        { id: 'b', description: 'b' },
      ],
      // Two items in, ONE vector out — a broken N-in/N-out contract.
      embed: async () => [vec384()],
    });

    const result = await orchestrator.run();

    expect(result.counts).toMatchObject({ embedded: 0, failed: 2 });
    expect(statusOf(db, 'a')).toBe('error');
    expect(statusOf(db, 'b')).toBe('error');
  });

  it('a vector the repo rejects (non-finite) is marked failed, not stored; the run continues', async () => {
    const withNaN = vec384();
    withNaN[7] = Number.NaN;
    const { orchestrator, db, repo } = harness({
      seed: [
        { id: 'a', description: 'a' },
        { id: 'b', description: 'b' },
      ],
      embed: async (texts) => texts.map((_t, index) => (index === 0 ? withNaN : vec384())),
    });

    const result = await orchestrator.run();

    // 'a' has a non-finite element ⇒ the repo's upsert throws ⇒ marked failed.
    expect(result.counts).toMatchObject({ embedded: 1, failed: 1 });
    expect(statusOf(db, 'a')).toBe('error');
    expect(repo.getEmbedding('a', EMBED_MODEL_ID)).toBeNull();
    expect(statusOf(db, 'b')).toBe('done');
  });

  it('a throw from the failure-marker itself is contained; the run still completes', async () => {
    // A stub store whose markEmbedFailed throws, served exactly one page then empty.
    let served = false;
    const item: PendingEmbeddingItem = {
      id: 'a',
      mediaType: 'message',
      description: 'a',
      searchMeta: null,
    };
    const store: EmbeddingStore = {
      listPendingEmbeddings: vi.fn(() => (served ? [] : ((served = true), [item]))),
      upsertEmbedding: vi.fn(),
      markEmbedFailed: vi.fn(() => {
        throw new Error('disk full');
      }),
      markEmbedSkipped: vi.fn(),
    };
    const orchestrator = createEmbeddingOrchestrator({
      store,
      getEmbedder: () => embedderStub(async () => []), // 0 vectors for 1 item ⇒ batch failure
    });

    const result = await orchestrator.run();

    expect(result.outcome).toBe('completed');
    expect(result.counts).toMatchObject({ failed: 1 });
    expect(store.markEmbedFailed).toHaveBeenCalledWith('a');
  });

  it('a throw from the skip-marker itself is contained; the run still completes', async () => {
    let served = false;
    const item: PendingEmbeddingItem = {
      id: 'blank',
      mediaType: 'photo',
      description: null,
      searchMeta: null,
    };
    const store: EmbeddingStore = {
      listPendingEmbeddings: vi.fn(() => (served ? [] : ((served = true), [item]))),
      upsertEmbedding: vi.fn(),
      markEmbedFailed: vi.fn(),
      markEmbedSkipped: vi.fn(() => {
        throw new Error('disk full');
      }),
    };
    const orchestrator = createEmbeddingOrchestrator({
      store,
      getEmbedder: () => embedderStub(async (texts) => texts.map(() => vec384())),
    });

    const result = await orchestrator.run();

    expect(result.outcome).toBe('completed');
    expect(result.counts).toMatchObject({ skipped: 1 });
    expect(store.markEmbedSkipped).toHaveBeenCalledWith('blank');
  });

  it('stops instead of spinning when the store never advances an item out of pending', async () => {
    // A degenerate store that keeps returning the SAME pending item (upsert is a
    // no-op that never flips the flag). The progress guard must break the loop.
    const item: PendingEmbeddingItem = {
      id: 'stuck',
      mediaType: 'message',
      description: 'x',
      searchMeta: null,
    };
    const store: EmbeddingStore = {
      listPendingEmbeddings: vi.fn(() => [item]),
      upsertEmbedding: vi.fn(),
      markEmbedFailed: vi.fn(),
      markEmbedSkipped: vi.fn(),
    };
    const orchestrator = createEmbeddingOrchestrator({
      store,
      getEmbedder: () => embedderStub(async (texts) => texts.map(() => vec384())),
      batchSize: 4,
    });

    const result = await orchestrator.run();

    expect(result.outcome).toBe('completed');
    // Page 1 processes 'stuck'; page 2 is all-already-attempted ⇒ guard breaks.
    expect(store.listPendingEmbeddings).toHaveBeenCalledTimes(2);
    expect(store.upsertEmbedding).toHaveBeenCalledTimes(1);
  });
});

// ── Cancellation: cooperative, between batches; completed work persists ───────

describe('embedding orchestrator — cancellation (stop between batches, keep saved work)', () => {
  it('an external AbortSignal stops the drain between batches; the first batch stays saved', async () => {
    const controller = new AbortController();
    let calls = 0;
    const { orchestrator, db, repo } = harness({
      seed: [
        { id: 'a', description: 'a' },
        { id: 'b', description: 'b' },
        { id: 'c', description: 'c' },
        { id: 'd', description: 'd' },
      ],
      batchSize: 2,
      signal: controller.signal,
      embed: async (texts) => {
        calls += 1;
        if (calls === 1) controller.abort(); // cancel while the first page is in flight
        return texts.map(() => vec384());
      },
    });

    const result = await orchestrator.run();

    expect(result.outcome).toBe('cancelled');
    expect(result.counts.embedded).toBe(2);
    // First page persisted; the second page never ran and stays pending.
    expect(statusOf(db, 'a')).toBe('done');
    expect(statusOf(db, 'b')).toBe('done');
    expect(repo.getEmbedding('c', EMBED_MODEL_ID)).toBeNull();
    expect(repo.listPendingEmbeddings(10).map((r) => r.id)).toEqual(['c', 'd']);
    expect(orchestrator.status().state).toBe('idle');
  });

  it('the built-in cancel() stops the drain cooperatively between batches', async () => {
    const orchRef: { current: EmbeddingOrchestrator | null } = { current: null };
    let calls = 0;
    const { orchestrator, db } = harness({
      seed: [
        { id: 'a', description: 'a' },
        { id: 'b', description: 'b' },
        { id: 'c', description: 'c' },
        { id: 'd', description: 'd' },
      ],
      batchSize: 2,
      embed: async (texts) => {
        calls += 1;
        if (calls === 1) orchRef.current?.cancel();
        return texts.map(() => vec384());
      },
    });
    orchRef.current = orchestrator;

    const result = await orchestrator.run();

    expect(result.outcome).toBe('cancelled');
    expect(result.counts.embedded).toBe(2);
    expect(statusOf(db, 'c')).toBe('pending');
  });

  it('cancel() with no run in flight is a calm no-op', () => {
    const { orchestrator } = harness({ seed: [] });
    expect(orchestrator.cancel()).toEqual({ cancelled: false });
  });
});

// ── Single-flight: a second concurrent run is refused as busy ────────────────

describe('embedding orchestrator — single-flight (no concurrent drains)', () => {
  it('refuses a second run() while one is already in flight (busy)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { orchestrator } = harness({
      seed: [{ id: 'a', description: 'a' }],
      embed: async (texts) => {
        await gate; // hold the first run inside the embedder call
        return texts.map(() => vec384());
      },
    });

    const first = orchestrator.run();
    const second = await orchestrator.run(); // called while `first` awaits the embedder

    expect(second.outcome).toBe('busy');

    release();
    const firstResult = await first;
    expect(firstResult.outcome).toBe('completed');
  });
});

// ── AC-4: zero network egress across a full drain ────────────────────────────

describe('embedding orchestrator — zero egress (AC-4)', () => {
  it('runs an entire drain without any network call', async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error('network call attempted');
    });
    const original = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    try {
      const { orchestrator } = harness({
        seed: [
          { id: 'a', description: 'a' },
          { id: 'b', description: 'b' },
        ],
      });
      const result = await orchestrator.run();
      expect(result.counts.embedded).toBe(2);
    } finally {
      globalThis.fetch = original;
    }

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
