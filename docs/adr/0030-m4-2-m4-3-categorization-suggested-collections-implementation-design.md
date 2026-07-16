### ADR-0030: M4-2 + M4-3 — Categorization & Suggested Collections (implementation design)

**Date**: 2026-07-03
**Status**: Proposed — the IMPLEMENTABLE deepening of **ADR-0029 §2 (categorization) + §3 (suggested
collections)** for the next milestone (**M4-2 + M4-3, combined**). This is a **docs-only design
deliverable** — no product code, no `.sql`/migration file, no dependency, no config; it turns
ADR-0029's sketch into buildable detail and seeds the M4-2/M4-3 board. Every gated build action it
names still blocks at build time (see **Gates for the build cycle** below). It does NOT edit `PRD.md`,
`ROADMAP.md`, `AGENTS.md`, or `docs/SENTINEL.md` — the proposed AC wording is for a later PRD PR (the
same discipline ADR-0029 used for AC-29…AC-33).
**Tier**: **human-required** (authoring **migration 005** — AGENTS Boundaries / ADR-0008) **+ ⚠️
ask-first** (bundling an **offline gazetteer** asset — heavy-dep + packaging + third-party license).
Crucially, M4-2/M4-3 **as specified add NO new network egress**: the gazetteer is **bundled** (offline),
and themes **reuse the M4-1 embedder** already gated by ADR-0029 — so, unlike M4-1's model download,
the categorization/suggestion slices are otherwise **time-boxed** and need **no AC-4 harness edit**.
Faces/people (**M4-4**, biometric) and the egress-proof / AC-4 harness edit (**M4-5**) remain separately
**human-required** and are **OUT OF SCOPE** here.
Extends **ADR-0029** (M4 design), **ADR-0003** (catalog + dedup-with-provenance), **ADR-0004**
(off-thread ingestion), **ADR-0008** (migration + zero-egress gate); reuses the M4-1 seams shipped in
v0.4.0. Mirrors the "bundle a small asset, degrade gracefully when absent, opt-in gate" pattern of
ADR-0027/0029 and the "no new dependency — hand-roll it" ethos of ADR-0014/0015.

**Context — what M4-1 already gives us, and what M4-2/M4-3 must add.**

v0.4.0 shipped **M4-1** (on-device semantic smart search). M4-2/M4-3 **reuse every one of its seams**
rather than invent new ones:

- **Migration mechanics** — `electron/main/db/migrate.ts`: append the next file `005_*.sql` to
  `MIGRATIONS`; forward-only, one-transaction-per-step, `PRAGMA user_version` gate (so an
  `ALTER TABLE … ADD COLUMN` runs exactly once); `.sql` imported via Vite `?raw`. Idempotent
  `IF NOT EXISTS`, named-param binding (`@name`), and the LEARNINGS **boolean → 0/1** rule (a JS boolean
  bound to a param throws; store as `INTEGER … CHECK (col IN (0,1))`, as `items.is_favourite` does,
  `001_initial.sql:75`).
- **Embeddings + the pure cosine engine** — `003_embeddings.sql` (`item_embeddings`, `embed_status`
  drain), `electron/main/db/embeddings-repo.ts` (little-endian float32 BLOB codec, `decodeVector`,
  brute-force `semanticSearch`, drain markers), and the pure, dependency-free `electron/main/search/
  semantic.ts` (`cosineSimilarity` — exhaustively unit-tested with synthetic vectors). Themes **reuse**
  the `multilingual-e5-small` embedder (`EMBED_MODEL_ID`, `EMBED_DIM = 384`; `embed-cli.ts:44,47`) — **no
  new model**.
- **Orchestrator + drain shape** — `electron/main/search/embedding-orchestrator.ts` is the template:
  gated (a typed UNAVAILABLE sentinel → refuse with **no side effects**), resilient (one bad item never
  aborts the run), cooperatively cancellable, single-flight, injected collaborators; a per-item drain
  (`pending → done | error | skipped`) analogous to `thumb_status`/`transcript_status`/`embed_status`.
- **Opt-in gate + build-time "asset present" signal** — the parameterized `transcription/consent-store.ts`
  (a separate key ⇒ a separate feature opt-in, default OPTED-OUT for absent/corrupt config), and the
  `isEmbedModelPublished()` pattern (`embed-model-source.ts:92`) — a pure constant read that reveals the
  opt-in UI only once the asset exists.
- **Off-thread transport** — the `worker_threads` seam (`transcription/queue/worker-threads-transport.ts`,
  AC-18) for heavy CPU work.
- **Bundled-asset packaging** — the `extraResources` blocks in `electron-builder.yml` (whisper / embed /
  media binaries), each a build-time WARNING (not error) when its source dir is absent, so a local
  `pnpm dist` still produces a running app that simply degrades the feature.

Binding constraints carried from ADR-0029 (all must stay green — cumulative regression, ratchet):

- **AC-4 / AC-31 zero-egress** — categorization moves NO user data (pixels, text, GPS, vectors, derived
  labels) off-device. Reverse-geocoding is **offline only** (PRD §7, MISSION §5: "no online maps") via a
  **bundled** gazetteer — no tile server, no Nominatim, no request of any kind.
- **AC-7 / AC-29 search never regresses** — migration 005 changes **no `items_fts` column**, so there is
  **no destructive FTS drop+rebuild** (unlike the transcript case, ADR-0027 §5) and exact/semantic search
  are byte-identical before and after it.
- **AC-14 / AC-33 non-destructive** — categories, assignments, labels, and derived collections are
  **removable renditions**; an original is never modified or deleted.
- **AC-9 / AC-18 off-UI-thread** — clustering runs in a `worker_thread`, never the renderer or the main
  event loop.
- **Explainable + user-correctable, default-off** — every auto assignment stores *why* + a confidence;
  user corrections win and are durable across re-clustering; the feature stays off until explicitly
  enabled and its signal/asset is present.

---

**Decision 1 — Migration 005 schema (SPECIFIED here; authoring the `.sql` is 🚨 HUMAN-REQUIRED).**

_(004 was consumed by #215 — `004_item_embeddings_model_dim_index.sql`.)_

Following `002`/`003` verbatim in style (leading rationale comment, `IF NOT EXISTS`, `CHECK`-pinned
vocabularies, canonical ISO-8601 `strftime('%Y-%m-%dT%H:%M:%fZ','now')` defaults, ON DELETE CASCADE for
derived rows). The file is `electron/main/db/migrations/005_categories.sql`, appended to `MIGRATIONS`
after `004_item_embeddings_model_dim_index`. **This is the DDL specification, not the authored file** — authoring it is the
DB-migration gate (ADR-0008). No FTS column changes ⇒ **no** `items_fts` rebuild.

```sql
-- 005_categories.sql — M4-2/M4-3 categorization + suggested-collection provenance
-- (ADR-0030). Purely ADDITIVE: two new tables, provenance columns on the EXISTING
-- collections table, and a per-item category_status drain — NO items_fts change, so
-- exact/semantic search (AC-7/AC-29) is byte-identical before and after.

-- ── CATEGORIES: one row per person/place/theme grouping ──────────────────────
CREATE TABLE IF NOT EXISTS categories (
  id         TEXT PRIMARY KEY,                                   -- UUIDv4
  kind       TEXT NOT NULL CHECK (kind IN ('person','place','theme')),
  name       TEXT NOT NULL,                                      -- human-readable label (auto-derived or user-renamed)
  -- Stable natural key so a RE-CLUSTER upserts (never duplicates) an auto category:
  --   place  -> the gazetteer place id;  theme -> a deterministic cluster key.
  -- NULL for a user-created category. UNIQUE where present (partial index below).
  source_key TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
-- One auto category per stable signal (idempotent re-cluster); user categories (NULL) exempt.
CREATE UNIQUE INDEX IF NOT EXISTS idx_categories_source_key
  ON categories(source_key) WHERE source_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_categories_kind ON categories(kind);

-- ── ITEM_CATEGORIES: explainable, correctable assignment (attaches to an item) ─
-- Dedup-with-provenance (ADR-0003): an 'auto' and a 'user' row for the same
-- (item, category) COEXIST — both retained, USER WINS at read time. A user 'removed'
-- row tombstones an auto membership so a later auto pass can never resurrect it.
CREATE TABLE IF NOT EXISTS item_categories (
  item_id     TEXT NOT NULL REFERENCES items(id)      ON DELETE CASCADE,
  category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  source      TEXT NOT NULL DEFAULT 'auto' CHECK (source IN ('auto','user')),
  state       TEXT NOT NULL DEFAULT 'assigned' CHECK (state IN ('assigned','removed')),
  signal      TEXT CHECK (signal IN ('gps','theme-cluster','face-cluster','user')),  -- WHY (machine reason)
  confidence  REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),  -- auto: [0,1]; user: NULL (certain)
  explanation TEXT,                                    -- human-readable reason surfaced in the UI
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (item_id, category_id, source)           -- ≤1 auto + ≤1 user row per (item, category)
);
CREATE INDEX IF NOT EXISTS idx_item_categories_category ON item_categories(category_id);

-- ── COLLECTIONS provenance + curation lifecycle (M4-3) ───────────────────────
-- ONE origin enum captures both provenance and lifecycle (a redundant is_suggested
-- boolean was considered and REJECTED — two columns that must never drift). DEFAULT
-- 'user' backfills every existing collection as hand-made, so today's behavior is
-- unchanged. The runner's user_version gate makes these ADD COLUMNs run exactly once.
ALTER TABLE collections ADD COLUMN origin TEXT NOT NULL DEFAULT 'user'
  CHECK (origin IN ('user','suggested','dismissed'));
-- The category a suggested/dismissed collection was derived FROM (NULL for hand-made).
-- ON DELETE SET NULL: deleting a category orphans the provenance link, never the collection.
ALTER TABLE collections ADD COLUMN category_id TEXT REFERENCES categories(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_collections_category
  ON collections(category_id) WHERE category_id IS NOT NULL;

-- ── category_status drain on items (mirrors thumb_/transcript_/embed_status) ──
-- ADD COLUMN with a NOT NULL DEFAULT backfills every existing row to 'pending'
-- without a table rewrite; the CHECK pins the vocabulary. Does NOT touch the
-- items_fts column set, so the shipped FTS triggers stay valid and NO rebuild runs.
ALTER TABLE items ADD COLUMN category_status TEXT NOT NULL DEFAULT 'pending'
  CHECK (category_status IN ('pending','done','skipped','error'));
CREATE INDEX IF NOT EXISTS idx_items_category_queue
  ON items(category_status) WHERE category_status = 'pending';
```

Notes that make it buildable:

- **`state` (assigned|removed)** is the deepening that makes "auto retained, user wins" **durable**: read
  resolution is *user row if present, else auto row; a `state='removed'` effective row hides the
  membership*. The categorizer **only ever writes `source='auto'` rows** and **never touches `source='user'`
  rows**, so a re-cluster can never overwrite a correction (the same guard `embedding-orchestrator.ts`
  applies to its drain). This satisfies AC-30's "survives relaunch and re-clustering".
- **`signal`** is stored explicitly (per ADR-0029 §2 "every assignment stores why: `gps` |
  `theme-cluster` | `face-cluster`") rather than derived from `kind`, because a user can manually assign
  into any category (`signal='user'`) and because `explanation` (the human string, e.g. *"Near Cusco,
  Perú (from photo GPS)"* or *"Groups with 24 similar photos — beach, sea"*) is derived from `signal` +
  specifics.
- **`source_key` + its partial-UNIQUE index** keep re-clustering idempotent (upsert the auto category by
  its stable key rather than duplicate it). Place key = gazetteer place id; theme key = a deterministic
  cluster signature (its exact scheme is settled in card M4-2e/g).
- **`category_status`** is the categorization drain (new); themes additionally **consume** `item_embeddings`
  (already produced via the `embed_status` drain), so the two drains compose: embed first, categorize
  second.
- Migration `005` deliberately does **not** feed category names into `search_meta` — so `items_fts` is
  untouched and AC-7/AC-29 stay byte-identical. Making place/theme names full-text searchable is a
  deferred enhancement that WOULD require an FTS rebuild (out of scope here).

**Decision 2 — Places pipeline: dependency-free GPS clustering + a bundled OFFLINE gazetteer.**

- **Clustering (pure, no dependency).** Cluster the EXIF GPS already catalogued (`items.gps_lat/gps_lon`,
  `001_initial.sql:69`; partial `idx_items_gps`, `:175`) with **DBSCAN-style density clustering over a
  haversine metric** (`eps ≈ 1–2 km`, `minPts` small) — a pure-TS module in the `semantic.ts` mould
  (haversine is trivial closed-form math, unit-tested with synthetic coordinates, zero dependency).
  A coarse **geohash/grid pre-bucket** bounds the neighbourhood search so it stays sub-second at v1 scale
  (10k–100k items, far fewer with GPS). DBSCAN over greedy geohash-bucketing is preferred because raw
  geohash cell boundaries split a coherent place; buckets are only an index, not the cluster boundary.
  Deterministic ordering (stable id tiebreaks, as `semantic.ts` does) makes clusters reproducible/testable.
- **Reverse-geocoding = nearest gazetteer point.** For each cluster centroid, the **nearest** gazetteer
  entry by haversine yields *"City, Admin1, Country"* → the place category `name`; the gazetteer id is the
  category `source_key`. Nearest-neighbour over the gazetteer uses the same dependency-free grid/geohash
  bucket index (or a small pure-TS k-d tree); at v1 scale a bucketed scan is ample.
- **Bundled gazetteer decision (⚠️ ASK FIRST).**
  - **Candidate dataset (recommended): GeoNames `cities1000`** (all places pop. ≥ 1000 / county seats,
    ~150k rows) — or `cities500` for finer coverage. License **CC BY 4.0** (permissive **with
    attribution**). We keep only `name, lat, lon, admin1, country` and pre-pack to a compact binary/NDJSON,
    dropping the ~15 unused columns.
  - **Size:** the raw dump is tens of MB; trimmed + packed it is **single-digit MB** — ≪ the 119 MiB
    embedder, so it is **bundled** (no download ⇒ **zero egress**, keeping M4-2 time-boxed), exactly the
    "bundle when small" reasoning ADR-0029 applied to the embedder.
  - **License/attribution/NOTICES:** CC BY 4.0 obliges crediting GeoNames — add a **NOTICES** entry and an
    in-app **About/Credits** line (e.g. *"Place names © GeoNames, CC BY 4.0"*), the same third-party-notice
    hygiene ADR-0023/0027 tracked for whisper.cpp (MIT), llama.cpp (MIT), and FFmpeg (LGPL).
  - **Alternative:** **Natural Earth populated places** (public domain, **no attribution**) — coarser
    (~7.3k points) — the fallback if we prefer zero attribution obligation, at the cost of resolution
    (misses small towns). OSM/Nominatim extracts and Who's-on-First are **rejected**: far larger and ODbL
    share-alike complexity.
  - **Packaging (extraResources):** ship under `resources/gazetteer/` → `gazetteer/` in `Resources`,
    resolved at runtime from `process.resourcesPath` by `electron/main/categorize/gazetteer.ts`. Unlike the
    whisper/embed/media binaries this asset is **arch-independent** (it is data, not a `.node`/executable),
    so **no `${os}-${arch}` expansion** — ONE copy per installer. A missing asset degrades places to
    *cluster-without-label* (or a coordinate-only label), never a crash — mirroring the `embed-cli`
    UNAVAILABLE degrade. Editing `electron-builder.yml` + adding a licensed asset is the ⚠️ ask-first gate.

**Decision 3 — Themes pipeline: dependency-free clustering over the EXISTING embeddings (no new model).**

- **Reuse the M4-1 embedder.** Themes cluster the `item_embeddings` produced by M4-1
  (`multilingual-e5-small`, 384-dim), loaded via `decodeVector` (`embeddings-repo.ts`). **No new model,
  no new dependency** — the embedder is already gated/opted-in for smart search.
- **Clustering choice (pure).** **Threshold agglomerative / greedy online clustering over cosine
  distance** — assign each item (in stable id order) to the nearest existing cluster centroid when cosine
  `≥ τ`, else start a new cluster; drop clusters below a min size — using a bounded, early-terminating
  cosine (`boundedCosine`, output-identical to `cosineSimilarity` from `semantic.ts`, with a
  Cauchy-Schwarz prune for the large-corpus hot path, #318). It needs **no pre-specified k** (k-means is rejected: k is unknown and seeding is
  non-deterministic) and is deterministic ⇒ testable with synthetic vectors. DBSCAN-over-cosine is the
  documented alternative if density beats a global threshold on real fixtures (settled in the card).
- **Theme label derivation (offline, no LLM, no dependency).** A cluster has no inherent name, so derive
  one from the **most salient terms** across its items' `description`/`search_meta`/transcript text:
  tokenize with the same `unicode61`/diacritic-folding approach FTS uses, drop stopwords from a **small
  bundled multilingual (ES/EN/PT) list** (hand-rolled data, not a `stopword`/`natural` npm dep — ADR-0014/
  0015 ethos), and rank by **TF-in-cluster ÷ DF-in-corpus** (a TF-IDF-ish distinctiveness score); the top
  1–3 terms become *"Beach"*, *"Birthday"*, *"Cusco trip"*. Because a text-derived label is weaker than a
  gazetteer place name, the theme label is an explicitly **lower-confidence suggestion** the user can
  **rename** (Decision 4/5). Auto confidence = the item's cosine to its cluster centroid (clamped to
  [0,1]); `signal='theme-cluster'`.

**Decision 4 — Explainability + correction data model (how it is stored + surfaced).**

- **Stored** in `item_categories` (Decision 1): `signal` (machine reason), `confidence` (auto only),
  `explanation` (the human string), `source` (`auto`/`user`), `state` (`assigned`/`removed`).
- **Surfaced**: each item shows its category chips; a chip's detail/tooltip shows the `explanation` +
  `confidence` (e.g. *"Auto — near Cusco, Perú (photo GPS) · 0.92"*). A category page lists its members and
  its provenance (auto vs user-curated).
- **Corrections (user wins, both retained):** *confirm* (add a `user`/`assigned` row over the auto one),
  *remove* (add a `user`/`removed` tombstone — the auto row stays), *reassign* (remove from C + assign to
  D), *rename category*, *create category*. Read resolution is *user row wins; auto retained*; the
  categorizer only ever (re)writes `auto` rows, so corrections are durable across re-clustering — the same
  dedup-with-provenance ethos as ADR-0003 and the drain-safety of the embedding orchestrator.
- **Default-off gate (mirrors transcription/smart-search).** A dedicated **`categorizationOptedIn`** key on
  the parameterized `consent-store.ts` gates the whole feature; a build-time **`isGazetteerBundled()`**
  signal (the `isEmbedModelPublished()` pattern) reveals the opt-in only once a signal/asset exists.
  Places need only the **bundled** gazetteer (present after M4-2 ships); themes additionally need the
  **opted-in embedder** (degrade to places-only when the embedder is absent, exactly as live search
  degrades to exact FTS). With the feature off, browse/search/timeline (AC-6/AC-7/AC-29) are byte-identical.

**Decision 5 — M4-3 suggested collections: derived, user-curated, reusing the EXISTING tables.**

- **Derivation (read-only).** Suggestions are **computed** from `categories`/`item_categories` — a
  place/theme category with **≥ N effective members** is a collection candidate — and are **NOT
  pre-materialized** as `collections` rows. The engine excludes any category that already has a
  `collections` row on `category_id` (accepted `origin='suggested'` or a `origin='dismissed'` tombstone),
  so each candidate is offered **at most once** until its state changes.
- **Reuse `collections`/`collection_items`** (`001_initial.sql:131–145`, v1-minimal per ADR-0003) — M4-3
  adds only the Decision-1 provenance columns.
- **Curation UX (a review tray — never the main list):** **accept** → INSERT a `collections` row
  `origin='suggested'`, `category_id=C`, copy the category's members into `collection_items`; **rename** →
  edit `name`; **merge** → move members into the surviving collection and drop a `origin='dismissed'`
  tombstone for the merged-away category; **dismiss** → INSERT a member-less `origin='dismissed'`,
  `category_id=C` tombstone so it is not re-proposed (durable).
- **NEVER silently created (invariant, AC-32):** *the categorizer/suggester never INSERTs a `collections`
  row on its own — a row appears only from an explicit user action* (hand-create, accept, dismiss/merge
  tombstone). Suggestions live only in the read-only tray until accepted.

**Decision 6 — Off-thread execution + the drain (extends AC-9/AC-18).**

- **Compute in a `worker_thread`.** Both cluster passes are CPU-bound over the whole corpus (haversine
  DBSCAN over GPS points; O(n·k) cosine agglomeration over 384-dim vectors) and must never block the
  renderer or the main event loop → run them in a `worker_thread` via the AC-18 transport
  (`transcription/queue/worker-threads-transport.ts`). (M4-1 embedding could stay on the main process
  because its heavy work was already the `embed-cli` subprocess; clustering has no subprocess, so it needs
  the thread.)
- **A `CategorizationOrchestrator` mirroring `EmbeddingOrchestrator`** — gated (opt-in + signal present ⇒
  else refuse with no side effects), resilient (a per-item/per-cluster failure is recorded and the run
  carries on), cooperatively cancellable, single-flight, injected collaborators (store, worker transport,
  gazetteer reader, progress sink, cancel signal) so it unit-tests with fakes + a real in-memory DB.
- **The `category_status` drain** (`pending → done | skipped | error`) backfills the existing catalog: new
  items import `pending`; the orchestrator folds pending items into the (re)clustered categories and flips
  them `done`; an item with no categorizable signal (no GPS and no embedding) is `skipped`; a failure is
  `error` and leaves the pending set (idempotent retry next run) — exactly the `embed_status` semantics.

**Decision 7 — Acceptance criteria (finalized wording for AC-30 / AC-32 / AC-33).**

Proposed for a later `PRD.md` PR (not edited here). They **augment, never replace** the canonical suite —
**AC-1 … AC-31 stay green** (cumulative regression; AC-29 semantic + AC-31 zero-egress shipped with M4-1).
The final id set is settled per slice.

- **AC-30 — On-device categorization is explainable + user-correctable.** Given a catalog whose items
  carry EXIF GPS and/or text embeddings, when categorization runs on-device, then items are auto-grouped
  into **places** (GPS clusters reverse-geocoded by the bundled offline gazetteer) and **themes**
  (text-embedding clusters); **each assignment exposes a human-readable reason + a confidence**; and a
  user **confirm / reassign / remove / rename** is **persisted with provenance** (`source='user'` wins
  over `source='auto'`, both retained) and **survives relaunch AND a later re-clustering pass** (a user
  decision is never overwritten by auto). People/faces are OUT OF SCOPE (M4-4). *(integration)*
- **AC-32 — Suggested collections are user-curatable (never silently created).** Given auto-derived
  place/theme categories, when Kawsay proposes collections, then each suggestion is **surfaced for review
  only** and becomes a listed collection **only on explicit accept**; the user can **accept / rename /
  merge / dismiss**; a **dismiss is durable** (that suggestion is not re-proposed); and **no `collections`
  row is ever created without an explicit user action**. Reuses the existing `collections`/
  `collection_items` tables. *(integration)*
- **AC-33 — Inference is non-destructive + default-off (extends AC-14).** Deriving categories / clusters /
  labels / suggestions **never alters or deletes an original** (they are removable renditions), and
  **nothing runs until the feature is explicitly enabled and its signal/asset is present** — places
  require the bundled gazetteer, themes require the opted-in embedder — mirroring the transcription /
  smart-search opt-in gate; with the feature off, browse/search/timeline (AC-6 / AC-7 / AC-29) are
  byte-identical. *(integration)*

**AC-31 continuity (no harness edit needed here):** the AC-4 zero-egress harness continues to assert no
egress during categorization/suggestion. Because the gazetteer is **bundled** and themes **reuse** the
already-covered M4-1 embedder, **M4-2/M4-3 add no new outbound request** — the only M4 egress remains the
M4-1 embedder `GET`. So, unlike M4-1, **no `tests/ac4` / `network-guard` edit is required** for this
milestone (that harness-integrity edit stays an M4-5 human-required concern, out of scope).

**Decision 8 — Build-card breakdown (TDD-sized; each = one PR; seeds the board on merge).**

Every card is test-first (`test(scope)` failing commit before `feat|fix(scope)`), Sentinel-reviewed, and
must keep AC-1 … AC-31 green. *Risk class* = Sentinel review weighting; *Gate* = the authorization tier
that must clear before the card lands.

M4-2 · Categorization

- **M4-2a · Migration 005 schema.** *Scope:* the Decision-1 DDL (`categories`, `item_categories`,
  `collections` provenance ALTERs, `category_status` drain + indexes). *Acceptance:* runner applies once,
  forward-only + idempotent, CHECKs enforced, and `db-migrate.test.ts` proves `search()` is byte-identical
  before/after (AC-7/AC-29). *Risk:* schema. *Gate:* **🚨 HUMAN-REQUIRED** (authoring migration 005).
- **M4-2b · Categories + assignments repo.** *Scope:* `categories-repo.ts` — category upsert by
  `source_key`; `item_categories` writes with `source/state/signal/confidence/explanation`; the read-time
  "user wins / auto retained / removed tombstone" resolver; guarantee an auto re-write never touches user
  rows. *Acceptance:* unit tests for resolution + correction durability. *Risk:* medium. *Gate:* auto
  (depends on M4-2a). 
- **M4-2c · Places clustering (pure).** *Scope:* dependency-free haversine + DBSCAN/threshold clustering
  over GPS, deterministic. *Acceptance:* unit tests with synthetic coordinates. *Risk:* low. *Gate:* auto.
- **M4-2d · Offline gazetteer asset + reverse-geocoder.** *Scope:* pre-pack GeoNames `cities1000`
  (CC BY 4.0); `gazetteer.ts` nearest-neighbour reverse geocode; `extraResources` packaging (arch-
  independent); NOTICES/About attribution; graceful degrade when absent. *Acceptance:* fixtures resolve to
  City/Admin/Country; no egress; missing-asset degrade. *Risk:* heavy-asset + packaging + license. *Gate:*
  **⚠️ ASK FIRST** (new bundled asset/dependency + `electron-builder.yml` change + third-party license).
- **M4-2e · Themes clustering (pure).** *Scope:* dependency-free cosine threshold/DBSCAN clustering over
  `item_embeddings` (reuse `cosineSimilarity`), deterministic; defines the theme `source_key`. *Acceptance:*
  unit tests with synthetic vectors. *Risk:* low. *Gate:* auto.
- **M4-2f · Theme label derivation.** *Scope:* TF-IDF-ish salient-term labelling; small bundled ES/EN/PT
  stopword data (no npm dep); user-renamable default. *Acceptance:* stable labels for fixture clusters.
  *Risk:* low-medium. *Gate:* auto (a new NLP npm dep would flip this to ⚠️ ask-first — avoid it).
- **M4-2g · Categorization orchestrator + worker_thread + `category_status` drain.** *Scope:* mirror
  `EmbeddingOrchestrator` (gated, resilient, cancellable, single-flight); run clustering in a
  `worker_thread` (AC-9/AC-18); drain `category_status`. *Acceptance:* unit tests with fakes + in-memory
  DB; refuses when disabled / no signal; partial-failure resilience. *Risk:* medium (concurrency). *Gate:*
  auto.
- **M4-2h · Opt-in gate + IPC + explainable UI.** *Scope:* `categorizationOptedIn` consent key +
  `isGazetteerBundled()`; zod-validated IPC to list categories/assignments and apply corrections; renderer
  chips + reason/confidence surfacing + confirm/reassign/remove/rename. *Acceptance:* **AC-30** integration;
  default-off; a11y (axe). *Risk:* medium (IPC + UI surface). *Gate:* auto (additive zod IPC — if the
  security/contextBridge surface materially changes, ⚠️ ask-first).

M4-3 · Suggested collections

- **M4-3a · Suggestion derivation (pure, read-only).** *Scope:* derive candidates from place/theme
  categories with ≥ N members; exclude already-materialized/dismissed categories (LEFT JOIN on
  `collections.category_id`); never writes. *Acceptance:* deterministic candidates; a "writes nothing"
  assertion. *Risk:* low. *Gate:* auto (depends on M4-2b).
- **M4-3b · Curation actions repo.** *Scope:* accept (INSERT `origin='suggested'`, copy members, link
  `category_id`), rename, merge (move members + tombstone), dismiss (`origin='dismissed'` tombstone).
  *Acceptance:* "never silently created" invariant; dismiss durability; merge correctness. *Risk:* medium.
  *Gate:* auto.
- **M4-3c · Suggestions IPC + curation UI.** *Scope:* zod IPC to list suggestions + apply accept/rename/
  merge/dismiss; a "Suggested collections" review tray. *Acceptance:* **AC-32** integration; a11y. *Risk:*
  medium. *Gate:* auto.

**Gates for the build cycle (enumerated).**

- **Migration 005 authoring (M4-2a) → 🚨 HUMAN-REQUIRED** (DB migration — AGENTS Boundaries / ADR-0008).
- **Offline gazetteer bundling (M4-2d) → ⚠️ ASK FIRST** — a new bundled third-party asset (heavy-dep
  class) + an `electron-builder.yml` packaging change + a CC BY attribution obligation. (It is **not** a
  network-egress gate: the asset is bundled and offline.)
- **Any new npm dependency (clustering / stopwords / geo) → ⚠️ ASK FIRST** — the design deliberately
  **avoids** this (dependency-free clustering + hand-rolled tokenizer + bundled data), per ADR-0014/0015.
- **Faces/people (M4-4) → 🚨 HUMAN-REQUIRED (biometric privacy-data) — OUT OF SCOPE here.**
- **Egress-proof / AC-4 harness edit (M4-5) → 🚨 HUMAN-REQUIRED (harness integrity) — OUT OF SCOPE here.**
  Because M4-2/M4-3 add no egress, no harness edit is needed for *this* milestone.

**Alternatives considered**

- **A cloud/managed reverse-geocoder or vision categorizer** (Google/Mapbox geocoding, cloud tagging) —
  **REJECTED outright**: ships GPS/pixels off-device → breaks AC-4 and PRD §7, MISSION §5 ("no online maps");
  on the NEVER list. All categorization is local.
- **A redundant `is_suggested` boolean beside `origin`** — rejected; one `origin` enum is the single source
  of truth (no two-column drift). Boolean → 0/1 awareness still governs `is_favourite` and any future flag.
- **Pre-materializing suggestions as `collections` rows** — rejected; suggestions are derived read-only and
  materialized only on explicit accept, so "never silently created" (AC-32) is literally true.
- **k-means (themes) / raw geohash-bucketing (places)** — rejected as the cluster boundary: k-means needs
  an unknown k with non-deterministic seeding; geohash cell edges split coherent places. Buckets are used
  only as a dependency-free spatial index over a DBSCAN/threshold boundary.
- **New npm deps** (`stopword`, `natural`, `hnswlib-node`, a geocoder package, a k-d-tree lib) — rejected;
  hand-rolled pure-TS + bundled data keeps M4-2/M4-3 dependency-free (ADR-0014/0015), reserving heavy-dep
  gates for genuine scale needs (ANN, ADR-0029).
- **OSM/Nominatim or Who's-on-First gazetteer** — rejected: far larger, ODbL share-alike complexity;
  GeoNames (CC BY) or Natural Earth (public domain) are small + permissive.

**Consequences**

- **Enables** on-device auto **places + themes** categorization (explainable + correctable) and
  user-curated **suggested collections** — the M4-2/M4-3 vision — with **zero new egress** and **no
  destructive FTS rebuild**.
- **Two authorization gates only** for the whole build cycle: migration 005 (human-required) and the
  gazetteer asset (ask-first). Faces (M4-4) and the AC-4 harness edit (M4-5) stay out of scope.
- **+installer size** by the single-digit-MB gazetteer (arch-independent, bundled once) — the only
  packaging impact; no new native binary, no new npm dependency.
- **New off-thread work** — a `worker_thread` cluster pass + a `category_status` drain that backfills the
  existing catalog (extends AC-9/AC-18).
- **Preserves** exact/semantic search (AC-7/AC-29), non-destructive originals (AC-14), and zero-egress
  (AC-4/AC-31); **default-off** until enabled + signal present. **Ratchet:** AC-1 … AC-31 stay green;
  coverage / lint-clean never decrease.
