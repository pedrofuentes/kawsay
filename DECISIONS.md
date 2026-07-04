# Architecture Decision Records — Kawsay

> **Record every significant technical decision here.** When choosing between approaches,
> document what was chosen and why. This prevents future agents and developers from
> re-debating settled decisions or accidentally reversing them.
>
> Do NOT write decisions to AGENTS.md — they belong here.

## Format

```markdown
### ADR-NNN: Decision Title
**Date**: YYYY-MM-DD
**Status**: Proposed / Accepted / Superseded by ADR-NNN
**Context**: What problem or question prompted this decision?
**Decision**: What was decided?
**Alternatives considered**: What other options were evaluated?
**Consequences**: What are the trade-offs? What does this enable or prevent?
```

> **Authorization tiers** (MISSION §9) are noted on each ADR: `auto` (reversible) · `auto-with-audit`
> (this ADR is the audit note) · `human-required` (blocks until @pedrofuentes approves). The full
> *how* for each decision lives in [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md).

## Decisions

<!-- Add new decisions below this line, most recent first -->

---

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
  labels) off-device. Reverse-geocoding is **offline only** (MISSION §7: "no online maps") via a
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
  `≥ τ`, else start a new cluster; drop clusters below a min size — reusing `cosineSimilarity` from
  `semantic.ts`. It needs **no pre-specified k** (k-means is rejected: k is unknown and seeding is
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
  **REJECTED outright**: ships GPS/pixels off-device → breaks AC-4 and MISSION §7 ("no online maps");
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

---

### ADR-0029: M4 — On-device AI categorization & smart search (design)

**Date**: 2026-06-30 (accepted 2026-07-01)
**Status**: Accepted — @pedrofuentes signed off on 2026-07-01; the design below is ratified and the
implementation decisions settled during M4-1b are recorded in **Decisions ratified during implementation
(M4-1b)** at the end of this ADR. This was the **M4 design-discovery gate artifact** (the analogue of ADR-0027
for M2): research + design only — **no product code, no schema, no dependency, no config** — that laid out the
concrete on-device approach and surfaced the decisions @pedrofuentes confirmed before the first implementation
slice (M4-1).
**Tier**: **human-required** (MISSION §9 + ROADMAP M4). M4's default is **time-boxed _only if_ models are
bundled/on-device with no new egress**; **any model download or cloud API is human-required** (network egress —
MISSION §9 project override; ROADMAP.md:144). Independently, three further triggers can fire: a **heavy/unusual
dependency** (an embedding/face model + possibly a new native runtime or vector library), a **DB migration**
(migration 003 — AGENTS Boundaries / ADR-0008), and — for the later face/people slice — **biometric privacy-data**
(a deceased person's facial embeddings). Any one alone gates; this ADR is the blocking decision record.
Extends ADR-0003 (catalog/FTS/dedup), ADR-0004 (off-thread ingestion), ADR-0008 (zero-egress invariant), and
**mirrors ADR-0027** (M2's bundled-binary + opt-in consent-download + scoped-egress pattern).

**Context**
ROADMAP **M4 — AI categorization & smart search** (ROADMAP.md:138–145; MISSION §4) proposes three capabilities:
**automatic grouping** (people, places, themes), **smarter/semantic search**, and **suggested collections**. The
acceptance direction is fixed: categorization + inference run **on-device** (preserve **AC-4**); results are
**explainable** and **user-correctable**; smart search **extends AC-7 without regressing exact search**; new ids
**AC-1x**. The binding constraints:

- **AC-4 zero-egress is load-bearing** (MISSION §5, NEVER list; PRD AC-4): a loved one's memories — now also their
  derived **embeddings** — must never leave the machine. **Cloud/API inference is on the NEVER list**: sending
  pixels, text, or even "just embeddings" off-device breaks AC-4. All inference is local.
- **AC-7 exact search must not regress** (PRD.md:206–211). The existing FTS5 path is the external-content virtual
  table `items_fts` (`electron/main/db/migrations/001_initial.sql:148`, tokenize `unicode61`) kept in sync by the
  `items_fts_ai/ad/au` triggers (001_initial.sql:152–165); `toFtsMatchQuery` builds prefix terms and `search()` runs
  `items_fts MATCH @match ORDER BY rank` (`electron/main/db/catalog-repo.ts:199,430`), exposed via
  `catalogSession.search` over the `CATALOG_SEARCH` IPC (`electron/main/index.ts:222`; `electron/preload/api.ts:62`).
  Smart search must **extend** this path, never replace it.
- **AC-14 originals untouched** (PRD.md:267–273): deriving embeddings/categories reads pixels/text but never modifies
  or deletes an original; embeddings + categories are **derived renditions** (like thumbnails/transcripts), removable
  without data loss.
- **AC-9 off-UI-thread** (PRD.md:222–229; ARCHITECTURE §9): heavy inference runs in the `worker_threads` harness / a
  bounded subprocess — never the renderer.
- **On-device precedent already exists (M2 / ADR-0027).** Transcription bundles a native binary (`whisper-cli`) and
  consent-downloads its weights once on opt-in, guarded by `electron/main/security/network-guard.ts`
  (deny-by-default + one allowlisted `GET` via Electron `net.request` on the guarded session) and proven by the AC-4
  harness in `tests/ac4/` (`network-guard.test.ts`, `no-egress.node.test.ts`, `macos-deny.sb`, the Node
  `egress-spies.ts`). M4 should **reuse this exact pattern** (`model-download.ts`, `model-source.ts`,
  `model-integrity.ts`, `consent-store.ts`, `transcription-orchestrator.ts`) rather than invent a new one.

**Decision (proposed)** _(all subject to the human-required sign-off below)_

1. **Smart/semantic search — text embeddings + brute-force cosine, MERGED with the existing FTS path.**
   - **Model + runtime (recommended):** a **small _multilingual_ text-embedding model** (the audience is
     international — Spanish + others — the same rationale that picked multilingual whisper in ADR-0027). **Reuse the
     established bundled-native-binary + consent-download seam** (à la whisper.cpp): a compact GGUF embedding model
     run as a bounded, off-thread **subprocess** via a bundled embedding binary (a llama.cpp-family `*-embedding`),
     mirroring ADR-0027 Decisions 2/6 (array argv, local-file-only, hard timeout, bounded caps). A **wasm/JS
     embedder** (`transformers.js` / `onnxruntime-web`) is the documented alternative (no per-arch native build, but
     a new in-process runtime dependency + wasm perf). _Exact model + size + checksum are deferred to a short
     validation spike (an M4-0 analogue of M2-0) — this ADR deliberately does **not** fabricate accuracy/size numbers
     (the same discipline ADR-0027 adopted after its illustrative WER figures were flagged)._
   - **Storage (migration 003):** embeddings persist in SQLite as `float32` BLOBs in a new `item_embeddings` table
     keyed by `item_id` (+ `model_id`, `dim`, `kind`) so a model change can re-embed and provenance is explicit.
   - **Query (dependency-free first slice):** a **brute-force cosine** scan over the stored vectors — computed in TS
     over the BLOBs or via a registered SQLite UDF (the `db.function('merge_tokens', …)` precedent,
     `catalog-repo.ts:329`). **No new vector-DB dependency** at v1 scale (10k–100k items). `sqlite-vec` (loadable
     extension) or an HNSW library are noted as **heavier ANN alternatives** for later scale (each a new dependency →
     heavy-dep human-required).
   - **Merge (AC-7 preserved):** smart search runs the **unchanged** `items_fts MATCH` exact query **and** a semantic
     KNN, then merges/re-ranks (every exact match still returned and ranked, then semantically-related items with no
     lexical overlap). With **no model present, search falls back to exact FTS** with byte-identical AC-7 results.
     The seam extends `catalog-repo.search` / `CATALOG_SEARCH` (zod-validated) **additively** — exact search never
     regresses.

2. **Categorization (people / places / themes) — phased, cheapest local signals first; explainable + correctable.**
   - **Places (cheapest — no new model):** cluster on the **EXIF GPS already catalogued** (`items.gps_lat/gps_lon`,
     001_initial.sql:69; partial `idx_items_gps`), reverse-geocoded **with a bundled offline gazetteer** (MISSION §7:
     "no online maps").
   - **Themes (reuse the text embedder):** cluster the `item_embeddings` from Decision 1 — no extra model.
   - **People/faces (heaviest — later, separately gated):** photo **face-embeddings** need a **separate, heavier
     face-detection + embedding model** and create a **biometric** privacy surface (a deceased person's face vectors)
     → deferred to a late slice, **human-required**.
   - **Explainable + user-correctable:** every assignment stores **why** (signal = `gps` | `theme-cluster` |
     `face-cluster`, plus a confidence), and **user overrides are persisted with provenance** (a `source` of `auto`
     vs `user`, both retained, user wins — the same dedup-with-provenance ethos as ADR-0003). **Default-off until a
     model is present** (mirrors the transcription opt-in gate, `consent-store.ts`).

3. **Suggested collections — derived, user-curatable, reusing the EXISTING tables.** `collections` and
   `collection_items` **already exist** (001_initial.sql:131–145, v1-minimal per ADR-0003). M4 **reuses** them,
   adding only a provenance flag (e.g. `origin` / `is_suggested` + optional `category_id`) so auto-suggested
   collections are distinguishable and the user curates them (accept / rename / merge / dismiss) — never silently
   created.

4. **Schema (migration 003 — specified, not implemented).** Following the `.sql` + Vite `?raw` pattern in
   `electron/main/db/migrate.ts` (next file = `003_*.sql`, appended to `MIGRATIONS`), forward-only + idempotent
   (`IF NOT EXISTS`), named-param-binding aware (LEARNINGS: `boolean`→0/1):
   - `item_embeddings(item_id, kind, model_id, dim, vector BLOB, created_at)` — derived vectors, FK `ON DELETE
     CASCADE` (mirrors `transcripts`, 002).
   - `categories(id, kind CHECK IN ('person','place','theme'), name, created_at)`.
   - `item_categories(item_id, category_id, source CHECK IN ('auto','user'), confidence, explanation, created_at)` —
     explainable + correctable assignments.
   - **Extend** existing `collections` / `collection_items` with the suggested-collection provenance flag (Decision
     3).
   - An **`embed_status` drain column** on `items` (analogous to `thumb_status` in 001 / `transcript_status` in 002)
     to backfill embeddings over the existing catalog off-thread.
   - **No `items_fts` column change** → **no destructive FTS drop+rebuild** (the semantic index is separate from FTS,
     unlike the transcript case in ADR-0027 §5).

5. **Privacy-data design.** Inference + embeddings stay **on-device** (AC-4); **no telemetry on content**;
   assignments are **explainable + user-correctable**; **originals untouched** (AC-14 — embeddings/categories are
   derived, removable renditions); the feature is **default-off until a model is present**; biometric **face** vectors
   (later slice) are stored locally only and deletable, and are independently human-required.

6. **AC-4 egress preservation.** If any model is **consent-downloaded**, it reuses the M2 pattern verbatim — opt-in
   consent (`consent-store.ts`), an Electron `net.request` on the guarded session, a **single pinned-URL `GET`** added
   to `network-guard.ts`'s allowlist (method + exact URL + empty body, à la `isAllowedModelDownloadRequest`), and the
   `tests/ac4` firewall harness **extended** to cover the new path (exact-URL `network-guard.test.ts`; OS-deny
   `macos-deny.sb`; the Node spies stay **deny-all**). Editing the egress policy + AC-4 harness is **harness-integrity
   → human-required**. **Note:** unlike whisper's ~466 MiB weights, a small embedder may be **bundlable in the
   installer**, in which case there is **zero new egress** and M4 stays **time-boxed** — bundle-vs-download is a key
   decision below.

**Proposed new acceptance criteria (AC-29+ — wording for PRD §4; proposed here, not edited into PRD).** They
**augment, never replace** the canonical suite and must keep **AC-1 … AC-28 green** (cumulative regression):

- **AC-29 — Semantic search extends AC-7 without regressing exact search.** Given a catalog with known
  text/captions/transcripts plus seeded semantically-related items, when the user runs smart search, then every exact
  FTS match AC-7 would return is **still returned and ranked** (AC-7 stays green), semantically-related items with no
  lexical overlap are **also** returned/merged, and with **no model present** search falls back to exact FTS with
  identical AC-7 results. _(integration)_
- **AC-30 — On-device categorization is explainable + user-correctable.** Given items auto-grouped into
  people/places/themes, each assignment exposes a **human-readable reason + confidence**, and a user
  reassign/remove/confirm is **persisted with provenance** and survives relaunch (auto value retained, user value
  wins). _(integration)_
- **AC-31 — Zero-egress preserved for embedding/inference (extends AC-4).** With categorization/smart-search enabled,
  no user data (pixels, text, transcripts, **vectors**) egresses — asserted by the AC-4 harness; the **only**
  permitted outbound is the opt-in, checksum-verified, data-free model `GET` from the exact pinned URL (**or zero
  outbound** if the model is bundled). _(integration + AC-4 harness)_
- **AC-32 — Suggested collections are user-curatable (never silently created).** _(integration)_
- **AC-33 — Inference is non-destructive + default-off (extends AC-14).** Deriving embeddings/categories never alters
  an original, and nothing runs until a model is present + enabled. _(integration)_ — _the final AC set is settled per
  slice._

**Proposed M4 slice breakdown (TDD per AGENTS.md; seed the board on approval).**

1. **M4-0 · this design ADR + a model-validation spike** (analogue of M2-0): pick/validate the embedding model on
   real multilingual fixtures; pin size + checksum. **human-required (this ADR).**
2. **M4-1 · Semantic search over existing text/transcripts (RECOMMENDED first slice — lowest-risk):** text
   embeddings only (messages/captions/transcripts already in `search_meta` / `description`), brute-force cosine,
   migration 003 `item_embeddings` + `embed_status`, merged with FTS — **exact search never regresses**. No images,
   smallest privacy surface, highest "smart search" payoff.
3. **M4-2 · Categorization** — places (EXIF GPS, no new model) + themes (text-embedding clusters); `categories` /
   `item_categories`; explainable + user-correctable UI.
4. **M4-3 · Suggested collections** from categories/clusters; reuse `collections`; curation UI.
5. **M4-4 · Face/people clustering (heaviest, later)** — photo face-embeddings; new heavier model + **biometric**
   privacy surface → **human-required**.
6. **M4-5 · Zero-egress proof extension** — extend `tests/ac4` to cover the embedding model's download/inference path
   (mirrors M2-7) → **human-required (harness-integrity).**

**Alternatives considered**

- **Cloud / API inference** (OpenAI embeddings, Google Vision, a managed vector DB like Pinecone) — **REJECTED
  outright:** any of these ships user pixels/text/embeddings off-device → **breaks AC-4** and sits on the MISSION §5
  / AGENTS **NEVER** list. Even "embeddings-only" egress is user-derived data. Non-negotiable.
- **FTS-only / no semantic layer** — under-delivers M4's "smarter/semantic search", so **rejected as the end state**;
  but it **is** the graceful **fallback when no model is present** (so exact AC-7 search always works).
- **Runtime:** bundled native GGUF embedder (llama.cpp-family) **[recommended — mirrors ADR-0027's proven seam]** ·
  wasm/JS embedder (`transformers.js` / `onnxruntime-web`) [no per-arch native build, but a new in-process runtime
  dep + wasm perf] · Python `sentence-transformers` [**rejected** — Kawsay ships no Python runtime, exactly as
  faster-whisper was rejected in ADR-0027].
- **Vector store:** dependency-free **brute-force cosine [recommended first slice]** · `sqlite-vec` loadable
  extension [ANN at scale, but a new native/loadable dependency] · HNSW lib (`hnswlib-node`) [new native dep]. Both
  ANN options are **heavy-dep → human-required**; revisit only when brute-force is measured too slow.
- **Model delivery:** **bundle the weights** [no egress, time-boxed, +installer size — newly viable here because a
  small embedder ≪ whisper's 466 MiB] · **opt-in consent-download** [smooth UX, one audited egress, the ADR-0027
  `net.request` + `network-guard` pattern — **human-required**]. Recommend **evaluating bundling first** (avoids
  egress entirely, keeping M4 time-boxed); fall back to consent-download if the chosen model is too large to bundle.

**Consequences**

- **Heavy-dependency + packaging impact:** a new embedding model (and possibly a per-arch native embedding binary or
  a wasm runtime dep) → either **+installer size** (bundle) or **a second opt-in consent-download** (egress). The
  later face slice adds a heavier model + biometric data.
- **DB migration 003** (new tables + `embed_status`) → **human-required**; `items_fts` is **unchanged**, so **no
  destructive FTS rebuild** (cheaper than ADR-0027's transcript case).
- **New off-thread inference** — embedding/clustering run in `worker_threads` / a bounded subprocess (extends AC-9,
  mirrors AC-18); a net-new per-item `embed_status` drain backfills the existing catalog.
- **Authorization:** the egress (if any download), the heavy dep, the migration, the biometric face data, and the
  AC-4 harness edit are each **human-required gates**.
- **Enables** semantic search + auto people/places/themes + suggested collections (the M4 vision); **prevents**
  nothing about exact search (AC-7 preserved) and **moves no user data off-device** (AC-4); **default-off** until a
  model is present. **Ratchet:** AC-1 … AC-28 stay green; coverage / lint-clean never decrease.

**🚨 Human-required decisions to confirm before M4-1 implementation** _(this ADR is that gate artifact)_

- **(a) Embedding model + runtime + any dependency (heavy-dep gate).** Confirm a **small multilingual embedder**
  (exact pin via the M4-0 spike) and the runtime — **recommended: the bundled-native-binary GGUF seam mirroring
  ADR-0027**, vs a wasm/JS embedder — and whether it introduces a **new dependency**.
- **(b) Bundle vs consent-download the weights.** **Bundle** (no egress, time-boxed, +size) vs **consent-download**
  (one audited egress, human-required — the `net.request` + `network-guard` + `tests/ac4` pattern). **Download =
  egress = human-required.**
- **(c) DB migration 003** — authoring it is **human-required** (AGENTS Boundaries / ADR-0008).
- **(d) Vector-search mechanism** — **dependency-free brute-force cosine [recommended]** vs a **new vector
  dependency** (`sqlite-vec` / HNSW) → heavy-dep human-required.
- **(e) First implementation slice scope** — confirm **M4-1 = semantic search over existing text/transcripts**
  (recommended), with **face/people (biometric) clustering deferred** to a later, separately-gated slice.

**Decisions ratified during implementation (M4-1b)** _(confirmed 2026-07-01; these settle the open confirm-items
above and are recorded here as the audit note)_

- **(1) Delivery = opt-in consent-download, NOT bundled.** The ~124 MB embedder model is fetched once on explicit
  opt-in, reusing the M2 pattern verbatim (`consent-store.ts` + an Electron `net.request` on the guarded session +
  a single pinned, data-free `GET` on the `network-guard.ts` allowlist), rather than shipped in the installer.
  **Cofounder-approved** — resolves confirm-item (b); mirrors ADR-0027's whisper-model decision.
- **(2) The bundled `llama-embedding` binary is built network-free + CPU-only, per-arch.** It is compiled from
  pinned llama.cpp source with `LLAMA_OPENSSL=OFF` (no httplib/curl → no HTTP surface in the binary) and CPU-only,
  once per arch (`mac-arm64` / `mac-x64` / `win-x64`) on parallel CI legs — resolves confirm-items (a)/(d): the
  runtime is the bundled-native-binary GGUF seam with brute-force cosine, no new vector dependency.
- **(3) Semantic search stays dormant behind byte-identical exact FTS until the model is present.** With no model
  on disk the embedder resolves UNAVAILABLE and `catalogSession.search` returns exact-FTS results identical at
  every offset (AC-29 / AC-7 no-regression); the semantic merge path only activates once the model is downloaded.
- **(4) The model is published as a Kawsay Release asset (`models-embed-v1`)** via a maintainer-gated
  `workflow_dispatch`, sequenced BEFORE the consumer download flow (ADR-0027 Decision 6e), so the pinned download
  URL resolves to a Kawsay-owned, checksum-verified asset.

---

### ADR-0028: M3 iMessage/SMS first slice reads local macOS Messages `chat.db` directly
**Date**: 2026-06-28
**Status**: Accepted
**Tier**: auto-with-audit (local file connector, no new dependency, no new network egress).

**Context**: ROADMAP M3 adds more source connectors behind the existing importer interface. The first iMessage/SMS
slice needs to recognize a user-selected macOS Messages folder and preserve text messages with correct Apple-epoch
dates while keeping Kawsay's fully-local, partial-import-resilient architecture.

**Decision**: Add an isolated `imessage` importer registered ahead of the generic folder importer. `canHandle` accepts
only a directory with `chat.db`, `Attachments/`, and the expected Messages SQLite tables. `import` opens `chat.db`
with `better-sqlite3` in read-only/file-must-exist mode, iterates `message`/`handle`/`chat` rows, bounds emitted DTO
strings, converts Apple-epoch timestamps to UTC, and emits pure `message` catalog records with source provenance.
Attachment materialization/linkage and deeper SMS-vs-iMessage semantics are deferred; the row `service` is preserved
in `sourceMeta` for that follow-up.

**Alternatives considered**:
- Copy `chat.db` into scratch before reading — rejected for this slice because read-only access is simpler and avoids
  another original-retention path; if live-locked databases need special handling later, that can be added explicitly.
- Treat `~/Library/Messages` as a generic folder — rejected because it would miss text rows and shadow the connector.
- Add attachment ingestion now — deferred to keep the first PR mergeable and focused on text/date/provenance.

**Consequences**: AC-25 covers the connector's first vertical slice. Existing import orchestration, catalog writes,
zero-egress guardrails, and AC-15 skip reporting remain unchanged. A later M3 PR must add attachment correlation and
any richer iMessage/SMS service-specific behavior.

---

### ADR-0027: M2 on-device transcription — whisper.cpp via a bundled `whisper-cli` binary + an **opt-in, on-demand, checksum-verified download** of the multilingual **`small`** `ggml` model on the F3c worker/ffmpeg seam (binary bundled; model downloaded on opt-in)
**Date**: 2026-06-25 (revised 2026-06-25 after the cofounder locked the open decisions)
**Status**: Proposed — 🚨 **HUMAN-REQUIRED** (@pedrofuentes sign-off required before any building). This is the
**M2 architecture gate artifact**; it is research + design only (no product code). An independent **red-team** pass
(verdict **SOUND-WITH-FIXES**) was **incorporated**: fabricated Spanish-WER figures **relabeled as illustrative
clean-benchmark upper bounds** (no longer load-bearing — AC-21 fixes the threshold empirically, see Decision 4), the
subprocess zero-egress *proof* scoped to a net-new OS-deny harness (M2-7), and consent (AC-22), NOTICES (AC-23),
binary provenance, long-media, and the FTS-rebuild cost added. A **second red-team** pass (verdict
**SOUND-WITH-FIXES**, **0 blocking**) was then incorporated, correcting how the design is described **against the
real code**: the model download must flow through **Electron `net.request` on the guarded `session`** (so
`network-guard.ts`'s `webRequest` handler — *not* a Node-primitive downloader — is the real chokepoint; Decision
6d/7), the allowlist is scoped to **method + exact URL + empty body** (6d), the **CDN/redirect hosts** are corrected
(`release-assets.githubusercontent.com` / `*.cdn.hf.co`; 6a), and the **model-asset publication** is sequenced
**before** the downloader (new Decision 6e).
**Revised — the cofounder has now LOCKED the three open decisions, and they PIVOT the model-delivery design:**
(1) **model = `small`** (~466 MiB), multilingual; (2) **policy = opt-in** (no silent/automatic transcription); and
(3) **delivery = the app auto-downloads the `small` model on first opt-in** — it is **NOT** bundled in the installer
(bundling was explicitly rejected: *"is going to become a huge app to download and install"*; the cofounder
confirmed option **(b) "App auto-downloads on opt-in — smooth UX, one audited egress"** over **(c)** manual import).
**This revision supersedes the prior "bundle, never download" stance *within this same ADR*** (Decisions 6–7 below;
the bundle and manual-import options are now recorded as **Alternatives rejected by the cofounder**). The
**`whisper-cli` binary stays bundled** (built from source in CI) and the **installer stays ~200 MB**; only the
**model file** is fetched. Because this narrows the egress policy, it **touches the `network-guard` egress policy +
the AC-4 harness (`ac4-egress.yml`)** → it is the gate artifact for a **final cofounder confirm of the specific
pinned host(s) + exact URL + hard-coded SHA-256 + scoped-allowlist mechanism** before any building.
Extends ADR-0004 (off-thread ingestion), ADR-0012 (bundled ffmpeg/ffprobe), ADR-0003 (catalog/FTS), ADR-0007/0023
(packaging); **supersedes (within itself) its own earlier bundle-only packaging stance**; and **narrows ADR-0008
(zero-egress invariant) by exactly one user-initiated, data-free model fetch** — user memories remain absolutely
non-egressing (see Decision 7).
**Tier**: **human-required** (MISSION §9). **Three** independent triggers now fire: (1) a **heavy/unusual
dependency** — a platform-specific native binary plus a ~466 MiB `small` model; (2) **privacy-data capability**
design — turning a deceased person's voice into stored, searchable text; and (3) **a new product-runtime network
egress / external origin** — the opt-in model download narrows the §5 *product* network allowlist from **"None —
fully offline"** to **exactly one** pinned, data-free model `GET` (one origin **+ its signed-CDN redirect target**)
(MISSION §5/§9: "any action that would add network egress … →
human-required"). Any one alone gates; together they make this a deliberate, blocking cofounder decision. The
**time-boxed** M2 default (ROADMAP) holds **only while user data stays fully on-device** — and it does: **all
transcription runs 100% locally and no loved-one's audio or memories ever leave the machine.** What the design now
adds is a single, **data-free**, user-initiated model-file fetch, so the gate here is heavy-dep + privacy + the
**scoped-egress-policy** sign-off.

**Context**
ROADMAP **M2** ("the #1 post-v1 candidate", MISSION §4) is approved in principle: transcribe WhatsApp voice notes
and audio/video **on-device** so a grieving user needn't listen to every recording. The cofounder specifically
asked about **Whisper** and whether it is **"too heavy?"**. The binding constraints are non-negotiable:
- **AC-4 zero-egress is load-bearing** (MISSION §5, NEVER list): "a loved one's memories must never leave the
  machine," surfaced in-product as "your memories never leave this computer." **This promise is about *user data* —
  the loved one's audio and memories — and it remains absolute and CI-enforced.** Any **cloud STT** still breaks it
  outright (it ships a deceased person's voice off-device) and stays on the NEVER list. A **model download**,
  however, carries **no user data** — it is a plain GET of the app's **own public software component** (the `ggml`
  weights) — so the cofounder has accepted it as a **narrowly-scoped, opt-in, human-required** egress that does
  **not** move memories. (Distinguish: *user-data egress* = NEVER; *the app fetching its own model file* = one
  permitted, data-free, checksum-verified, single-host exception — Decisions 6–7.)
- **Off-UI-thread** (AC-9): heavy media work runs in the F3c `worker_threads` harness with
  `ffmpeg`/`ffprobe` as bounded subprocesses — never on the renderer thread.
- **Searchable + attached to items** (AC-6/AC-7): the FTS5 index `items_fts` (tokenize `unicode61`, which already
  handles ES/PT diacritics) over `items(title, description, search_meta)` is the existing search seam; the catalog
  already reserves the `audio` media-type and the `waveform` asset-kind
  (`electron/main/db/migrations/001_initial.sql`).
- **Resilience + integrity** (AC-15/AC-14): a failed item is skipped/reported, never aborts the run, and originals
  are never altered.
The question this ADR answers: **which engine, which Node integration, which model, and how is the model delivered
across macOS (arm64+x64) + Windows — without ever moving the user's memories off the device (AC-4)?**

**Decision** *(all subject to the human-required sign-off + red-team)*
1. **Engine — whisper.cpp** (`ggml-org/whisper.cpp`, **MIT**, stable **v1.9.1**, 2025). It is a dependency-free
   C/C++ port of OpenAI Whisper (also MIT): **Apple-Silicon first-class** (ARM NEON + Accelerate + **Metal**, with
   optional **Core ML**/ANE encoder for >3× speed-up), **CPU-only inference** on Windows x64 (MSVC/MinGW), and
   distributes models in the compact `ggml` format. License is MIT-compatible with Kawsay (MIT).
2. **Node integration — bundle the per-platform `whisper-cli` binary and invoke it as a sandboxed subprocess from
   the off-thread worker**, mirroring the bundled-ffmpeg/ffprobe seam (ADR-0004/0012): a discrete **array argv**
   (never a shell string), **local-file-only inputs**, a hard `timeout`, and **bounded stderr/stdout caps**. This
   reuses `electron/main/importers/deps/{thumbnail,ffprobe}.ts` patterns almost verbatim and the transport-agnostic
   F3c coordinator/protocol. We do **not** adopt an in-process N-API addon or `nodejs-whisper` for the first cut
   (see Alternatives).
3. **Audio extraction — reuse the bundled `ffmpeg`** to decode any voice note (`.opus`), audio, or video audio
   track to the **16 kHz mono PCM `s16le` WAV** that `whisper-cli` requires (`ffmpeg -i in -ar 16000 -ac 1 -c:a
   pcm_s16le out.wav`), via the same hardened `spawn` seam. No new media dependency.
4. **Model — the multilingual `small` `ggml` model (LOCKED by the cofounder).** The open `base`-vs-`small` question
   is **resolved: `small`** (~466 MiB; exact download **487,601,967 bytes**). It is multilingual (a model **without**
   the `.en` suffix) because the audience is international (Spanish **and** others); Whisper does language-ID +
   transcription across ~99 languages. The evidence supports choosing `small` over `base` for grief-critical,
   one-shot memories:
   - **Accuracy is monotonic in model size:** `tiny` < `base` < `small` < `medium` (larger = lower word-error
     rate). Any claim that `base` matches or beats `small` is wrong and **inverts** this ordering.
   - **Clean-benchmark Spanish WER (read-speech — illustrative, NOT asserted; upper-bound reference only):** on
     OpenAI's published Common Voice per-language breakdown, Spanish WER is roughly **`tiny` ~24%, `base` ~16%
     (≈15–17%), `small` ~10–11%, `medium` ~8%, `large` ~5–6%** (source: OpenAI Whisper paper, Radford et al. 2022,
     Appendix E / `openai/whisper` model card, Common Voice 15). **Treat these as optimistic clean read-speech upper
     bounds — not field accuracy, and NOT a load-bearing claim of this ADR**: AC-21 sets the only binding threshold,
     **empirically, on real samples** (M2-0). They are kept here purely to **illustrate** the monotonic size→accuracy
     ordering. On that ordering, **`base` Spanish WER (~15–17%) sits well above `small` (~10–11%)** — the gap that
     motivated picking `small`.
   - **Real WhatsApp voice notes will be worse:** spontaneous, accented, code-switched, compressed `.opus`,
     background noise → expect materially higher WER than the clean-benchmark figures above. Choosing the **larger of
     the two practical models** buys accuracy headroom precisely where field conditions erode it.
   - **Why `small` is now affordable:** the prior reason to hesitate on `small` was the **+233% installer** it
     implied when *bundled*. With the model **no longer in the installer** (Decision 6), that objection is gone — the
     installer stays ~200 MB and the size cost becomes a **one-time, opt-in ~466 MiB download**, not weight every
     user carries. So `small`'s accuracy is taken with **no installer penalty**.
   - **M2-0 is now a *validation* spike, not a choice:** it confirms `small` clears the WER ceiling on **real
     Spanish samples** and locks the **AC-21** threshold (it no longer decides `base` vs `small`). A quantized
     `q5_0` `small` variant may be measured later as an optional footprint optimization, but **full `small` is the
     default**.
   - **MEASURED + LOCKED (M2-6 harness, #137 — 2026-06-26):** the illustrative clean-benchmark figures above are now
     **superseded by real measurement** of the bundled `whisper-cli` 1.9.1 + `small` over 8 labeled, license-clean
     voice-note-style clips (4× es, 2× de, 2× ru; Apple Silicon/Metal; auto-detect; the app's own ffmpeg→`-oj`
     pipeline). Result: **overall aggregate WER 13.6%, Spanish 15.2%**, **auto-detect 7/8 (87.5%)**, **mean RTF
     0.25×** (~4× real time). **Every *correctly language-detected* Spanish clip transcribed at 0% WER** — the only
     Spanish errors came from **one 3.3 s clip auto-detected as Italian** (a language-ID miss, not a quality miss).
     **Verdict: `small` IS good enough — kept.** Locked ceilings (`tests/perf/thresholds.ts`): Spanish aggregate WER
     **≤ 22%**, overall **≤ 18%**, auto-detect floor **≥ 75%**, with a loose cross-platform RTF sanity bound (≤ 3×).
     ⚠️ These are **clean-clip** bounds — real noisy/accented WhatsApp audio is worse; the **field** AC-21 ceiling
     must still be set on real Spanish samples, and short-clip language-ID warrants a locale hint / user override.
     Pure WER/RTF/detection logic is unit-tested in normal CI; the heavy real-model run is **self-gated** (env-var,
     like the real-whisper tests) and never blocks required CI. Full evidence: `docs/perf/m2-wer-rtf-results.md`.
   - **`medium` (1.5 GiB) / `large` (2.9 GiB)** remain rejected: too large even as a download, and too slow on
     Windows CPU for a non-technical "in an afternoon" audience.
5. **Transcript storage + FTS** — transcripts **attach to the existing media item** (audio/video), never create new
   items. `items_fts` is an **external-content FTS5** table (`content='items'`) trigger-bound to `items`
   (`electron/main/db/migrations/001_initial.sql`), so the chosen seam is to **feed transcript text into the
   FTS-synced `search_meta` column** (whose semantics are already "denormalized FTS feed") — **not** `description`,
   whose semantics are "message body / caption / doc snippet" — or, if transcripts warrant their own field, add a
   **dedicated FTS-synced column** to `items`/`items_fts`. **Either way an `items_fts` column-set change requires
   dropping and rebuilding the external-content FTS table (and its triggers) over the whole catalog — not a cheap
   `ALTER`;** and a *separate* `transcripts` table would **not** be covered by the existing `items` triggers and
   would need its own FTS sync. This schema change is a **DB migration → HUMAN-REQUIRED** (AGENTS.md),
   dedup-with-provenance aware (ADR-0003), and its FTS-rebuild cost is sequenced into M2-4.
6. **Packaging & model delivery — bundle the binary, download the model on opt-in (the pivoted core decision).**
   The `whisper-cli` **binary** still ships **inside the installer** via `electron-builder` `extraResources` /
   `asarUnpack` (resolved at runtime through `process.resourcesPath`, consistent with how `ffmpeg-static`/
   `ffprobe-static`/`better-sqlite3` are unpacked today), built on the **per-arch native runners** already in CI
   (macOS arm64 + x64, Windows x64). The **`small` `ggml` model is NOT bundled** — it is **fetched once, on the
   user's first opt-in**, into the app's data dir. Installer stays **~200 MB**. Four parts specify the fetch:
   - **(a) Pinned trusted host + provenance — Kawsay's own GitHub Release asset re-hosting upstream.** The model is
     served from **Kawsay's OWN GitHub Release assets**, e.g.
     `https://github.com/pedrofuentes/kawsay/releases/download/models-v1/ggml-small.bin` (exact tag pinned at M2-1),
     re-hosting the upstream `ggml-org` / Hugging Face `ggerganov/whisper.cpp` `ggml-small.bin` **byte-for-byte**.
     Preferred over fetching Hugging Face directly because: (i) **we control availability + the URL** (no
     third-party rename, rate-limit, or takedown mid-grief); (ii) **GitHub Releases is already Kawsay's trusted,
     pre-authorized distribution origin** (MISSION §3/§5 — the installers themselves ship from there), so it is
     **not a new external party**, only a narrowing of the *product* runtime allowlist; (iii) we **pin one immutable
     Release tag + asset path** and own the checksum. **Redirect reality (do not assume one immutable URL):** the
     `github.com/…/releases/download/…` asset URL **302-redirects to a signed, time-limited
     `release-assets.githubusercontent.com` URL** (verified: a release-asset `GET` returns `302` →
     `release-assets.githubusercontent.com/…?…&se=<expiry>&sig=…&jwt=…`), so the allowlist must cover **both** the
     `github.com` origin **and** that redirect/CDN target (Decision 6d), and the signed URL's **expiry can outrun a
     long-paused resumable download** — a resume after the signature lapses must re-request the `github.com` URL for
     a fresh redirect. Integrity is unaffected (still a data-free GET, SHA-256-backstopped). Upstream provenance
     (source repo + file + version + size + SHA-256) is recorded for NOTICES (Decision 10 / AC-23). *(Direct-from-
     Hugging-Face is the documented fallback if we choose not to re-host; it trades control for one fewer hop —
     and likewise `huggingface.co/…/resolve/…` **302-redirects to a regional `*.cdn.hf.co` Xet host** (verified:
     `302` → `us.aws.cdn.hf.co/…?Expires=…&Signature=…&Key-Pair-Id=…`), with the same signed-expiry/resume
     interaction — and is the cofounder's call at confirm.)*
   - **(b) Integrity (mandatory, non-negotiable).** The **expected SHA-256 is hard-coded in the app** and the file
     is **verified before first use** — the app **never runs an unverified model**. The upstream `ggml-small.bin`
     (the bytes we re-host) has SHA-256 **`1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b`**, size
     **487,601,967 bytes** (the upstream Hugging Face LFS `oid` — this exact value is what the cofounder confirms and
     what the build pins). Install is **atomic**: download to a **temp file → verify SHA-256 → `rename()` into
     place**, so a partially-written or mismatched file is never visible as "the model." The download is
     **resumable** (HTTP range / restart) so a dropped connection on ~466 MiB doesn't restart from zero. A **corrupt
     or mismatched file is rejected and re-fetched**; repeated failure surfaces a calm error (never a crash) and the
     feature stays disabled. **On-disk re-verification (threat model):** the verified model then lives in the app
     data dir indefinitely, so **post-install on-disk tampering / corruption / bit-rot** is in scope, not only the
     download. **Preferred posture: re-validate the model's SHA-256 before each `whisper-cli` spawn** — hashing
     ~466 MiB adds ~1–2 s to a job that already runs **off-thread** in the background, an acceptable cost for never
     feeding an unverified model to the engine. The lighter alternative — verify **once after download** and rely on
     a size/mtime guard thereafter, justified by Kawsay being a **fully-local** app whose data dir is as trusted as
     the bundled binary — is recorded for the cofounder's call. → **AC-24**.
   - **(c) Consent UX — explicit opt-in before any byte leaves.** Before **any** download, an explicit **opt-in**
     screen (calm, non-technical copy) states: the **one-time ~466 MB** download; that **this is the only time the
     app ever uses the network**; that **your memories never leave this computer** (the model is the app's own
     software, not your data); and **what transcription enables** (readable, searchable text for voice notes / audio
     / video). It shows **progress**, handles **offline/failure gracefully** (a clear retry, no crash, no
     half-state), and the transcription feature **stays disabled until the model is present and verified**. No opt-in
     ⇒ no download ⇒ no network, ever. → **AC-22**.
   - **(d) Scoped egress design — exact-URL allowlist at the session/`webRequest` chokepoint, data-free,
     main-process only (Option Y).** The downloader issues the fetch through **Electron's `net.request` on the
     guarded `session`** (Chromium's native networking stack — **NOT** Node's `http`/`https`/`net`), so the existing
     `network-guard.ts` **`session.webRequest.onBeforeRequest` handler genuinely IS the single runtime chokepoint**
     for this request and can inspect the **full URL, method, and `uploadData` (body)**. This corrects a real-code
     contradiction in the prior wording: `network-guard.ts` installs **only** `session.webRequest.onBeforeRequest`
     (`electron/main/security/network-guard.ts`), which governs **Chromium/session traffic only** — a downloader
     built on **Node primitives would bypass `webRequest` entirely** and would **not be governed by
     `network-guard.ts` at all**. Routing through `net.request` is what makes the guard authoritative.
     The guard's allowlist matches **method `GET` + the exact pinned model URL(s) + an empty upload body** and
     **rejects everything else** — *not* merely a host: at the raw socket layer only `host:port` is visible (so a
     host-only allow would permit a `POST` smuggling a transcript in the body), whereas at the `webRequest` layer the
     **whole request shape** is visible, so we pin the **shape**. Because every candidate origin **302-redirects to a
     signed CDN host** (Decision 6a), the allowlist covers the **origin + its redirect/CDN target**: GitHub
     **`{github.com, release-assets.githubusercontent.com}`** — or, as the documented fallback, Hugging Face
     **`{huggingface.co, *.cdn.hf.co}`**. Redirects are **followed within the download path**, each hop kept
     **data-free** (GET, empty body), and the SHA-256 is **re-verified regardless of which CDN served the bytes**.
     **Everything else stays denied** by the deny-by-default guard, and the renderer **CSP `connect-src 'none'` is
     unchanged** — the renderer still cannot make *any* network request (the download is in the **main process**).
     **Observation note (load-bearing):** because the download flows through the **session/`webRequest`** layer
     rather than Node sockets, the **Node-prototype spies in `tests/ac4/egress-spies.ts` will NOT observe it** —
     those spies patch `net.Socket.prototype`/`dgram`/`node:dns`/`nock` and stay a pure assertion that
     **main-process Node outbound remains zero**. The "only permitted outbound" assertion (AC-17 / AC-24) is
     therefore made by the **`webRequest` guard's exact-URL allowlist + the OS-deny firewall**, **NOT** by the Node
     spies (we do not claim a Node-level chokepoint that does not exist). The allowlist entry is **GET-only, to the
     pinned URL(s), carrying no request body, no query of user content, and no headers derived from user data** — so
     it is **structurally incapable of exfiltrating a memory**: the only thing that can travel out is the request for
     a public, named model file, and the only thing that returns is that file (rejected unless its SHA-256 matches).
     This single entry — plus the matching AC-4 harness change — is the **🚨 HUMAN-REQUIRED** mechanism the cofounder
     confirms (Decision 7).
   - **(e) Asset publication is a prerequisite increment — publish the model *before* the downloader fetches it
     (chicken-and-egg).** Today `release.yml` publishes **only the installers** (`pnpm exec electron-builder
     --publish always`); **nothing publishes `ggml-small.bin`** (verified: no workflow references the model), so the
     `…/releases/download/models-v1/ggml-small.bin` asset the downloader targets **does not yet exist**. A discrete
     **pre-step / increment** — a manual run or a small, human-gated workflow, sequenced **before** the downloader
     integration — must: **fetch upstream `ggml-small.bin` → verify `sha256 == 1be3a9b2…fffea987b` AND
     `size == 487,601,967` → publish it to a `models-v1` GitHub Release with the weights' NOTICES/attribution**
     (Decision 10 / AC-23). A **publish-time equality check** (`hash(our_re-hosted_asset) == the pinned SHA-256`)
     gates the publish, so a corrupt or wrong re-host is caught **before** release — not only at the user's runtime
     verify (Decision 6b). *(The HF-direct fallback skips this publication step entirely at the cost of a
     third-party hop; it is the documented alternative.)*
7. **AC-4 preservation — reframed: zero *user-data* egress is still absolute; the ONLY permitted outbound is the
   opt-in model fetch.**
   **(a) The invariant that never bends:** **no user audio, no memory, and no derived transcript ever leaves the
   device.** Transcription runs **100% locally**: `whisper-cli` is spawned **local-file-only** (an array argv of
   file paths, never URLs), with **no network-capable code on the transcription path** and **no auto-updater**. This
   is **CI-enforced** (the AC-4 harness) and is the promise surfaced as "your memories never leave this computer."
   The model download moves **the app's own software component**, never the user's data — so the promise **remains
   true by construction.**
   **(b) The one narrowly-scoped exception:** the previously-absolute "zero network egress" is **narrowed** to permit
   **exactly one** kind of outbound traffic — an **optional, user-initiated, checksum-verified, data-free GET of the
   model file from the exact pinned URL(s) at a single trusted origin (+ its signed-CDN redirect)** (Decision 6).
   This is the **only** network the app ever makes: it
   is gated by opt-in (AC-22), verified by hard-coded SHA-256 (AC-24), and confined to the **exact pinned URL(s)**
   (GET + empty body) by the `network-guard` `webRequest` allowlist (Decision 6d). **Net statement: user-data egress
   = 0, forever; app-model egress = at most one optional, data-free fetch.**
   **(c) Proof status for the native subprocess — net-new OS-deny harness now DELIVERED (M2-7), with one documented
   residual gap.** The existing in-process `net`/`dgram`/`dns` spies + `nock` (`tests/ac4/egress-spies.ts`) prove the
   **main process only** and **cannot observe a separate OS process** (`tests/ac4/egress-subprocess.mjs`). By the same
   token they observe only **Node** outbound (they patch `net.Socket.prototype`/`dgram`/`node:dns`/`nock`): the opt-in
   model download deliberately uses **Electron `net.request` over Chromium's stack** (Decision 6d), so it too is
   **invisible to these spies** and is asserted instead at the `webRequest` allowlist + the OS firewall — not the Node
   spies. The **OS-level deny firewall** is authoritative for subprocesses; it was previously **Linux-only**
   (`.github/workflows/ac4-egress.yml` was `runs-on: ubuntu-latest`) while Kawsay ships **macOS arm64/x64 + Windows
   x64**. **M2-7 closes that gap:** `ac4-egress.yml` now runs a **real OS-level outbound DENY on all three platforms**
   and, on macOS + Windows, runs the **real, shipped `whisper-cli`** on a fixture WAV+model **under the deny** and
   asserts it **still transcribes** (JFK's sample) — proof the on-device transcription subprocess **needs, and makes,
   zero egress**:
   - **Linux** — `iptables`/`ip6tables` default-DROP `OUTPUT` (loopback only), driving the main/worker/subprocess
     positive controls at a routable target (unchanged).
   - **macOS** — a kernel **Seatbelt** sandbox (`sandbox-exec -f tests/ac4/macos-deny.sb`, `(deny network*)`) wraps the
     whole process tree; a routable probe is asserted blocked, then the real `whisper-cli` transcribes with all network
     denied. `sandbox-exec` needs no sudo/firewall service, so it runs reliably on hosted runners.
   - **Windows** — a **program-scoped** Windows Firewall outbound-**Block** on exactly the test `node.exe` **and**
     `whisper-cli.exe` (never a global block, which would sever the runner's own control channel); the rules are
     asserted present + effective, then the real `whisper-cli` transcribes with all network denied.
   **Residual gap (honest, for cofounder sign-off):** this OS layer denies **all** egress, not
   "**all-but-the-pinned-model-host**." macOS Seatbelt's `remote ip` filter accepts only `*`/`localhost` (never an
   arbitrary remote host), and a global Windows outbound-block would cut the runner itself — so the **only-permitted-GET**
   model-download assertion is **NOT** made at the macOS/Windows OS layer. It remains proven by the **`webRequest`
   exact-URL allowlist** (`network-guard` unit tests, Decision 6d) **+** the **Linux deny-all backstop**. **AC-17** is
   therefore satisfied on both halves: the static/packaging guarantee (provable already) **+** the runtime OS-deny
   assertion (now delivered on all three platforms against the real binary), with the only-pinned-host carve-out scoped
   at the allowlist layer rather than the per-process OS sandbox.
   **(d) Harness change this revision forces (🚨 HUMAN-REQUIRED):** because the model fetch is now a *permitted*
   egress, the AC-4 harness must move from "**deny all**" to "**deny all except a data-free `GET` to the exact pinned
   model URL(s)**" — but **at the right layer**. Concretely:
   - **`network-guard.ts`'s `webRequest` policy** gains the **single exact-URL allowlist entry** (method `GET` +
     pinned URL(s) + empty body, plus the redirect/CDN targets of Decision 6a/6d), since the `session.webRequest`
     layer is where the `net.request` download is actually observable. A dedicated `network-guard` unit test asserts
     the entry matches the exact URL/method/empty-body and **rejects a host-only `POST`**.
   - The **in-process Node spies** (`tests/ac4/egress-spies.ts` / `tests/ac4/no-egress.node.test.ts`) **stay
     deny-all** — they assert **zero Node-primitive outbound** (`net`/`dgram`/`dns`/`http`); they do **not** (and
     cannot) observe the Chromium-stack download, so they must **not** be loosened to "allow one host."
   - **`.github/workflows/ac4-egress.yml`** (the OS-deny firewall) remains the kernel-level backstop that *would*
     catch the download's socket egress, exercised to confirm the permitted `GET` reaches only the pinned host and
     everything else still trips.
   Editing the egress policy + the AC-4 CI workflow is **harness-integrity → HUMAN-REQUIRED** (MISSION §9; §5 "any
   action that would add network egress → human-required"). The renderer **CSP is NOT** in this set (it stays
   `connect-src 'none'`). **This ADR is
   the gate artifact for the cofounder's final confirm of that exact host + checksum + allowlist mechanism before
   any of these files are touched.**
8. **Transcription is a net-new per-item queue, not a "verbatim reuse" of import.** We reuse the *seam* (the
   hardened `spawn`, the off-thread F3c coordinator/protocol), but per-media-item transcription **after** import is a
   **net-new design**: a `transcript_status` column + drain on `items`, **analogous to the existing `thumb_status`
   queue** (`electron/main/db/migrations/001_initial.sql`), since the import worker is one-job-per-import shaped.
   Crucially, the reused spawn seam **hard-caps each child at 30 s** (`FFPROBE_TIMEOUT_MS`/`FFMPEG_TIMEOUT_MS` in
   `electron/main/importers/deps/{ffprobe,thumbnail}.ts`) and the current cooperative cancel aborts **between
   records** (`electron/main/importers/workers/ingestion-job.ts`), **not** mid-file — neither fits multi-minute
   transcription. Long media therefore needs a **duration-scaled timeout (or chunking), partial/checkpoint output,
   and `whisper-cli` child-kill on cancel**, under concurrency limits (Metal ≈ serial; Windows CPU few cores). → **AC-20**.
9. **User control / consent over transcription — opt-in (LOCKED by the cofounder).** Turning a deceased loved one's
   voice into stored, searchable text is a privacy-sensitive act, so transcription **runs only after an explicit
   user opt-in**: a clear first-run/global toggle (and ideally per-item control), and **nothing auto-transcribes
   silently**. The earlier "opt-in vs automatic-with-toggle" question is **resolved: opt-in** (no silent/automatic
   transcription). The **same opt-in also gates the model download** — no opt-in ⇒ no model fetch ⇒ no network
   (Decision 6c). → **AC-22** (consent) **+ AC-24** (the download it gates).
10. **Attribution / NOTICES for third-party artifacts (bundled *and* downloaded).** Shipping the `whisper-cli`
    binary (whisper.cpp, **MIT**) requires bundled license attribution/NOTICES; the `small` `ggml` **weights**
    (derived from OpenAI Whisper, **MIT**) — now a **downloaded** artifact rather than a bundled one — **still
    require the same license/attribution NOTICES**, with the weights' provenance (upstream repo + file + version +
    size + the pinned SHA-256) recorded for the artifact the app fetches. → **AC-23**; surfaced in M2-1.

**Binary provenance & integrity** *(first-class, not a footnote — unchanged by the model-download pivot)*
**The `whisper-cli` binary stays bundled** in the installer regardless of the model pivot; only the *model* is
downloaded. (The model's own integrity — hard-coded SHA-256, verify-before-use, atomic + resumable install — is
**Decision 6b**, a separate story from the binary's.) The plan needs a **per-arch prebuilt `whisper-cli`** (macOS
arm64 + x64 with Metal, Windows x64). How that binary is produced is a supply-chain decision with two viable
postures, both within MISSION §5's **agent egress allowlist** (GitHub + npm registry); the cofounder's "binary stays
bundled, **built from source in CI**" framing **favors P1**:
- **(P1) Build whisper.cpp from source in CI per arch.** Maximal provenance (we compile from pinned source, no
  third-party binary trust), and consistent with `electron-builder.yml`'s `buildDependenciesFromSource: true` for
  `better-sqlite3`. **Cost:** reintroduces the *exact* toolchain-fragility risk we cited to reject `nodejs-whisper`
  (CMake/compiler per runner, plus the **macOS Metal SDK**), now in our own packaging pipeline.
- **(P2) Download a pinned, checksum-verified upstream prebuilt** (`ggml-org/whisper.cpp` release asset) at build
  time, verifying a pinned SHA-256. **Cost:** third-party **supply-chain trust** in the upstream binary — unlike
  `better-sqlite3`, which we rebuild from source — mitigated but not eliminated by checksum pinning.
- **Reconciling the `nodejs-whisper` rejection:** we rejected `nodejs-whisper` partly for "compiles from source at
  `npm install`." **P1 reintroduces that risk** (just moved into our CI); **P2 avoids it** but takes on binary-trust.
  So the rejection of `nodejs-whisper` rested mainly on its **bundled auto-download/egress path**, *not* on
  build-from-source per se — this ADR makes that explicit rather than leaving the inconsistency implicit.
- **Signing/notarization:** Kawsay ships **unsigned** v1 (ADR-0025). A spawned, **unsigned** third-party native
  binary risks **macOS Gatekeeper** quarantine and **Windows SmartScreen/Defender** friction (and, once signing
  lands, the binary must be covered by notarization/hardened-runtime). This interacts with the provenance choice and
  is called out for the cofounder, not silently assumed away.

**Alternatives considered**
- **In-process N-API addon (`smart-whisper`, or a thin custom addon over `libwhisper`)** — lower latency, no
  subprocess to manage, rebuilt for Electron's ABI exactly like `better-sqlite3`. **Rejected for v1** because: (a)
  **ABI/prebuild fragility** — the addon must be rebuilt (or a matching prebuild downloaded) for every Electron
  major bump, and prebuild coverage for Electron ABIs is unreliable; (b) **thinner maintenance** than whisper.cpp
  itself; (c) **weaker crash-isolation** — a native segfault on a malformed/adversarial audio file would crash the
  worker (and risk the main process), whereas a **subprocess** fault is a typed, contained failure (better AC-15
  resilience). Revisit for performance once the subprocess baseline ships.
- **`nodejs-whisper` (CLI wrapper, MIT, v0.3.0)** — ergonomic and CLI-based like our choice, but **rejected**
  **primarily** because it ships an **implicit, uncontrolled model auto-download** path (`npx nodejs-whisper
  download`, `autoDownloadModelName`) wired **right onto the transcription path**, and it **compiles whisper.cpp
  from source at `npm install`**. *(Reconciling with our own opt-in download: the objection was never "a model is
  fetched" — it was an **unpinned, unverified, non-consensual fetch living next to the privacy boundary**. Our
  design is the **opposite on every axis**: a **single pinned URL (method + exact-URL allowlisted)**, a **hard-coded
  SHA-256 verified before use**, **explicit opt-in**, **data-free**, in a **single-purpose main-process downloader
  (Electron `net.request` over the guarded session)** the transcription path never
  touches. Choosing an opt-in download here is therefore **consistent** with rejecting `nodejs-whisper`, not in
  tension with it — and build-from-source is not disqualifying per se, see **Binary provenance & integrity** P1.)*
- **Vosk (Kaldi, Apache-2.0)** — genuinely offline, small models (Spanish small ~48 MB, large ~833 MB), mature
  Node binding. **Rejected** because real-world accuracy on **accented/noisy WhatsApp voice notes** and
  multilingual breadth are materially below Whisper; grief-critical, one-shot memories warrant the better model
  even at a larger footprint.
- **Coqui STT (MPL-2.0)** — **rejected**: the project and company were **archived/shut down in 2024**; unmaintained
  is a non-starter for a shipped, security-scanned app.
- **faster-whisper (CTranslate2, Python)** — fast, but **rejected**: it requires a **bundled Python runtime**;
  Kawsay ships no Python, and embedding one is heavy, fragile to package across macOS+Windows, and contrary to the
  established "spawn a bundled native binary" pattern (ADR-0012).
- **Cloud STT (OpenAI / Google / AWS Transcribe)** — **rejected outright**: network egress that **breaks AC-4** and
  sends a deceased person's voice off-device — squarely on the MISSION §5 / AGENTS.md **NEVER** list.
- **Bundle the `small` model in the installer (this ADR's *own* prior stance)** — **rejected by the cofounder:**
  *"is going to become a huge app to download and install"* (a ~670 MB installer with `small` bundled, +233% on the
  ~200 MB base). It also makes every user — including those who never opt into transcription — carry ~466 MiB they
  may never use. **Superseded within this ADR** by the opt-in download (Decision 6).
- **Manual user import of the model file (option *c*)** — **rejected by the cofounder:** too much friction for a
  **grieving, non-technical** user (find the right `.bin`, the right version, place it correctly), and error-prone
  with **no integrity guarantee** (wrong / corrupt / tampered file). The cofounder explicitly chose **option (b)
  "App auto-downloads on opt-in — smooth UX, one audited egress"** over this.
- **Opt-in, on-demand model download (the chosen approach)** — *formerly rejected here, now adopted* after the
  cofounder weighed it against bundling and manual import. It **is** egress, so it stays **human-required**; but it
  is **data-free, opt-in, single-pinned-host, checksum-verified**, and **does not break the offline promise for user
  memories** (which never leave — Decision 7). Cloud STT remains rejected because it would send the **user's voice**
  off-device — the line this design never crosses.

**Consequences**
- **Installer size is UNCHANGED (~200 MB):** the model is **no longer bundled**, so the prior +71%/+233% installer
  jump is **gone**. The "too heavy?" answer becomes: the installer stays light, and the model is a **one-time,
  opt-in ~466 MiB (≈488 MB on disk) download** to the app's data dir — borne only by users who turn transcription
  on. The compact `whisper-cli` binary remains bundled.
- **New platform-specific build artifact** — the **per-arch `whisper-cli` binary** (macOS arm64/x64, Windows x64),
  built from source in CI → a larger CI build/sign/notarize surface (signing still deferred per ADR-0025) and the
  **human-required** sign-off this ADR flags. The **model is not a build artifact** anymore — it is a pinned,
  checksum-verified Release asset fetched at runtime. Apple **Core ML** acceleration, if adopted later, adds an
  Apple-only encoder artifact (revisit).
- **A new product-runtime egress + harness change:** the §5 *product* network allowlist goes from **"None — fully
  offline"** to **exactly one** pinned, data-free model **GET** (one origin **+ its redirect/CDN target** —
  `{github.com, release-assets.githubusercontent.com}`, or HF `{huggingface.co, *.cdn.hf.co}`); the `network-guard`
  `webRequest` allowlist + the AC-4 harness (`ac4-egress.yml` OS firewall; the in-process Node spies stay deny-all;
  a `network-guard.test.ts` exact-URL assertion) move from **deny-all** to
  **deny-all-but-the-exact-pinned-GET** → **🚨 HUMAN-REQUIRED** (harness integrity). User memories remain absolutely
  non-egressing and CI-enforced.
- **AC-4 is preserved in spirit and *narrowed* in letter:** zero **user-data** egress stays absolute and
  CI-enforced (memories never leave); the one permitted outbound is the opt-in, checksum-verified model fetch.
  AC-4 is now **bound by AC-17** (whose **runtime** half is **delivered by the net-new OS-deny harness, M2-7** — a real
  OS-level deny on Linux + macOS + Windows exercising the real `whisper-cli`, with the only-pinned-host carve-out scoped
  at the `webRequest` allowlist; the static/packaging half provable already) and the new **AC-24** (download
  integrity/resilience). The off-thread
  guarantee (AC-9) extends to **AC-18**; audio/video become first-class **searchable** via **AC-19** (MISSION §4's
  top candidate realized); resilience + **long-media** by **AC-20**; multilingual accuracy by **AC-21**; **user
  consent/opt-in** by **AC-22**; **license attribution/NOTICES** by **AC-23** (PRD addendum).
- **Transcription is a net-new per-item queue** (a `transcript_status` drain analogous to `thumb_status`), **not** a
  verbatim reuse of the import worker: long-media needs duration-scaled timeout/chunking, partial/checkpoint, and
  `whisper-cli` child-kill on cancel (the reused spawn seam caps children at 30 s and cancels between records only).
- **A DB migration** (transcript storage) is required → **HUMAN-REQUIRED** per AGENTS.md, sequenced behind the
  engine/packaging work.
- **Accuracy is model-bound and falsifiable:** with **`small` locked**, AC-21 sets a measurable WER ceiling on a
  labelled offline fixture set (no telemetry); M2-0 now **validates `small`** on real Spanish samples and locks the
  threshold, rather than choosing `base`↔`small`.
- **Performance:** short voice notes transcribe comfortably; on Apple Silicon whisper.cpp runs on the GPU (Metal)
  multiples faster than realtime, and on Windows CPU `small` runs near-to-slightly-slower than realtime — and
  because it runs **off-thread in the background after import**, even slower-than-realtime inference never blocks
  the UI.

**Decisions LOCKED by @pedrofuentes (this revision)**
1. **Model = `small`** (~466 MiB), multilingual — the `base`-vs-`small` question is closed.
2. **Policy = opt-in** — no silent/automatic transcription; the same opt-in gates the model download.
3. **Delivery = the app auto-downloads the model on opt-in** (option *b*) — **not** bundled (rejected as too big),
   not manual import (rejected as too much friction). The `whisper-cli` binary stays bundled.

**Final confirm still required from @pedrofuentes before any building (this ADR is that gate artifact)**
1. **The exact pinned host set + URL** — recommended: Kawsay's own GitHub Release asset
   (`…/releases/download/models-v1/ggml-small.bin`) re-hosting upstream `ggerganov/whisper.cpp`, which
   **302-redirects to `release-assets.githubusercontent.com`** → allowlist host set **`{github.com,
   release-assets.githubusercontent.com}`** (the stale `objects.githubusercontent.com` is corrected) — vs fetching
   Hugging Face directly (`{huggingface.co, *.cdn.hf.co}`).
2. **The hard-coded SHA-256** — `1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b` (487,601,967
   bytes), pinned in the app and verified before first use (and re-validated before each `whisper-cli` spawn,
   Decision 6b).
3. **The scoped-allowlist mechanism** — the single `network-guard` **`webRequest`** allowlist entry (**method `GET`
   + the exact pinned URL(s) + empty body**, via **Electron `net.request` on the guarded session** — *not* a Node
   downloader, *not* a host-only match) **+** the matching AC-4 harness edits (the OS-deny firewall in
   `ac4-egress.yml`; the Node spies stay deny-all and do **not** observe this download) → **🚨 HUMAN-REQUIRED**
   (egress policy + harness integrity).
4. **The model-asset publication pre-step** (Decision 6e) — that a `models-v1` Release asset is **published and
   publish-time `hash == pinned`-checked** *before* the downloader increment, since nothing publishes
   `ggml-small.bin` today.
5. **Heavy-dependency / unsigned-binary posture** — accept a per-arch built-in-CI **unsigned** `whisper-cli` binary
   whose macOS/Windows runtime zero-egress is now **proven by the net-new OS-firewall harness (M2-7)** — the real
   binary transcribes under a kernel deny on each platform — with the only-pinned-host carve-out scoped at the
   `webRequest` allowlist (documented residual gap), not just by-construction.

**Remaining open items for the red-team / build:** the exact Release tag + asset URL to pin (and whether to re-host
vs fetch Hugging Face directly); the **model-asset publication** workflow + its publish-time `hash == pinned` gate
(Decision 6e); **redirect-following + signed-URL-expiry-vs-resume** mechanics (Decision 6a); resumable-download +
offline-retry mechanics and the consent-screen copy; transcript
schema detail (`search_meta` feed vs a dedicated FTS-synced column, with the `items_fts` rebuild cost); whether to
also bundle the Core ML encoder for Apple Silicon; binary provenance mechanics (P1 build-from-source-in-CI vs P2
pinned-checksum download); long-media chunking vs duration-scaled timeout.

---

### ADR-0026: Release pipeline — GitHub Actions workflow publishing unsigned v1 installers to GitHub Releases
**Date**: 2026-06-25
**Status**: Accepted (implements ADR-0007; complements ADR-0023/0024/0025)
**Tier**: human-required for each production publish — the workflow's publish job runs in a protected GitHub
Environment with required reviewers (@pedrofuentes), so a release blocks until approved (MISSION §9; PRD
AC-5). Authoring the workflow is reversible config (`auto-with-audit`); this ADR is the audit note. The
pipeline performs **no code-signing** and adds **no runtime network egress** — no auto-updater/feed is
bundled (ADR-0023), so AC-4 is untouched.

**Context**
ADR-0007 chose `electron-builder` → GitHub Releases and named the publish contract (`provider: github`,
`--publish always`, `GH_TOKEN`, protected Environment). Card P1 (ADR-0023) made `pnpm dist` build and launch
the installers locally while keeping the automated build **non-publishing** (`--publish never`). What
remained was the CI surface that turns a pushed release tag into published GitHub Release assets — the
`.github/workflows/release.yml` already referenced by ARCHITECTURE §1/§8 but not yet written. The cofounder
approved publishing **v0.1.0 UNSIGNED** (gate #120; ADR-0025).

**Decision**
Add `.github/workflows/release.yml`:
1. **Triggers**: push of a `v*` tag (e.g. `v0.1.0`) plus manual `workflow_dispatch` (electron-builder derives
   the release tag from `package.json` `version` when dispatched without a git tag).
2. **Matrix**: `macos-latest` + `windows-latest` — matching `ci.yml` and the P1-verified single-runner
   cross-build (one Apple Silicon `macos-latest` produces both the arm64 build and the x64 from-source
   cross-build; ADR-0023). Each runner reuses CI's exact pinned toolchain (Node 22 + the pinned pnpm/Node
   setup, `pnpm install --frozen-lockfile`, `pnpm build`), then `electron-builder --publish always`.
3. **Native module**: electron-builder's own `npmRebuild`/`buildDependenciesFromSource` rebuilds
   `better-sqlite3` for Electron's ABI at package time (ADR-0023); `actions/setup-python` pins **Python 3.11**
   because node-gyp needs distutils (removed in 3.12; ADR-0007/ARCHITECTURE §8).
4. **Publish**: electron-builder's native GitHub provider (the `publish:` block already in
   `electron-builder.yml`) creates the Release for the tag and uploads the `.dmg`/`.zip`/`.exe` assets,
   authenticated with the repo-scoped `GITHUB_TOKEN` (`GH_TOKEN`). `--publish always` lives **only** in the
   workflow — `package.json`'s `dist*` scripts stay `--publish never`, preserving ADR-0023's structural
   "a local/automated build can never publish a release" guarantee (and the `dist` `--publish never`
   assertion in `tests/unit/packaging-config.test.ts`).
5. **Unsigned (ADR-0025)**: `CSC_IDENTITY_AUTO_DISCOVERY: false` so electron-builder produces unsigned
   artifacts instead of failing while trying to discover a macOS signing identity. No certs/secrets are
   added; code-signing + notarization (and re-enabling the asar-integrity fuse) remain the deferred human
   step.
6. **Least privilege + human gate**: top-level `permissions: contents: read`; the publish job widens to
   `contents: write` only (create the release + upload assets) and runs in the protected `release`
   Environment, so the first production publish blocks on the required reviewer. `concurrency` with
   `cancel-in-progress: false` never interrupts an in-flight release.
7. **Supply chain**: every `uses:` is pinned to a full 40-char commit SHA with a `# vX.Y.Z` comment, reusing
   `ci.yml`'s SHAs for the shared actions (checkout, pnpm/action-setup, setup-node).

**Alternatives considered**
- *Build per-OS, then a separate job publishes via `softprops/action-gh-release`* — viable and marginally
  more least-privilege (build legs need no write token), but adds three more third-party actions to pin
  (upload-/download-artifact + the release action) and diverges from ADR-0007's `--publish always` contract
  and the already-wired `electron-builder.yml` `publish` block. electron-builder's native multi-OS publish is
  simpler and is the documented decision.
- *Per-arch macOS runners (`macos-14` arm64 + `macos-13` x64) as ADR-0007 first sketched* — unnecessary: P1
  verified one `macos-latest` runner builds both arches (x64 native compiled from source), and a single
  runner matches `ci.yml`.
- *Add a `release`/`publish` npm script carrying `--publish always`* — rejected: it would place a publishing
  command in `package.json` that a developer could run locally, weakening ADR-0023's structural guarantee and
  tripping the packaging-config test that asserts `dist` is `--publish never`. The `always` flag is confined
  to the gated workflow.
- *Sign/notarize in v1* — rejected per ADR-0025 / gate #120 (approved to ship unsigned); signing is the
  deferred human step.

**Consequences**
- ✅ Pushing `v0.1.0` (after the coordinator tags) builds and publishes the macOS + Windows installers to a
  GitHub Release, satisfying AC-5's build-and-publish, with the first publish held for human approval.
- ✅ Unsigned artifacts build cleanly (no signing attempt); zero new runtime dependencies, certs, or secrets.
- ✅ Minimal token scope; publishing cannot happen from a local/automated `pnpm dist`.
- ⚠️ Both matrix legs publish to the same tagged Release; electron-builder dedupes by tag (find-or-create),
  and `concurrency` + the one-time human approval keep this controlled. If a future release needs strict
  single-writer publishing, switch to the build-artifacts-then-one-publish-job shape above.
- ⚠️ The Windows runner compiles `better-sqlite3` from source for the Electron ABI; if a runner-image
  toolchain regression (cf. node-gyp vs. Visual Studio, LEARNINGS 2026-06-24) breaks that compile, pin the
  build tools/prebuilt path in this workflow — a release-time check, not a blocker for the unsigned v1.

---

### ADR-0025: Defer enableEmbeddedAsarIntegrityValidation to the signed build
**Date**: 2026-06-24
**Status**: Accepted (refines ADR-0007; v1 exception to ARCHITECTURE §2.5)
**Tier**: auto-with-audit (adjusts the declared security posture for the *unsigned* v1 build). This ADR is
the audit note.

**Context**
`electron/fuses/fuses.ts` `FUSE_CONFIG` declares `enableEmbeddedAsarIntegrityValidation: true` as the
target packaged-app posture. On macOS this fuse **requires code signing**: the asar-integrity hash lives in
`Info.plist` and is only trusted under a valid signature. On the unsigned v1 build (`mac.identity: null`;
signing is a deferred human-required step — ADR-0007), enabling it makes Chromium refuse to load the
renderer from the asar — the packaged app starts but the window is blank with
`Failed to load URL … app.asar/out/renderer/index.html (ERR_FILE_NOT_FOUND)`. This is the documented
Electron behaviour for unsigned builds.

**Decision**
The unsigned v1 build flips every declared fuse **except** `enableEmbeddedAsarIntegrityValidation`, which is
set `false` in `electron-builder.yml`. `FUSE_CONFIG` keeps `true` as the signed-production target, and the
drift guard in `tests/unit/packaging-config.test.ts` encodes the exception (all other fuses lock-step;
integrity asserted `false` for v1 against the `true` FUSE_CONFIG target). The cofounder re-enables it in
`electron-builder.yml` together with Developer ID signing + notarization (see the release checklist).

**Alternatives considered**
- *Keep it `true` and ship v1* — rejected: produces a blank-window app on every unsigned build (including CI
  smoke builds and any pre-signing testing), verified locally.
- *Change FUSE_CONFIG to `false`* — rejected: FUSE_CONFIG is the declared *signed-production* target;
  flipping it there would lose the intent and the cofounder's re-enable signal. The deviation belongs in the
  v1 build config, documented and test-pinned.
- *Ad-hoc sign the whole app to satisfy integrity* — rejected: `resetAdHocDarwinSignature` only re-signs the
  fuse-modified binary; a meaningful integrity guarantee needs the real Developer ID signature, which is the
  deferred human step anyway.

**Consequences**
- ✅ The unsigned v1 dmg/zip launches and loads the renderer (verified) while keeping all other hardening
  fuses active (no Node escape hatches, asar-only loading, hardened `file://`, encrypted cookies).
- ⚠️ asar tamper-evidence is not active until signing is configured; re-enabling it is a checklist item on
  the human-required first-publish gate.

---

### ADR-0024: Bump better-sqlite3 12.9.0 → 12.11.1 for Electron 42 native compatibility
**Date**: 2026-06-24
**Status**: Accepted (enables ADR-0007 / card P1, AC-5)
**Tier**: auto-with-audit (the one dependency change in P1). This ADR is the audit note.

**Context**
Card P1 rebuilds `better-sqlite3` from source for Electron 42's ABI at package time. The pinned `12.9.0`
fails to compile against Electron 42's V8 (13.x): `v8::External::New` now takes a required `tag` argument
and `Object::SetNativeDataProperty` is an ambiguous overload. The Node-ABI binary used by Vitest is a
downloaded *prebuilt*, so the source never compiled locally and the break only surfaces at package time —
`pnpm dist` (and the same rebuild on CI) cannot produce a loadable native module. better-sqlite3 shipped the
fixes after 12.9.0: 12.10.1 "Fix V8 external API usage for Electron 42" and 12.11.1 "Fix Electron v42 build
errors on Windows".

**Decision**
Bump the exact-pinned `better-sqlite3` to `12.11.1` (same major). 12.11.1 (not 12.10.1) is required because
AC-5 also ships a Windows `.exe`, and the Windows Electron-42 build fix only landed in 12.11.1. The exact
pin (no caret) is preserved — native-module ABI builds must stay deterministic.

**Alternatives considered**
- *Keep 12.9.0 and use prebuilt Electron binaries instead of a source build* — rejected: 12.9.0 predates
  Electron 42 so publishes no Electron-42 prebuilt, and ADR-0007 deliberately builds native deps from source
  (`buildDependenciesFromSource: true`) for reproducibility.
- *Bump only to 12.10.1* — rejected: fixes macOS/general V8 but not the Windows Electron-42 build, and AC-5
  needs both installers.
- *Stay on 12.9.0 / downgrade Electron* — rejected: leaves AC-5 unsatisfiable.

**Consequences**
- ✅ `better-sqlite3` compiles for Electron 42 on macOS (arm64 + x64, both verified) and is configured for
  the Windows runner; the packaged app loads it at startup (verified by launch).
- ✅ Same major version; the full test suite (which loads the real module on the Node ABI) stays green.
- ⚠️ A regression-floor test (`tests/unit/packaging-config.test.ts`) pins `better-sqlite3 ≥ 12.11.1`, because
  the Node-ABI prebuilt hides Electron-ABI compile breaks from the ordinary test run — a downgrade would
  otherwise only fail at package time.
- ⚠️ 12.11.1 (like all ≥ 12.10.1) ships **no Node-20 prebuilt** (only `node-v127`/`v137`/`v141`/`v147` =
  Node 22/24/25/…). The `ci.yml` Verify job now pins **Node 22**, so Windows CI picks up the `node-v127` prebuilt rather than compiling native code from source on the runner;
  see LEARNINGS 2026-06-24.
- Called out for review per the card's "only electron-builder" constraint: this is a required compatibility
  bump of an existing runtime dependency, not a new package.

---

### ADR-0023: Packaging finalization (card P1) — fuse-flip mechanism, non-publishing auto-builds, ABI ordering
**Date**: 2026-06-24
**Status**: Accepted (refines ADR-0007)
**Tier**: auto-with-audit. No new *package* is added (electron-builder + @electron/rebuild already present);
the one dependency change is a patch-level bump of the existing `better-sqlite3` for Electron-42 native
compatibility (ADR-0024). Every choice here is reversible config + dev assets, and the local-only runtime
(ADR-0008, AC-4) is untouched. This ADR is the audit note.

**Context**
ADR-0007 chose `electron-builder` → GitHub Releases and named the *what* (dmg+zip / nsis, asarUnpack the
native modules, flip `@electron/fuses` + ASAR integrity, unsigned v1, human-required publish). Card P1
turns that skeleton into a `pnpm dist` that actually builds and launches, which forced several concrete
*how* decisions ADR-0007 left open.

**Decision**
1. **Flip fuses via electron-builder's native `electronFuses` config**, not a custom `afterPack` hook.
   electron-builder 26 flips `@electron/fuses` (its own bundled copy, via `dynamicImport`) "right before
   signing" and re-applies the macOS ad-hoc signature when `resetAdHocDarwinSignature: true`. The
   `electronFuses` block mirrors `electron/fuses/fuses.ts` `FUSE_CONFIG` and is kept in lock-step by
   `tests/unit/packaging-config.test.ts`. **`resetAdHocDarwinSignature: true` is mandatory**: flipping a
   fuse rewrites the binary and invalidates its signature, and Apple Silicon refuses to launch a binary
   with a broken signature — without the re-sign the *unsigned* v1 build would not start on arm64. Net:
   **zero new packages** (no direct `@electron/fuses`, no hook module). One fuse is the exception —
   `enableEmbeddedAsarIntegrityValidation` is deferred on the unsigned v1 build (ADR-0025).
2. **The automated/local build never publishes.** `dist`/`dist:mac`/`dist:win` pass `--publish never`, so
   a developer or CI build can never upload a GitHub Release. The `publish: github` block exists *only* for
   the human-gated release workflow (protected GitHub Environment, @pedrofuentes approval). This makes the
   "first production publish is HUMAN-REQUIRED" gate (ADR-0007, PRD AC-5) structural, not procedural. No
   `electron-updater`/`autoUpdater` is bundled, so the publish provider introduces no runtime network feed
   and the zero-egress guarantee (AC-4) is untouched.
3. **`pnpm dist` rebuilds the native module via electron-builder's own `npmRebuild`, not a pre-step.** The
   skeleton chained `pnpm rebuild:native` (the standalone `@electron/rebuild` 3.7.2 CLI) before the build;
   that is dropped from `dist`/`dist:mac`/`dist:win` because electron-builder already rebuilds
   `better-sqlite3` from source for Electron's ABI during packaging, and the standalone CLI additionally
   mis-resolves the module out of a nested git worktree (see LEARNINGS). The `rebuild:native` script is kept
   for switching a dev checkout to the Electron ABI by hand. Ordering still matters: tests run on Node's
   ABI, `pnpm dist` leaves `better-sqlite3` on Electron's ABI, so `pnpm dist` runs *after* the test gate and
   `pnpm rebuild better-sqlite3` restores the Node ABI for subsequent `pnpm test` runs (see LEARNINGS).
4. **Placeholder MIT icons** (`resources/icon.icns/.ico/.png`) are generated dependency-free and
   auto-discovered via `buildResources`; replacing them with final brand art is a later visual task.

**Alternatives considered**
- *Custom `afterPack` hook + direct `@electron/fuses` devDependency* — rejected: more code, a new dep, and
  it would have to re-implement the ad-hoc re-sign that electron-builder already does correctly.
- *Keep `publish: github` active for `pnpm dist` (rely on the absence of a tag to avoid publishing)* —
  rejected: `--publish never` is explicit and cannot be defeated by CI env heuristics.
- *Ship `enableEmbeddedAsarIntegrityValidation` active in v1* — rejected: macOS asar-integrity validation
  requires code signing, so on the unsigned v1 build the renderer fails to load from the asar
  (ERR_FILE_NOT_FOUND). It is deferred to the signing step (ADR-0025).

**Consequences**
- ✅ `pnpm dist` builds the macOS dmg/zip (arm64 + x64) locally with the native catalog engine loading under
  Electron's ABI and the hardening fuses active — verified by launching the packaged app (the renderer and
  the eagerly-loaded `better-sqlite3` 12.11.1 both come up clean).
- ✅ The only dependency change is the `better-sqlite3` patch bump (ADR-0024); no new package is added.
- ✅ An automated build cannot publish a release; publishing remains a deliberate human act.
- ⚠️ Running `pnpm test` immediately after `pnpm dist` fails until `pnpm rebuild better-sqlite3` restores
  the Node ABI — documented in LEARNINGS and handled by ordering in the release workflow.
- ⚠️ Windows `.exe` cannot be cross-built on macOS (native module + NSIS); it is produced on the Windows CI
  runner. The config is verified correct; the artifact itself is built/smoke-launched on `windows-latest`.

---

### ADR-0022: Thumbnails travel as bounded `data:` URLs over a zod-validated `catalog:thumbnail` IPC channel
**Date**: 2026-06-25
**Status**: Accepted
**Tier**: auto-with-audit. The change adds **no dependency** (Electron's `nativeImage` is built in; the
ffmpeg wrapper already ships), opens **no network or external origin**, requires **no CSP change**, and
preserves the local-only runtime (ADR-0008, AC-4) and the path-confinement boundary (ADR-0008/AC-14); this
ADR is the required audit note.

**Context**
The timeline and search (U1–U3) render every memory as a generic media-type **icon** because the
renderer-facing `ItemCardDTO` is a sanitised projection that deliberately exposes **no filesystem path and
no asset URL** — the renderer cannot (and must not) reach for original bytes. But the product's emotional
core (AC-6) is *seeing* a loved one's photos and videos. Card U4 (#102) must show **real thumbnails** while
keeping three invariants intact: **zero network egress** (AC-4), **path confinement** (a renderer must
never name a file, and an escaping content-address must be refused), and **no new heavy/native dependency**
(an image library such as `sharp` would be HUMAN-REQUIRED).

**Decision**
Add one channel to the IPC contract: **`catalog:thumbnail`**, request `{ id: uuid, size?: 16–320 }`,
response a **bounded image `data:` URL or `null`**. The renderer passes **only the opaque catalog id**; the
main process does everything privileged:
1. look up the item's `media_type` — non-visual types (audio/document/message) short-circuit to `null`
   without touching disk;
2. resolve the original through the existing **`resolveOriginal`** confinement boundary, which **throws**
   on a malformed/escaping content-address rather than reading outside the originals store;
3. render a small thumbnail via an **injected** thumbnailer — Electron's built-in **`nativeImage`** for
   photos (downscale-only, longest edge ≤ the clamped size, re-encoded JPEG) and the **existing ffmpeg
   wrapper** for videos (one frame, `-protocol_whitelist file`, piped to `pipe:1` in memory) — so the
   service module itself stays free of Electron/ffmpeg and is fully unit-tested by dependency injection;
4. **cap the bytes** (≤512 KiB), base64 it into a `data:` URL whose schema admits only
   `image/{jpeg,png,webp}`, and memoise it in a small **LRU** so a scrolled-back tile never re-renders.

The DTO gains a single boolean **`hasThumbnail`** hint (photo/video) — *not* a path — so the UI knows which
memories are worth fetching. The renderer sets `<img src={dataUrl}>` lazily and falls back to the
media-type icon on loading/error/non-visual. Because the bytes ride **inline as a `data:` URL**, the
existing CSP already permits them (`img-src 'self' data:`) and **`connect-src 'none'` is untouched — the
CSP delta is exactly zero**.

**Alternatives considered**
- **A custom `kawsay-thumb://` protocol** serving confined thumbnails by id (registered main-side). Workable
  and arguably more efficient for very large libraries (the bytes stream outside the IPC channel), but it
  **adds a new scheme to the CSP `img-src`**, a new privileged surface to register/validate, and another
  place to get confinement wrong. The `data:`-URL/IPC route reuses the *already-validated* invoke path, needs
  **no CSP change**, and keeps the entire trust boundary in one schema. Chosen for the smaller security
  surface; the protocol remains a clean future optimisation if profiling demands it.
- **Adding a `thumbnailPath`/asset URL to `ItemCardDTO`.** Rejected outright: it would leak a filesystem path
  to the sandboxed renderer and reintroduce exactly the egress/traversal risk the DTO projection exists to
  prevent. The renderer gets a boolean hint and an opaque id, nothing more.
- **An image dependency (`sharp`, `jimp`, …).** Rejected. `sharp` is a heavy native module (HUMAN-REQUIRED per
  the kickoff), and `nativeImage` already ships with Electron and covers the common raster formats; videos
  reuse the ffmpeg wrapper we already depend on. **No new dependency** was needed.
- **Pre-generating thumbnails to disk at import time** (a `derived/thumbnails/` tree already exists for the
  importer's posters). Deferred: on-demand rendering with an in-memory LRU keeps U4 self-contained, avoids a
  migration/backfill for already-imported libraries, and never writes new files for a feature that is purely
  about *display*. The import-time generator and this on-demand service can converge later.

**Consequences**
- The renderer can finally *show* memories (AC-6) while the security posture is unchanged: **id-only in,
  bytes-only out**, all resolution + confinement main-side, **CSP delta zero**, **zero egress** (asserted by
  a unit egress-spy on the service path plus the existing AC-4 firewall test).
- Thumbnails are bounded (≤320 px, ≤512 KiB) and cached, so memory and CPU stay flat as the user scrolls.
- `nativeImage` decodes the common still formats but not every exotic codec; an undecodable original simply
  falls back to its icon (one bad file never breaks the view). If broader format/perf needs emerge, the
  `kawsay-thumb://` protocol and/or disk pre-generation above are the documented next steps.

---

### ADR-0021: `@vitest/coverage-v8` (dev-only) wires the ≥80% coverage gate the DoD already required
**Date**: 2026-06-24
**Status**: Accepted
**Tier**: auto-with-audit. The addition is a single **devDependency** — it ships in no production bundle,
opens no network or external origin, and leaves the local-only runtime (ADR-0008, AC-4) untouched; this
ADR is the required audit note.

**Context**
AGENTS.md (§Ratchet) and `docs/SENTINEL.md` (§Coverage, check 6) have always specified a **≥80%** coverage
bar as part of the Definition of Done, and `docs/TESTING-STRATEGY.md` documents `pnpm test --coverage` — but
no coverage **provider** was ever installed, so that command errored and the threshold was unenforceable
(SENTINEL treats an unset threshold as N/A, "do not invent"). Card #109 wires the measurement up so the bar
is real, reported, and regression-protected, with no other behaviour change.

**Decision**
Add the dev-only **`@vitest/coverage-v8`** (`^3.2.6`, pinned to the installed Vitest 3 major so the provider
and runner never skew) and a `coverage` block in `vitest.config.ts`: provider `v8`, reporters
`['text','html','json-summary']` (console table for humans, HTML for drill-down, `coverage-summary.json` for
a future CI/Sentinel parse), `include` scoped to the three shipped source roots (`electron/`, `shared/`,
`src/`), and `thresholds` of **80** on statements/branches/functions/lines. A `pnpm coverage` script runs it.
The only exclusions beyond the v8 defaults and ambient `**/*.d.ts` declarations are the four **process
entry/bootstrap glue** files that import Electron/DOM globals and wire singletons at module load, so they
cannot execute under vitest/jsdom: `electron/main/index.ts` (main entry), `electron/preload/index.ts`
(preload `contextBridge` bootstrap), `electron/main/importers/workers/ingestion-worker.ts` (`worker_threads`
entry), and `src/main.tsx` (React `createRoot` bootstrap). Every collaborator those four compose is
unit-tested in isolation. The generated `coverage/` report is git-, prettier-, and eslint-ignored.

Measured baseline across the existing 525-test suite (no gap-filling tests were needed): **statements 94.64%,
branches 84.35%, functions 95.57%, lines 94.64%** — already over 80 on every metric — so the threshold pins
the *existing* posture rather than chasing it.

**Alternatives considered**
- **`@vitest/coverage-istanbul`**: the other first-party provider, but it instruments source via Babel (slower,
  an extra transform on top of our esbuild pipeline) and reports the transpiled, not authored, shape less
  faithfully. `v8` is Vitest's default, uses the engine's native coverage with no instrumentation step, and is
  the lower-friction fit for an esbuild/jsx-automatic two-project setup. Istanbul's finer per-statement
  accounting buys nothing at this bar.
- **Standalone `c8` / `nyc`**: redundant — Vitest's `v8` provider *is* c8 under the hood, already integrated
  with the runner and the `node` + `renderer` projects, so a separate tool would only duplicate config.
- **Ratcheting the thresholds up to the achieved ~94/84/95/94**: rejected. The DoD contract is **80**; pinning
  at the achieved number makes unrelated future PRs brittle (a legitimate refactor that drops a few covered
  lines would red-line the gate). 80 is the hard floor; the AGENTS.md ratchet separately guards the achieved
  baseline against regression. The branch floor is held at 80 (achieved 84.35%) deliberately — branches is the
  metric most sensitive to defensive `if`/`??` paths, so a notch of headroom avoids flapping.
- **Excluding the type-only contracts (`types.ts`, `protocol.ts`, `shared/kawsay-api.ts`) or the worker
  composition root (`ingestion-context.ts`) to inflate the number**: rejected as coverage-gaming. They stay
  *in* the measurement; the suite clears 80 with them included, which keeps the number honest and conservative.
- **Adding the CI `coverage` gate in the same PR**: deferred. A `.github/workflows` change is harness-integrity
  (coordinator/cofounder-gated). This PR ships only the local tooling and proposes the CI step for later.

**Consequences**
- `pnpm coverage` now produces a text table, a browsable `coverage/` HTML report, and `coverage-summary.json`;
  the run **fails** if any of the four metrics drops below 80, turning the long-documented bar into an enforced
  gate that runs when `pnpm coverage` is invoked; the normal `pnpm test` inner loop remains the fast non-coverage Vitest run.
- Only true bootstrap glue is excluded; all testable logic (importers, catalog repo, ingest, IPC validation,
  hooks, security helpers, the worker job driver) remains measured, so the number reflects real behaviour.
- One small, well-known, dev-only package enters the lockfile; it never reaches production or the network,
  consistent with the dev-tooling tier of ADR-0020 (`axe-core`) and ADR-0017.
- A follow-up is needed to add the `coverage` step to CI branch protection so the gate is enforced on every PR,
  not only locally — called out in the #109 PR for the coordinator.

---

### ADR-0020: `axe-core` (dev-only) as the holistic accessibility assertion for AC-13
**Date**: 2026-06-24
**Status**: Accepted
**Tier**: auto-with-audit. The addition is a single **devDependency** — it ships in no production bundle,
opens no network or external origin, and leaves the local-only runtime (ADR-0008, AC-4) untouched; this
ADR is the required audit note.

**Context**
Card X2 is the cross-screen accessibility pass for **AC-13 (WCAG 2.1 AA)**. Prior cards verified each
screen in isolation (per-screen contrast, focus rings, role/label assertions). AC-13 itself is specified
"e2e (axe + Playwright)", but the full Electron e2e harness is not yet wired (`tests/e2e` is empty;
`playwright.config.ts` is a skeleton). A fast, TDD-friendly way was needed to assert **"no serious/critical
axe violations"** holistically — on every primary screen and state — inside the existing `pnpm test` inner
loop, so the AA posture is locked in and cannot silently regress as the UI grows.

**Decision**
Add the dev-only **`axe-core`** engine (pinned `4.12.1`) and a thin helper, `tests/renderer/support/axe.ts`,
that runs axe over a rendered Testing-Library container and fails on any **WCAG 2.1 A/AA** violation
(`runOnly` tags `wcag2a wcag2aa wcag21a wcag21aa`). The new `tests/renderer/accessibility.test.tsx` sweeps
the onboarding wizard (welcome → locate → import progress/complete) and every main view/state (timeline,
search, add-memories, settings) through this helper, alongside targeted assertions for the affordances axe
cannot see under jsdom (skip link, landmark uniqueness, placeholder contrast token, form-error association,
app-wide focus management).

**Alternatives considered**
- **`vitest-axe` / `jest-axe` wrappers**: the obvious ergonomic choice, but `vitest-axe@0.1.0` is stale and
  pulls extra transitive deps (`chalk`, `lodash-es`, `redent`, `aria-query`, `dom-accessibility-api`). This
  repo has a strong, documented pattern of taking the minimal, well-known core and hand-rolling the thin glue
  (ADR-0014 CSV, ADR-0015 router, the U2 debounce). `axe-core` **is** the engine inside both wrappers; adding
  only it keeps the lockfile to one ubiquitous package and the matcher to ~10 lines.
- **Playwright + `@axe-core/playwright` only**: the eventual AC-13 e2e home, but heavy and slow for a TDD
  inner loop and blocked on the not-yet-wired Electron e2e harness. axe-core under jsdom complements (does
  not replace) that future e2e pass.
- **Hand-written role/label assertions only**: already present per-screen; they do not give a single,
  comprehensive "no AA violations" guarantee across every screen, which is exactly AC-13's bar.

**Consequences**
- The renderer suite now fails on any WCAG 2.1 A/AA regression on any covered screen — a durable AC-13 ratchet.
- **jsdom caveat**: axe cannot compute colour-contrast without real layout/canvas, so it reports contrast as
  *incomplete*, never *violation*. Token-pair contrast therefore stays verified against the USER_FLOWS §6.1
  table and is asserted at the class/token level (e.g. the placeholder-contrast test). The future Playwright
  pass will add the real-pixel contrast check.
- **Pinned exact** (not `^`) on purpose: a minor axe bump can introduce new rules that turn a green suite red
  unexpectedly; the version is bumped deliberately, with the new rules reviewed.
- One small, well-known, dev-only package enters the lockfile; it never reaches production or the network.

---

### ADR-0017: Clear the dev-dependency CVEs via `pnpm.overrides` (patched `tar`/`esbuild`) + a Vite 5→6 bump
**Date**: 2026-06-24
**Status**: Accepted
**Tier**: auto-with-audit. Every package touched is a **devDependency or a build-time transitive** — none
ships in the production Electron bundle, opens a network/external origin, or alters the local-only runtime
(ADR-0008, AC-4); this is the audit note for the security fix (issue #31 — auto-tier, no milestone gate).

**Context**
Dependabot flagged 14 open alerts (**8 high + 6 medium**), **all `development`-scope**, that M1 DoD §4
requires cleared before sign-off (issue #31). None reaches the shipped bundle (it loads built static files +
the native better-sqlite3 binary; there is no dev server), so `pnpm audit --prod` was already clean — but the
alerts must still go:
- **vite** (2 high + 4 medium) — dev-server `server.fs.deny` bypass, optimized-deps `.map` path traversal,
  `launch-editor` NTLMv2 disclosure. Vulnerable range `<= 6.4.2`, **first patched `6.4.3` — no Vite-5
  backport exists**.
- **esbuild** (1 medium) — dev server accepts cross-site requests. Needs `>= 0.25.0`; pulled transitively by
  Vite (5.4 → 0.21.5).
- **tar** (6 high + 1 medium) — transitive of `@electron/rebuild@3.7.2` (the Node-20 pin) via
  `@electron/node-gyp`, used by `pnpm rebuild:native` to extract trusted, lockfile-pinned, integrity-verified
  Electron headers. Needs `>= 7.5.16`; `@electron/rebuild@3.7.2` declares `tar@^6`.

**Decision**
- Bump the direct **`vite`** devDependency `^5.4.21 → ^6.4.3` — the minimal patched version (`^6.4.3`
  resolves deterministically to `6.4.3`, the last 6.x). This is the Vite-major move ADR-0010 deferred to "its
  own ADR"; it does **not** disturb the pinned `electron-vite@^4` toolchain, whose peer range is
  `vite ^5 || ^6 || ^7` and which (with `@vitejs/plugin-react@^4`, `@tailwindcss/vite@^4`, `vitest@3`) already
  declares Vite-6 support. Vite 6 pulls `esbuild ^0.25.0`, which alone clears the esbuild advisory.
- Add **`pnpm.overrides`** forcing the two purely-transitive offenders to patched releases: `tar: ^7.5.16`
  and `esbuild: ^0.25.0`. tar 7.5.16 already coexists in-tree under electron-builder's
  `@electron/rebuild@4 → node-gyp@12`, and the electron node-gyp fork calls only the API stable across tar
  6→7 (`tar.extract({ file, strip, filter, onwarn, cwd })`), so the override is safe for the native rebuild;
  the esbuild pin is belt-and-suspenders so no path can reintroduce a pre-0.25 esbuild.

**Alternatives considered**
- **Bump `@electron/rebuild` 3.7.2 → 4.x for a natively-patched tar** (issue #31's stated fallback) —
  rejected as the primary fix: `@electron/rebuild@4` requires Node `>= 22.12`, forcing a raise of the
  `engines.node >= 20` baseline (ADR-0010's deliberate Node-20 pin). Held in reserve **only if** the tar
  override ever breaks the native rebuild.
- **Stay on Vite 5, override only esbuild/tar** — impossible: the vite advisories have no Vite-5 fix, so
  Vite 6 is mandatory to clear the 2 high + 4 medium vite alerts.
- **Jump to the latest Vite 7/8** — rejected: a larger, riskier major bump than the CVEs require; 6.4.3 is
  the minimal clearing version and sits inside every tool's peer range.
- **Accept-risk / suppress the alerts** — rejected: all are cleanly patchable without breaking the build;
  DoD §4 wants them gone, not waived.

**Consequences**
- All 14 alerts clear: `pnpm audit` goes **11 → 0** and `pnpm audit --prod` stays clean (dev-scope only).
  `pnpm typecheck` / `lint` / `test` (506 passing) / `build` (now `vite v6.4.3`) are green; the native
  `better-sqlite3` rebuild still extracts the Electron headers via tar 7.5.16 unchanged.
- The project is now on the Vite 6 line (the move ADR-0010 anticipated); a later `electron-vite@5` bump
  (which needs Vite 6+) is unblocked should it ever be wanted.
- Two `pnpm.overrides` are now load-bearing for security: if a future dependency legitimately needs an older
  `tar`/`esbuild`, the override must be revisited (revert is a one-line change). No runtime `dependencies`
  semantics changed and no feature dependency was removed.

---

### ADR-0016: jsdom + Testing Library (dev-only) to drive the renderer test-first
**Date**: 2026-06-24
**Status**: Accepted
**Tier**: auto-with-audit. Every addition is a **devDependency** — it ships in no production bundle, opens
no network or external origin, and leaves the local-only runtime (ADR-0008, AC-4) untouched; this ADR is
the required audit note.

**Context**
SENTINEL/AGENTS mandate test-first. Before card U3 the suite was Node-only (importers, IPC, security)
under Vitest; there was no way to render a React component or assert on the DOM, so the onboarding flow
and the shared renderer foundation could not be built test-first. A renderer test environment was needed.

**Decision**
Add dev-only `jsdom` and `@testing-library/{react,jest-dom,user-event}`, and split `vitest.config.ts`
into two projects: the existing **node** project and a new **renderer** project (jsdom environment,
`tests/renderer/setup.ts`). Renderer specs use Testing Library role/label queries and `user-event` —
mirroring how a non-technical user actually operates the UI — and the suite stays a single `pnpm test`.

**Alternatives considered**
- **happy-dom** instead of jsdom: lighter, but jsdom is the most widely-exercised, best-compatible DOM for
  Vitest + Testing Library; chosen for reliability over a marginal speed gain.
- **Playwright component / e2e testing only**: heavier, slower, Electron-oriented here, and unsuitable as a
  fast TDD inner loop. Playwright is still used out-of-band for the visual/screenshot pass.
- **No renderer tests** (manual checking only): violates the test-first mandate; rejected.

**Consequences**
- The renderer is now TDD-able, with renderer specs running in CI through the same `pnpm test` entry point.
- Three small, well-known test-only packages enter the lockfile; none reach production or the network.
- U1/U2 inherit the harness and the `tests/renderer/support` helpers (a fake `window.kawsayAPI`, a render
  wrapper) and write their screens test-first with no further setup.

---

### ADR-0015: Dependency-free typed view router for the renderer (no `react-router-dom`)
**Date**: 2026-06-24
**Status**: Accepted
**Tier**: auto-with-audit (card U3 pre-authorized adding `react-router-dom` as auto-with-audit; this ADR is
the required audit note for choosing instead to add **no** dependency). Adds no network egress, backend, or
external origin, so the local-only invariant (ADR-0008, AC-4) is untouched.

**Context**
Card U3 builds the first real renderer: onboarding (welcome → name → library location → source →
walkthrough → locate → import) plus a main app shell with a handful of sections (Timeline, Search, Add
memories, Settings). The renderer needs a way to move between these views, and U1/U2 need a way to add
their own screens. Kawsay is a single-window, fully-offline Electron app with no URLs, no deep-linking, no
server-side routing, and a deliberately small, finite set of screens.

**Decision**
Use a hand-rolled, **fully-typed view-state router** built on React context: a `View` discriminated union
(`{ name: 'onboarding' | 'timeline' | 'search' | 'add-memories' | 'settings' }`), a `NavigationProvider`
holding the current view, and a `useNavigation()` hook exposing `{ view, navigate }`. Onboarding's internal
step machine (`welcome → … → import`) is local state within `OnboardingFlow`. No routing library is added.

**Alternatives considered**
- **`react-router-dom`** (pre-authorized): mature and familiar, but built around URLs / history / deep-
  linking that a single-window offline desktop app does not have. It would add a dependency (and its
  transitive surface) to express what a ~20-line typed union already expresses, invite URL-shaped patterns
  that do not map to this app, and grow the bundle for no user-visible benefit.
- **A state-machine library (XState, etc.)**: far more than a few-screen calm app needs; rejected on the
  same zero-dep, low-complexity grounds.

**Consequences**
- Zero new runtime dependencies; nothing to audit for egress; smaller bundle; the navigation surface is
  exhaustively typed (adding a screen is a compile error until every `switch` handles it).
- U1 (timeline) and U2 (search) extend navigation by adding a member to the `View` union and a `case` in
  the renderer — no router config, loaders, or path strings.
- No URL / deep-link / back-forward history semantics. If a future card needs genuine deep-linking or many
  dozens of screens, this ADR can be superseded; for the current and foreseeable scope the typed union is
  simpler and safer.

---

### ADR-0014: Hand-rolled RFC 4180 CSV reader for the LinkedIn importer (no `csv-parse`/`papaparse` dependency)
**Date**: 2026-06-24
**Status**: Accepted
**Tier**: auto-with-audit (card C5 pre-authorized adding `csv-parse` as auto-with-audit; this ADR is the
required audit note for choosing instead to add **no** dependency). Adds no network egress, backend, or
external origin, so the local-only invariant (ADR-0008, AC-4) is untouched.

**Context**
Card C5 (#12) adds the LinkedIn importer (AC-16), which must parse LinkedIn's `messages.csv`,
`Connections.csv`, and `Rich_Media.csv`. Real exports are messy: quoted fields with embedded commas and
newlines, doubled `""` escapes, a UTF-8 BOM on the first cell, mixed CR/LF/CRLF terminators, and a free-text
`Notes:` preamble before `Connections.csv`'s header. Splitting naively on commas/newlines would truncate a
message or smear it across rows — the exact "never silently drop a memory" failure the WhatsApp importer was
hardened against. The card pre-authorized adding the tiny, well-known `csv-parse` for this (auto-with-audit),
and `docs/ARCHITECTURE.md` had floated `papaparse` as a candidate.

**Decision**
Add **no** new dependency. Implement a small, dependency-free, single-pass RFC 4180 reader at
`electron/main/importers/csv.ts` (`parseCsv(input): string[][]`) that handles quoted fields, embedded
commas/newlines, doubled-quote escapes, a leading BOM, and CR/LF/CRLF rows. Header interpretation (locating
the real header past a preamble, case/space-insensitive column matching, synonyms) stays in the importer,
not the reader. The reader and the importer's CSV behavior are pinned by unit tests (`tests/unit/csv.test.ts`
plus the LinkedIn importer suite).

**Alternatives considered**
- **`csv-parse`** (pre-authorized): battle-tested and correct, but adds a runtime dependency + transitive
  supply-chain surface to a zero-egress, local-only app for what is ~60 lines of well-understood parsing.
- **`papaparse`** (floated in ARCHITECTURE): heavier and browser/stream-oriented; more surface than this
  main-process path needs.
- **Naive split on `,`/`\n`**: rejected outright — it corrupts quoted commas/newlines and loses data.

**Consequences**
- Zero added dependency, install-time, and supply-chain surface; nothing weakens the AC-4 local-only / no-egress
  invariant. We own the parsing semantics and they are fully unit-tested against adversarial fixtures.
- Trade-off: we maintain the reader ourselves and must keep its edge-case coverage honest (quoted
  commas/newlines, doubled quotes, BOM, CR/LF/CRLF, preamble) — which the committed tests enforce. If a future
  importer needs streaming or dialect-detection beyond RFC 4180, revisit adopting `csv-parse` (this ADR would
  be superseded).

---

### ADR-0013: Revert Takeout email tooling to `mailparser` + an in-module streaming `From `-delimited splitter (supersedes ADR-0009)
**Date**: 2026-06-24
**Status**: Accepted
**Tier**: auto-with-audit (dependency choice for the C4 Takeout importer; this ADR is the audit note and
restores the `mailparser` reference named in MISSION §3 / AGENTS.md §Tech stack; MISSION §9).

**Context**
ADR-0009 substituted the MISSION §3 / AGENTS.md-named **`mailparser`** with **`mbox-parser` + `postal-mime`**
to satisfy AC-11's two requirements: (1) **split** a multi-message Gmail `.mbox`, and (2) do so by
**streaming**, never loading a (potentially multi-GB) mailbox into memory. Implementing card C4 (#11), the
delegated scope is explicit: use **`mailparser`** (the pre-approved §3 dependency) and pair it with an
in-repo streaming splitter — exactly the "equivalent streaming `From `-delimited splitter … hand-rolled
splitter as the documented escape hatch" that ADR-0009 itself sanctioned. `mbox-parser` + `postal-mime`
were never added to the lockfile, so this is a forward choice, not a removal.

**Decision**
Add **only** `mailparser` (+ `@types/mailparser`) — both pre-approved in MISSION §3. The importer's parse
phase is *stream-split → per-message parse → normalize → emit*:
- **Splitter (in-module, streaming):** read the `.mbox` through a new `FsLike.openReadStream` seam and a
  `node:readline` interface, accumulating lines and flushing a message on each `^From ` separator
  (mboxrd), unescaping `>From ` body lines so they are never mistaken for a separator. The whole file is
  never buffered — constant-memory at any size (AC-11). A separate streaming-splitter **dependency** is
  therefore unnecessary.
- **Per-message parse:** `mailparser`'s `simpleParser` on each extracted block. A block that throws, or
  that has no recognizable headers (truncation / binary noise), is a **skip** (`E_PARSE_MSG`, AC-15).
- Email attachments are materialized into the import scratch dir through a second new optional seam,
  `FsLike.writeFile`, so the worker hashes + content-addresses them like any archive original (§4.4).

**Alternatives considered**
- *Keep ADR-0009 (`mbox-parser` + `postal-mime`).* Rejected for this card: it contradicts the delegated
  instruction and MISSION §3, and would add two deps where the streaming split is a few dozen lines of
  `readline` over a seam we already needed for the multi-GB memory bound.
- *Load the whole `.mbox` and split in memory.* Rejected — violates AC-11 and OOMs on multi-GB exports.
- *A dedicated streaming-splitter dependency.* Unnecessary once the read-stream seam exists; fewer deps =
  smaller supply-chain surface. The `From `/`>From ` mboxrd rules are small and unit-tested adversarially.

**Consequences**
- ✅ AC-11 streaming satisfied with **one** pre-approved dep: constant-memory `.mbox` import at any size;
  messages parsed and emitted one-by-one.
- ✅ Restores the MISSION §3 / AGENTS.md `mailparser` reference; **supersedes ADR-0009** (no invariant
  weakened — still local-only, still streaming, still off-thread; email parsing stays isolated with
  `try/catch` and a malformed message is a skip, AC-15).
- ⚠️ The mboxrd split logic is maintained in-repo (`takeout-importer.ts`) rather than delegated to a
  library — covered by streaming/`>From`/truncation unit tests so regressions surface immediately.
- ➕ Two **optional** `FsLike` methods (`openReadStream`, `writeFile`) are added to the DI seam; existing
  importers and their fixtures are untouched (backward-compatible).

---

### ADR-0012: Media-ingestion dependencies (`exifr`, `fluent-ffmpeg`, `ffmpeg-static`, `ffprobe-static`) + the off-thread ingestion engine, split out of F3b
**Date**: 2026-06-23
**Status**: Accepted
**Tier**: auto-with-audit (new **non-heavy** runtime deps + a new internal module boundary — MISSION §9; this
ADR is the required audit note). None of these adds network egress, a backend, or an external origin, so the
local-only invariant (ADR-0008) is untouched.

**Context**
Card F3b (#47) wires the F3 contracts (`Importer`/`CatalogRecord`/`ImporterDeps`, `CatalogRepo`,
`originals-store`, `library-service`) into a runnable ingestion engine and exposes it over IPC. Two things
are needed before any importer can produce a catalogued memory: (a) concrete, sandboxed `ImporterDeps`
wrappers (EXIF reader, media prober, file hasher) plus a thumbnail/poster generator, and (b) an
orchestrator that drains an `Importer`'s `CatalogRecord`s and persists them with dedup-with-provenance,
content-addressed originals, and generated renditions — off the UI thread (AC-9; ARCHITECTURE §5).

**Decision**
- Add four **runtime** dependencies, each consumed only in the main-process ingestion path:
  - **`exifr`** — capture-date/GPS/camera EXIF reader (`ExifReader`). Wrapped so a malformed header is a
    **skip**, never a crash (AC-15; ARCHITECTURE §7.2). EXIF carries no timezone → read as **UTC** (§3.2).
  - **`ffprobe-static`** — bundled, pinned `ffprobe` binary; **`fluent-ffmpeg`** — a thin, well-known
    launcher used **only** to spawn that binary for the `MediaProber` (duration/dimensions). It is a
    subprocess handed **only a local path** as an argv element (no shell string), closing the AC-4
    subprocess gap (ARCHITECTURE §6.1/§7.2).
  - **`ffmpeg-static`** — bundled, pinned `ffmpeg` binary; invoked **directly** via `child_process.spawn`
    with an **array argv** (never a shell string, only local paths) to write WebP thumbnails/posters into
    the library `derived/` tree.
- **Split F3b** per its own size guard. This PR delivers the **media-deps + the off-thread ingestion
  orchestrator** (the engine); the **IPC layer** (`library:create/open`, `catalog:timeline/search`,
  `import:start/cancel/progress`) and the worker/`utilityProcess` harness that runs the orchestrator
  off-thread land in a follow-up card **F3c**, where `import:start` spawns the worker and an integration
  test exercises it. The orchestrator is written thread-agnostic (a pure async function over injected
  deps + `AbortSignal` + `onProgress`) precisely so the F3c harness can run it in a worker unchanged.

**Alternatives considered**
- *Call `ffprobe` directly via `spawn` instead of `fluent-ffmpeg`* — viable and aligned with ADR-0004's
  "call the binaries directly", but the card names `fluent-ffmpeg` and it is a thin, battle-tested arg
  builder for the probe path only; the `MediaProber` runner is injectable, so dropping `fluent-ffmpeg`
  later is a one-line change behind the seam. `ffmpeg` (thumbnails) **is** called directly.
- *`sharp` for image thumbnails* (ARCHITECTURE §5.1 preference) — deferred: its native rebuild is heavier
  than the four bundled-binary deps here; v1 uses `ffmpeg` for both stills and video posters (§5.1 permits
  this) and `sharp` can be introduced later behind the same `ThumbnailGenerator` seam.
- *Ship the whole F3b card (engine + IPC + worker) in one PR* — rejected by F3b's explicit
  `~10 files / ~500 LOC` reviewability guard; split into engine (this PR) + IPC (F3c).

**Consequences**
- ✅ Importers get real EXIF/probe/hash deps and the worker gets a thumbnail generator, all behind the
  injectable seams F3 defined — unit-testable with fixtures/mocks, no binaries required for the logic tests.
- ✅ ffmpeg/ffprobe stay isolated subprocesses fed only local paths (AC-4 subprocess gap closed).
- ✅ Each PR stays reviewable; the orchestrator is thread-ready for the F3c worker harness.
- ⚠️ `fluent-ffmpeg` is deprecated (flagged in ADR-0004); kept narrowly for the probe path behind an
  injectable runner, a candidate to drop. ⚠️ `ffmpeg-static`'s binary download (a postinstall) is **not**
  enabled in `onlyBuiltDependencies`, so CI installs stay fast and egress-free and unit tests use mocked
  subprocesses; provisioning/bundling the real binaries for the packaged app is an electron-builder/dist
  concern (ADR-0004/ADR-0007), not this card.

---

### ADR-0011: `nock` as the http(s) layer of the AC-4 zero-egress test harness
**Date**: 2026-06-23
**Status**: Accepted
**Tier**: auto-with-audit (test-only tooling — MISSION §9 lists test dependencies as `auto`; this ADR is
the required audit note for the addition). **`nock` is a `devDependency` only** — it never ships in the
packaged app and adds no runtime/network capability to the product.

**Context**
Card X1 (#16) builds the AC-4 harness (ARCHITECTURE §6.2; ADR-0008 §5). The Node-side defense-in-depth
spies must assert **zero** outbound `http`/`https` requests during a representative flow. Prototype
patching (`net.Socket.prototype.connect`, `dgram.Socket.prototype.send`) reliably intercepts raw
TCP/UDP/TLS/HTTP2 regardless of ESM/CJS import style, but the canonical, well-understood way to deny and
record the **http(s) client layer** is `nock.disableNetConnect()` — exactly the tool PRD AC-4 and
ARCHITECTURE §6.2 name ("`nock.disableNetConnect()` for `http(s)`").

**Decision**
Add **`nock@^14`** as a **devDependency**. It is used only under `tests/ac4/` to (a) deny all net
connect at the http layer during the in-process spy run and (b) prove the harness is not a silent no-op
via a positive control (a deliberate `http`/`https` request that `nock` must block). No other dependency
is added by this card.

**Alternatives considered**
- *Hand-roll an `http`/`https` agent stub.* Rejected — reinvents `nock`, less battle-tested, and the
  acceptance criterion explicitly names `nock`.
- *Rely solely on the socket prototype patch for http(s).* Rejected as the primary http assertion —
  the prototype patch is kept as defense-in-depth, but `nock` is the documented, legible http-layer
  control and makes the positive control unambiguous.

**Consequences**
- ✅ The http(s) layer of AC-4 is asserted with the tool the spec names; positive control is legible.
- ✅ Zero production impact — `devDependency`, used only in `tests/ac4/`.
- ⚠️ One more dev dependency to keep patched (Dependabot covers it).

---

### ADR-0010: Build tooling for the app shell — `electron-vite` pinned to `^4` (not `^5`) + Tailwind CSS v4
**Date**: 2026-06-23
**Status**: Accepted
**Tier**: auto-with-audit (build tooling — ARCHITECTURE §1.2 mandates `electron-vite`; `tailwindcss` is
named in MISSION §3. This ADR is the audit note for the *versions* chosen while scaffolding card F1).

**Context**
ARCHITECTURE §1.2 (line 70) requires the shell be "**Built with `electron-vite`** (one config drives the
main / preload / renderer triple build; HMR…)". MISSION §3 pins **Vite** for the renderer. Our lockfile
resolves Vite to the current 5.x line (**5.4**). Two version questions had to be settled to make
`pnpm typecheck` / `pnpm build` pass:
1. **`electron-vite` major.** The newest is `5.x`, but `electron-vite@5`'s own config typings import
   **`BuildEnvironmentOptions`** from Vite — a type that only exists in **Vite 6+**. Against the
   Vite 5.4 we depend on, `tsc --noEmit` of `electron.vite.config.ts` fails on every `build.lib` /
   `build.rollupOptions` field (the symbol is absent from all Vite 5.4 `.d.ts`), even though the config
   runs fine at runtime. Our gate is **zero-warning typecheck**, so a config that doesn't type-check is
   not acceptable.
2. **Tailwind major.** `tailwindcss` is in MISSION §3 with no pinned major; v4 is current.

**Decision**
- Pin **`electron-vite@^4`** (resolved `4.0.1`) — the newest major whose published types are
  **Vite-5-compatible**: its peer range is `vite@^5 || ^6 || ^7`, it does **not** reference
  `BuildEnvironmentOptions`, and each process block is a plain Vite `UserConfig`. Typecheck is clean.
- Adopt **Tailwind CSS v4** with the CSS-first `@theme {}` API (`src/styles/tokens.css`) to express the
  USER_FLOWS §5 design tokens (calm palette, Lora/Inter type scale, spacing, radii, motion) — no
  `tailwind.config.js` needed; tokens live beside the CSS that consumes them.
- Consequence of `electron-vite` + sandbox: the **preload is emitted as CommonJS** (`index.cjs`) and
  **`zod` is bundled into it** (a sandboxed preload cannot `require` from `node_modules`); main and
  renderer stay ESM. The non-default `electron/` + `src/` layout (ARCHITECTURE §1.2) means electron-vite
  auto-discovery is bypassed in favour of explicit `build.lib.entry` / `rollupOptions.input`.

**Alternatives considered**
- *`electron-vite@5` + Vite 5* — **rejected**: fails the typecheck gate (`BuildEnvironmentOptions`).
- *Bump Vite to 6 to satisfy `electron-vite@5`* — **rejected**: MISSION §3 names Vite as the scaffold's
  pinned bundler and the rest of the stack (`@vitejs/plugin-react@^4`) is validated against Vite 5; a
  Vite-major bump is a larger, separate decision, not a scaffolding side-effect.
- *Raw Vite with three hand-rolled configs (no `electron-vite`)* — **rejected**: ARCHITECTURE §1.2
  explicitly mandates `electron-vite`.
- *Tailwind v3 with a JS config* — **rejected**: v4 is current and its `@theme` keeps tokens declarative
  and co-located; no behavioural feature depends on v3.

**Consequences**
- `pnpm typecheck` / `pnpm lint` / `pnpm build` are green on the pinned Vite 5.4 toolchain; the
  main/preload/renderer triple builds from one `electron.vite.config.ts`.
- When the project later moves to **Vite 6+** (its own ADR), `electron-vite` can be bumped to `^5`
  without code changes — purely a tooling refresh.
- `electron@42` has **no `postinstall`**; it self-provisions its binary lazily on the first
  `require('electron')` (i.e. first `pnpm dev` / launch), so a fresh `pnpm install` + `pnpm build` works
  offline and pnpm's build-script gating does not apply to it. See LEARNINGS.

---

### ADR-0009: Takeout `.mbox` streaming split + email-parser substitution (`mailparser` → `mbox-parser` + `postal-mime`)
**Date**: 2026-06-23
**Status**: Superseded by ADR-0013
**Tier**: auto-with-audit (dependency substitution + new internal parse tooling — this ADR is the audit
note for the `mailparser` reference in MISSION §3 / AGENTS.md §Tech stack; MISSION §9).

**Context**
MISSION §3 / AGENTS.md name **`mailparser`** for "Takeout / email". Two problems surfaced in red-team:
(1) **`mailparser` and `postal-mime` parse a *single* RFC-822 message** — neither can *split or stream*
a multi-message Gmail **`.mbox`**, which in a real Takeout can be **multiple GB**; (2) **AC-11 requires
streaming** parses that **do not load the whole `.mbox` into memory**. A single-message parser alone
therefore cannot satisfy AC-11, regardless of which one we pick.

**Decision**
Split the `.mbox` with a **streaming splitter** — **`mbox-parser`** (async-paginated; reads
message-by-message without buffering the file; an equivalent streaming `From `-delimited splitter is an
acceptable substitute) — and parse **each** extracted message with **`postal-mime`** (modern, zero-dep,
ESM, actively maintained) **instead of `mailparser`**. The importer's parse phase becomes
*stream-split → per-message parse → normalize → emit* (ARCHITECTURE §3.2/§5). Both are **non-heavy**
deps. This ADR is the required **auto-with-audit** note for substituting `mailparser`; the substitution
changes only *which* email tooling is used — it **weakens no invariant** (still local-only, still
streaming, still off-thread).

**Alternatives considered**
- *Keep `mailparser`.* It is older, heavier (callback/stream API), and **still single-message** — a
  splitter would be required anyway. `postal-mime` chosen for ESM + active maintenance + smaller surface.
- *Load the whole `.mbox` and split in memory.* **Rejected** — violates AC-11 streaming and OOMs on
  multi-GB exports.
- *Hand-roll a `From `-line splitter.* Viable as a fallback, but easy to get subtly wrong (quoting,
  `>From` escaping); a maintained streaming splitter is preferred, with a hand-rolled splitter as the
  documented escape hatch if the dep is ever unsuitable.

**Consequences**
- ✅ AC-11 streaming satisfied: constant-memory `.mbox` import at any size; messages fed one-by-one to
  the per-message parser and emitted as found (first-memory payoff, SM-2).
- ✅ The MISSION §3 / AGENTS.md `mailparser` reference is **superseded for v1** by `mbox-parser` +
  `postal-mime`, audited here (auto-with-audit; the §3 stack list is illustrative — "e.g." tooling).
- ⚠️ Two small deps instead of one; both pinned and Dependabot-tracked. Email parsing remains isolated
  in the worker with `try/catch` + per-message caps (a malformed message is a **skip**, AC-15).

---

### ADR-0008: Privacy, data location & the local-only / zero-egress invariant
**Date**: 2026-06-23
**Status**: **Proposed — HUMAN-REQUIRED sign-off (@pedrofuentes) before the data-layer / F3 code is written.**
**Tier**: human-required (privacy/data design — MISSION §9; AGENTS §HUMAN REQUIRED).

> **This ADR is self-contained so the cofounder can approve it directly.** It is the gate for the
> entire data layer (ADR-0003 schema/migrations) and the AC-4 zero-egress invariant. No
> F3 (data-layer) code may be written until this is approved with a `decision:approved` label /
> review from @pedrofuentes.

**Context**
Kawsay catalogues the **extremely sensitive personal data of a deceased person who can no longer
consent** (PRD §2.3). MISSION §5 makes one promise binding above all others: *"All data stays on the
user's device. Nothing is uploaded; no telemetry; no analytics on user content. A loved one's memories
must never leave the machine."* It is a **core, tested promise** (AC-4) and on the NEVER list (MISSION
§7; AGENTS NEVER §Project). Before any code reads or writes user memories, the cofounder must approve
**(a)** exactly where that data lives on disk, **(b)** what is stored, **(c)** the guarantee that
nothing leaves the device, **(d)** the threat model for untrusted export files, and **(e)** how the
invariant is enforced and tested.

**Decision** *(proposed — awaiting @pedrofuentes)*

1. **Where the data lives.** One **user-chosen library folder** (default: a recommended location via
   the `LibraryLocationPicker`; e.g. `~/Documents/Kawsay/<Name>'s Library` or a folder the user picks).
   The library is **self-contained and portable** and contains **only** the user's memories + catalog:
   ```
   <library root>/
   ├── catalog.sqlite3 (+ -wal, -shm)   the SQLite catalog/index (better-sqlite3)
   ├── originals/<hash[0:2]>/<hash>[.ext]   archive-extracted originals, CONTENT-ADDRESSED, stored ONCE
   ├── derived/{thumbnails,posters,waveforms}/…   Kawsay-generated, rebuildable
   ├── extract/<source-id>/…            transient extraction scratch (deleted after each import)
   └── logs/
   ```
   - **Folder imports are referenced in place** — the user's photos/videos are **never copied or
     moved**; the catalog records their absolute path on an `in_place` occurrence. (AC-14.)
   - **Archive imports** (WhatsApp/Takeout/Facebook/LinkedIn `.zip`) copy each original **once,
     content-addressed**, into `originals/<hash[0:2]>/<hash>[.ext]`; identical bytes from a second
     source are **not** re-copied (no duplicate storage). The blob is **reference-counted by
     occurrence** and deleted only when its last occurrence is undone (§4.4) — so undo never dangles a
     deduped memory. The **source `.zip` is never altered or deleted**.
   - **App config** (window size, last-opened library path, accessibility prefs) lives separately in
     Electron `userData` — **never** user memory content.

2. **What is stored.** In `catalog.sqlite3`: per-item media type, MIME, **SHA-256 content hash** (dedup
   key), **capture date (canonical ISO-8601 UTC) vs import date**, EXIF (incl. **GPS coordinates —
   catalogued locally only; never sent to any online map/geocoder**), message/caption text, and
   per-source **provenance** (`item_occurrences`, including how each occurrence's original is retained).
   A memory's **original is resolved through a surviving occurrence** (there is no single `stored_path`),
   so dedup + undo stay consistent. Generated thumbnails/posters live in `derived/`. Nothing else; **no
   account, no identifiers, no telemetry**.

3. **The guarantee — no user memory data ever leaves the device.**
   - **No network client exists in v1** — no `fetch`, no telemetry SDK, no update check, no remote
     fonts/CDN/maps. Fonts (`Lora`, `Inter`) and icons are **bundled** (`.woff2` / local SVG sprite).
   - **Renderer CSP `connect-src 'none'`** forbids all `fetch`/XHR/WebSocket from the UI.
   - **Main-process network guard** (`session.webRequest.onBeforeRequest`) cancels every request whose
     scheme is not `file:` / `kawsay-media:` / `blob:` / `data:`.
   - **ffmpeg/ffprobe** subprocesses receive **only local file paths, never URLs**, so they cannot be
     coerced into network I/O.
   - Adding *any* network egress, backend, account, cloud sync, or telemetry is **human-required**
     (or **never**, if it would break this guarantee) regardless of default tier (MISSION §9 override).

4. **Threat model for untrusted export files.** Export archives are **untrusted, attacker-influenceable
   input**. Mitigations (ADR-0006; ARCHITECTURE §7): zip-slip/path-traversal rejection
   (`ERR_ARCHIVE_UNSAFE_PATH`), decompression-bomb caps (per-entry/total/ratio/count →
   `ERR_ARCHIVE_BOMB`), **symlink rejection** (`ERR_ARCHIVE_SYMLINK`), strict filename validation, and
   `zod`-validated JSON/CSV/sidecars. Media parsing (`exifr`, `ffprobe`) is isolated in
   worker/`utilityProcess` with timeouts + output caps so a malformed file cannot crash or hang the app
   or escape its sandbox. A single bad file is a **skip** (AC-15), never a crash.

5. **How the invariant is enforced + tested (AC-4).** Defense-in-depth at runtime (items 3 above) **and
   proven automatically by an authoritative OS layer plus defense-in-depth spies and positive controls**
   (ARCHITECTURE §6.2):
   - **(Authoritative, MANDATORY) An OS-level outbound-deny firewall** runs in the AC-4 e2e CI job —
     denying all egress except loopback while the **packaged** app runs the full flow. It is the layer
     that actually covers the **Node main + worker threads, the `ffmpeg`/`ffprobe` subprocess, and DNS
     resolution**. The job **asserts the deny rule is active** before trusting a green run — if the
     firewall is not in place the job **fails** (no silent no-op).
   - **(Defense-in-depth) Node-side spies** over **`net`, `tls`, `http2`, `dgram` (UDP), and
     `dns.lookup`/`dns.resolve`**, plus `nock.disableNetConnect()` for `http(s)`, across every importer
     — assert **zero** attempts. (Spies cannot see the subprocess; the OS firewall is authoritative.)
   - **(Defense-in-depth) Playwright `page.route`** over the renderer — asserts **zero** outbound.
   - **Positive controls (anti-false-pass):** deliberate outbound attempts from **the main process, a
     worker thread, and the `ffmpeg`-subprocess path** that the harness **must** catch — so a
     misconfigured firewall fails the job instead of silently passing.
   Any PR touching the network guard, CSP, the firewall step, or AC-4 tests is **harness-integrity →
   human-required** and may **never** weaken the promise.

**Alternatives considered**
- *Store the library in Electron `userData` (hidden app folder).* Rejected as the **default** — users
  must be able to see, choose, back up, and one day hand the archive to family (Mateo); a portable,
  user-chosen folder serves the "gift to the family" goal (PRD §2.2). `userData` is used only for app
  config.
- *Copy folder-import originals into the library too (uniform storage).* Rejected — copying risks the
  "originals altered/duplicated" failure and doubles disk use; AC-14 requires folder originals stay
  byte-identical in place. Archives are copied only because their contents must be extracted out of the
  `.zip` to be catalogued.
- *Copy archive originals per-source into `originals/<source-id>/…` with one `items.stored_path`.*
  **Rejected** — it **double-stores** bytes that arrive from two sources, and on undo of the owning
  source it **dangles** the original for a still-deduped item (the `stored_path` points at a deleted
  copy) — violating AC-14's "undo without data loss". Replaced by **content-addressed storage stored
  once** (`originals/<hash[0:2]>/<hash>[.ext]`), **reference-counted by occurrence**, with the original
  resolved through a *surviving* occurrence (ADR-0003; ARCHITECTURE §4.4).
- *Encrypt the catalog/originals at rest.* Deferred — v1 relies on OS-level disk encryption + the
  local-only guarantee; app-level encryption (key management for a non-technical, grieving user) is a
  future consideration, not a v1 requirement, and would add recovery-loss risk. Flagged for the
  cofounder's input.
- *Allow GPS map rendering / reverse-geocoding.* Rejected for v1 — it requires network egress and would
  break AC-4 (PRD §7). Coordinates are stored locally only.

**Consequences**
- ✅ A clear, approvable privacy contract the whole build implements against; the data layer can begin
  once signed off.
- ✅ The portable, user-chosen library is durable, inspectable, and family-handoff-ready (open formats,
  originals preserved).
- ✅ The zero-egress promise is both designed-in and continuously tested. The AC-4 proof is **airtight**:
  a **mandatory, self-asserting** OS firewall covers the **subprocess + DNS**, broadened Node spies and
  Playwright add defense-in-depth, and **positive controls** make a misconfigured green run impossible
  (MISSION §5, AC-4).
- ✅ Content-addressed, occurrence-refcounted originals make **undo lossless even for deduped memories**
  (no dangling original; no double-stored bytes), satisfying AC-14.
- ⚠️ Forbids, in v1, any feature needing the network (maps, geocoding, model downloads, sharing, update
  checks) — each is a separately-gated future milestone (ROADMAP M2/M4/M5/M6).
- ⚠️ A user who moves/renames the library folder or in-place folder originals will see broken references
  until the library is re-pointed; the library-service must handle relocation gracefully (catalog is
  rebuildable from originals).
- 🟡 **Two accepted deferrals (explicitly in-scope of this sign-off):** (1) **no at-rest encryption** in
  v1 (rely on OS disk encryption + local-only; app-level key management deferred), and (2) **unsigned
  v1** binaries (one-time Gatekeeper/SmartScreen prompt; signing/notarization deferred — ADR-0007).
  Both are recorded here for the cofounder to accept with this ADR.
- 🚧 **Blocks F3 data-layer work until @pedrofuentes approves.**

---

### ADR-0007: Packaging & distribution via electron-builder → GitHub Releases
**Date**: 2026-06-23
**Status**: Accepted
**Tier**: auto for CI build/packaging; **the first production publish of each release is human-required**
(MISSION §9; PRD AC-5).

**Context**
v1 must build into installable **macOS** and **Windows** artifacts published to **GitHub Releases** and
launch (AC-5). `better-sqlite3` is a native module (Electron ABI) and `ffmpeg`/`ffprobe` are bundled
binaries — both complicate packaging. No backend, no app store (MISSION §2).

**Decision**
Use **`electron-builder`**. Targets: macOS **`.dmg` + `.zip`** (`arm64`+`x64`), Windows **NSIS `.exe`**
(**`x64` only in v1**). Publish to **GitHub Releases** (`provider: github`, `--publish
always`, `GH_TOKEN`). Rebuild native modules for Electron's ABI (`npmRebuild: true`,
`buildDependenciesFromSource: true`) and **`asarUnpack`** `better-sqlite3` + `ffmpeg-static` +
`ffprobe-static` (a `.node`/binary can't load from inside asar). **CI matrix on per-arch native
runners** (`macos-14` arm64, `macos-13` x64, `windows-latest` x64) — native modules can't be
cross-compiled; pin **Node 22** + **Python 3.11** (node-gyp needs `distutils`). Flip `@electron/fuses` +
ASAR integrity at package time. **Ship unsigned in v1** (`mac.identity: null`; NSIS unsigned) — one-time
Gatekeeper/SmartScreen prompt; signing/notarization deferred (MISSION §2). The **first production
publish of each release runs in a protected GitHub Environment with required reviewers** (@pedrofuentes).

**`win-arm64` is dropped from v1.** AC-5 requires every published artifact to be **smoke-launched**, and
there is **no hosted arm64 Windows CI runner** to do so; a cross-compiled-but-unsmoke-tested binary
cannot satisfy AC-5. Windows-on-ARM runs x64 builds under emulation, so x64-only still serves those
users. `win-arm64` is a post-v1 target, gated on a native arm64 Windows runner.

**Alternatives considered**
- *Electron Forge* — equally viable; `electron-builder` chosen for its first-class multi-target
  GitHub-Releases publish and the directly-applicable `octomux` reference (`better-sqlite3` + multi-arch).
- *Universal macOS binary* — deferred; per-arch `.dmg`s are simpler to build on native runners.
- *Ship `win-arm64` cross-compiled but unsmoke-tested* — **rejected**: it would publish an artifact no
  CI job can launch, contradicting AC-5's "builds **and launches**". x64-only (emulated on WoA) chosen
  for v1; native arm64 revisited when a hosted runner exists.
- *`fluent-ffmpeg`* — rejected (deprecated/read-only 2024); call bundled binaries via `spawn` directly.

**Consequences**
- ✅ Reproducible installers for both OSes, published automatically on tag; satisfies AC-5.
- ✅ Native module + ffmpeg binaries load correctly in the packaged app.
- ✅ Every published artifact is on a **native runner that smoke-launches it** — no unverifiable arch.
- ⚠️ Unsigned v1 means a one-time "unidentified developer" prompt — acceptable for a known-family v1.
- ⚠️ Windows-on-ARM users run the x64 build under emulation in v1; a native `win-arm64` build is a
  post-v1 milestone gated on a hosted arm64 Windows runner.
- 🔒 The human-required publish gate (protected Environment) is enforced outside CI logic, so an
  automated build can never publish a release unattended.

---

### ADR-0006: Safe untrusted-archive extraction (yauzl) + stable ERR_ARCHIVE_* codes
**Date**: 2026-06-23
**Status**: Accepted
**Tier**: auto-with-audit (security-relevant module boundary + new error contract).

**Context**
Every v1 source except folders arrives as an **untrusted `.zip`** (WhatsApp, Takeout, Facebook,
LinkedIn). Naive extraction is vulnerable to **zip-slip / path traversal** (Snyk, 2018) and
**decompression bombs / symlink escapes**. AC-3 and AC-10 require safe extraction with **stable,
assertable error codes** surfaced as non-technical messages.

**Decision**
A single guarded extractor (`ingestion/safe-extract.ts`) using **`yauzl`** is the **only** way archives
are opened. On every entry, before writing: `validateFileName` (rejects `/`, `..`, `\`) + belt-and-
suspenders resolved-path `startsWith(destDir + sep)`; per-entry (≤500 MB), total (≤2 GB), ratio (≤100),
and entry-count (≤100 000) caps; `validateEntrySizes` + `strictFileNames`; **symlink rejection** via
Unix mode bits. Failures throw a typed `ArchiveError` with a **stable code** and a non-technical
`messageKey`:
`ERR_ARCHIVE_UNSAFE_PATH` (AC-3) · `ERR_ARCHIVE_BOMB` (AC-10) · `ERR_ARCHIVE_SYMLINK` (AC-10) ·
`ERR_ARCHIVE_CORRUPT`. Adversarial fixtures drive unit tests.

**Alternatives considered**
- *`adm-zip` / `unzipper`* — rejected; historically vulnerable to zip-slip and no built-in filename
  validation. `yauzl` was designed with zip-slip prevention as a first-class property.
- *Fold symlink into `ERR_ARCHIVE_BOMB`* (strict AC-10 literal) — a dedicated `ERR_ARCHIVE_SYMLINK` was
  chosen for clarity; AC-10's observable guarantees are met and not weakened. **Flagged for red-team**;
  trivially reversible to the literal if preferred.

**Consequences**
- ✅ AC-3/AC-10 satisfied with stable, testable codes; one auditable extraction path.
- ✅ Non-technical users see clear refusals (`ErrorBanner`, no raw codes).
- ⚠️ The numeric caps are policy defaults; if a legitimate huge export trips a cap, the cap is tuned in
  one place (documented), never by disabling the guard.

**Audit (2026-06-23, card C2 #9)**: implemented as `electron/main/importers/safe-extract.ts`; added
`yauzl@^3.4.0` (dependency, one transitive dep `pend`) + `@types/yauzl@^3.4.0` (devDependency). `pnpm
audit --prod` → no known vulnerabilities; no network/shell access in the module. Codes refined to a
dedicated `ERR_ARCHIVE_SYMLINK` as flagged above.

---

### ADR-0005: Electron security hardening + minimal contextBridge IPC surface
**Date**: 2026-06-23
**Status**: Accepted
**Tier**: auto (reversible config) — but the **zero-egress** portions may never be weakened (NEVER list).

**Context**
Electron apps that load untrusted-derived content need strict hardening. Kawsay also must expose
*some* capability to its renderer (import, browse, search, play media) without giving the renderer
ambient Node/fs/network authority. (MISSION §5/§7; AC-4.)

**Decision**
`contextIsolation: true`, `sandbox: true`, `nodeIntegration: false` (+ worker/subframe variants),
`webSecurity: true`. Block navigation (`will-navigate`) and `window.open` (`setWindowOpenHandler:
deny`). **Strict CSP** (`default-src 'none'; script-src 'self'; connect-src 'none'; img-src 'self'
kawsay-media: data: blob:; media-src 'self' kawsay-media: blob:; font-src 'self';
style-src 'self'; style-src-attr 'unsafe-inline'; …`). The renderer's **entire** capability is a
**minimal, enumerated `contextBridge` IPC surface** — one method per channel (no catch-all `send`),
each payload **zod-validated in preload AND re-validated in main**, with sender-origin checks. Local
media is served via a path-validated **`kawsay-media://`** custom protocol (no `file://` to the
renderer). Package-time: `@electron/fuses` + ASAR integrity (see ADR-0007).

**Alternatives considered**
- *Expose a generic `ipcRenderer.send`/`invoke` passthrough* — rejected; it is a catch-all that defeats
  the validated-surface model and widens attack surface.
- *Serve media as `file://` or marshal bytes over IPC* — rejected; `file://` over-grants the renderer
  and large media (video) marshaled over IPC is slow. A streaming custom protocol is safer and faster.
- *`style-src 'unsafe-inline'` (blanket)* — rejected in favor of the narrower `style-src-attr
  'unsafe-inline'` (needed only for the virtualizer's inline style attributes); stylesheets stay locked
  to `'self'`.

**Consequences**
- ✅ A sandboxed renderer with a tiny, typed, validated capability surface; supports the AC-4 guarantee.
- ✅ Media plays/streams locally with no `file://` exposure and no network.
- ⚠️ Every new renderer capability requires a new, explicitly-validated IPC channel — intentional
  friction that keeps the surface auditable.

---

### ADR-0004: Off-UI-thread ingestion (worker threads + ffmpeg/ffprobe subprocess)
**Date**: 2026-06-23
**Status**: Accepted
**Tier**: auto (internal performance architecture).

**Context**
Imports are heavy: parsing large chat logs / multi-GB `.mbox`, hashing every file (SHA-256), reading
EXIF, and generating thumbnails. Doing this on the Electron main thread would block the IPC loop and
freeze the UI. MISSION §7 mandates heavy ingestion off the UI thread; AC-8/AC-9 make it testable
(no main-thread task > 50 ms during import; ≥55 fps timeline at 10k items).

**Decision**
The **ingestion coordinator** (main) spawns **`worker_threads`** that run the selected `Importer`,
compute streaming SHA-256, read EXIF (`exifr`), and **write the catalog via `better-sqlite3` in the
worker**. **`ffprobe`/`ffmpeg` run as a subprocess** — ideally an Electron **`utilityProcess`** —
`spawn` with **array argv (never a shell string)**, with timeouts + output caps. Parses **stream**
(never buffer whole exports). Progress is posted to the renderer via throttled `import:progress`
events; records are persisted as found (first-memory payoff, SM-2). The renderer stays light:
**virtualized timeline** + **lazy media** over `kawsay-media://`. Thumbnails: `sharp` (images) +
`ffmpeg` (video posters); content-addressed so deduped items share one rendition.

**Alternatives considered**
- *Do ingestion on the main thread* — rejected; violates MISSION §7 and AC-9.
- *`fluent-ffmpeg`* — rejected (deprecated); call bundled `ffmpeg-static`/`ffprobe-static` directly.
- *Run ffmpeg via `exec` with a shell string* — rejected (shell-injection risk; ffmpeg CVE surface);
  `spawn` array argv only, local paths only (also closes the AC-4 subprocess gap).
- *Marshal media bytes to the renderer over IPC* — rejected for large media; stream via custom protocol.

**Consequences**
- ✅ Responsive UI during heavy imports; satisfies AC-8/AC-9; scales to ≥10k items.
- ✅ The riskiest parser (ffmpeg) is isolated in a sandboxed subprocess with resource limits.
- ⚠️ Worker-thread DB access + cross-thread progress add coordination complexity (cancellation via
  `AbortSignal`, scratch cleanup) — encapsulated in the coordinator/worker.

---

### ADR-0003: Local catalog — better-sqlite3 schema + migration runner + originals-on-disk + dedup-with-provenance
**Date**: 2026-06-23
**Status**: Accepted — **initial schema (001) is gated by ADR-0008 (HUMAN-REQUIRED) before F3 code.**
**Tier**: auto-with-audit (this ADR is the audit note for the data-model). DB-migration authoring is
itself HUMAN-REQUIRED (AGENTS Boundaries) → see ADR-0008.

**Context**
v1 needs a local index over memories from many sources, with browse/timeline + search, **originals
preserved on disk**, **capture-date vs import-date**, and **deduplication that preserves provenance**
(the same photo from two sources stored once but with both origins kept — PRD §5.6; AC-14/AC-15).

**Decision**
**`better-sqlite3`** (synchronous, fast, native; WAL + tuned pragmas). The schema's defining choice:
**`items` is the deduplicated logical memory; `item_occurrences` records every (item, source)
occurrence** — so dedup (by **SHA-256 `content_hash`**, UNIQUE; NULLs distinct for messages) stores
bytes once while preserving provenance from **all** sources. Generated renditions live in
**`item_assets`** (never the original). **FTS5** external-content virtual table (`items_fts`, kept in
sync by triggers, `unicode61` tokenizer) powers search; targeted indexes power timeline browse.
Refinements (post red-team):

- **Originals stored once, content-addressed + reference-counted.** Folder imports are **referenced in
  place**; archive originals are copied **once** to `originals/<hash[0:2]>/<hash>[.ext]` and
  **reference-counted by occurrence** (each occurrence's `original_kind` ∈ {`in_place`,
  `content_addressed`,`none`}). There is **no single `items.stored_path`** — a memory's original is
  resolved through a *surviving* occurrence, so undoing one source never dangles or double-stores a
  deduped memory (AC-14; ARCHITECTURE §4.4).
- **Stable source identity.** `sources.source_key` (archive SHA-256 / canonical folder real path),
  `UNIQUE`, is the source's identity — **not** the per-run UUID. Re-importing the same source **reuses**
  its row, so `UNIQUE(item_id, source_id, source_ref)` makes **re-import idempotent** while genuinely
  new files still add occurrences.
- **Race-free dedup.** The write path uses `INSERT … ON CONFLICT(content_hash) DO UPDATE … RETURNING id`
  (and `ON CONFLICT(item_id,source_id,source_ref) DO NOTHING` for occurrences). Imports are **serialized
  through a single ingestion worker** (single-writer); the upsert keeps it correct within a batch and if
  concurrency is ever added.
- **Canonical `capture_date`.** Every importer writes an **ISO-8601 UTC** instant (EXIF, with no tz, is
  read as UTC), so the timeline's lexicographic DESC sort is chronological.
- **Keyset timeline pagination.** A **composite `(capture_date DESC, id DESC)`** index + keyset cursor
  (`id` the UNIQUE tiebreaker; `NULLS LAST` for undated rows) — never `OFFSET` — so equal-timestamp rows
  are never skipped/duplicated and NULL-date items still appear (AC-6/AC-8).
- **Cross-source search after dedup.** When a new occurrence joins a deduped item, its
  sender/caption/filename tokens are merged (de-duplicated) into `items.search_meta` via `UPDATE`, so
  the `items_fts_au` trigger re-syncs FTS (AC-7).

A **hand-written, forward-only, transactional migration runner** (recorded in a `migrations` table) is
used over an ORM.

**Alternatives considered**
- *`source_id` directly on `items` (the research's first-cut schema)* — **rejected**: it cannot
  represent dedup-with-provenance (one item, many origins). The `item_occurrences` join is the
  deliberate correction.
- *Per-source original copies (`originals/<source-id>/…`) + one `items.stored_path`* — **rejected**:
  double-stores cross-source duplicates and **dangles** the original on undo of the owning source
  (ADR-0008). Replaced by content-addressed, occurrence-refcounted storage.
- *Key occurrence identity on the per-run source UUID* — **rejected**: makes re-import create duplicate
  occurrences. The stable `source_key` makes `UNIQUE(item_id,source_id,source_ref)` actually idempotent.
- *`OFFSET`/`LIMIT` timeline paging* — rejected: skips/duplicates rows under concurrent inserts and at
  equal timestamps; keyset cursor chosen.
- *An ORM with auto-migrations (Drizzle/Prisma/TypeORM)* — rejected for a single-user local app; a tiny
  hand-written runner is simpler, fully inspectable, and avoids a heavy dep.
- *Store EXIF/source metadata as opaque JSON only* — rejected for queryable fields (date, type, GPS);
  raw per-occurrence fields are still kept as JSON in `item_occurrences.source_meta` for provenance.
- *Hash with SHA-1/MD5 (as some catalogs do)* — chose **SHA-256** for collision resistance on sensitive
  irreplaceable data.

**Consequences**
- ✅ "Nothing is silently dropped" holds even under dedup; the `Sources` provenance view is faithful.
- ✅ Fast browse/search at 10k–100k items; catalog is rebuildable from originals on disk.
- ✅ Undo is data-level and **lossless even for deduped memories**: remove a source's occurrences, drop
  items whose last occurrence is gone, and delete a content-addressed blob only when its **last**
  occurrence is removed — never touching in-place originals or source archives (AC-14).
- ✅ Re-import is idempotent (stable `source_key`); the timeline is stable under concurrent inserts
  (keyset); cross-source search survives dedup (search_meta re-denormalization).
- ⚠️ Forward-only migrations: schema rollback isn't supported in v1 (data-level undo is). Schema changes
  are HUMAN-REQUIRED and audited here.
- ⚠️ Per-occurrence text differences are not separately full-text-indexed in v1 (FTS indexes item-level
  `search_meta`, now the de-duplicated union of all occurrences' tokens); acceptable since media dedup is
  byte-identical and messages are 1:1 with items.

---

### ADR-0002: Extensible connector (importer) interface
**Date**: 2026-06-23
**Status**: Accepted
**Tier**: auto-with-audit (new internal module boundary — the extensibility contract).

**Context**
v1 ships five sources and the roadmap (M3) keeps adding more. MISSION §3/§4 and AGENTS §Code Style
require **isolated connector modules behind a common importer interface** so new sources are cheap and
the rest of the system stays source-agnostic.

**Decision**
Define one **`Importer`** interface (`electron/main/importers/types.ts`): `canHandle()` +
`import(): AsyncGenerator<CatalogRecord, ImportResult>` over the lifecycle **discover → parse →
normalize → emit**. Importers **emit normalized `CatalogRecord`s** and **do not write the DB** — the
ingestion worker persists them (clean seam). Sources register in a `registry.ts` keyed by `SourceType`.
Dependencies (`fs`, guarded `extractArchive`, `readExif`, `probeMedia`, `hashFile`) are **injected via
`ImporterDeps`** so importers are **unit-testable with fixture fs + fakes** — no real files or
subprocess. Partial failures call `ctx.onSkip(...)` and continue (AC-15); provenance is carried on
every record (`sourceRef`, `author`, `date`, `sourceMeta`) → persisted as `item_occurrences`. The
**parse** phase streams large exports (the Gmail `.mbox` is split message-by-message — ADR-0013).

**Alternatives considered**
- *A bespoke function per source wired ad-hoc into the UI* — rejected; no shared contract, untestable,
  duplicates extraction/metadata logic, and makes new sources expensive.
- *Plugin processes / dynamic loading* — over-engineered for v1's in-repo connectors; a typed registry
  is enough. (Revisit if third-party connectors are ever desired.)
- *Importers write to the DB directly* — rejected; coupling importers to persistence defeats the DI
  testing seam and the "emit records" purity.

**Consequences**
- ✅ Adding a source = implement `Importer` + register + fixtures + one AC; no other layer changes.
- ✅ Importers are unit-testable in isolation against fixtures (AGENTS §Code Style "DI for importers").
- ✅ Uniform provenance + partial-failure handling across all sources.
- ⚠️ Per-source quirks (WhatsApp locale formats, Facebook mojibake, Takeout sidecars) live inside each
  module; the shared contract must stay minimal to avoid leaking source-specifics upward.

---

### ADR-0001: Application shell — Electron + React + Vite + Tailwind (main / preload / renderer)
**Date**: 2026-06-23
**Status**: Accepted
**Tier**: auto (the pre-authorized §3 stack; reversible architecture).

**Context**
MISSION §3 fixes the stack: a cross-platform (macOS + Windows) **local desktop app** in **TypeScript
(strict)** with **Electron + React + Vite + Tailwind**, no backend. MISSION §3 also records the
deliberate evaluation of **Tauri v2** and the choice of Electron. We need a concrete process/build
structure to implement against.

**Decision**
Three Electron processes: **main** (Node, full privilege — fs/DB/subprocess/security), **preload**
(the sole `contextBridge` bridge), **renderer** (sandboxed React 18 + Vite + Tailwind v4, pure UI).
Build with **`electron-vite`** (one config for the main/preload/renderer triple; renderer HMR);
**ESM** throughout; **pnpm**. Tests: **Vitest** (unit/integration) + **Playwright** (e2e + the AC-4
Chromium harness + visual verification). Renderer is organized by **feature**; `electron/main` by
**responsibility**; shared DTOs/channel constants in `shared/`.

**Alternatives considered**
- *Tauri v2 (Rust + system WebView)* — leaner/tighter, but **rejected in MISSION §3** for autonomous-
  fleet velocity, the day-one JS ingestion ecosystem (`exifr`, `yauzl`, mail/chat parsers), and proven
  large-local-data performance. Revisit only if footprint/security outweigh those.
- *Three separate Vite configs vs `electron-vite`* — chose `electron-vite` (cleaner main/preload/
  renderer handling + HMR), per the cataloging research.
- *CommonJS* — rejected; ESM is the modern default and matches AGENTS (ESM).

**Consequences**
- ✅ A familiar, well-supported shell with a fast renderer dev loop and a huge ingestion ecosystem.
- ✅ Clear process boundaries that make the sandbox + zero-egress model enforceable (ADR-0005).
- ⚠️ Electron's larger binary footprint vs Tauri (accepted trade-off, MISSION §3).
- ⚠️ Native module (`better-sqlite3`) requires per-arch rebuilds in packaging (handled in ADR-0007).
