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
     001_initial.sql:69; partial `idx_items_gps`), reverse-geocoded **with a bundled offline gazetteer** (PRD §7,
     MISSION §5: "no online maps").
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
