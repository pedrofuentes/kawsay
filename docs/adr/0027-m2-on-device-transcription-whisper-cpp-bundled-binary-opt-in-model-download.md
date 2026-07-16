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
