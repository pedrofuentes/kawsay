# ROADMAP — Kawsay

> **Phase-1 gate artifact**, subordinate to [`MISSION.md`](./MISSION.md) and paired with
> [`PRD.md`](./PRD.md). Milestones below replace the template scaffold with real, prioritized work.
> **M1 is the current MVP (in progress); M2–M6 are proposed/future.** Authored by the Product
> Manager sub-agent — **status: proposed, awaiting independent red-team.**

## Current phase

**Phase 1 — M1: Aggregate & Import Foundation (MVP).** Status: **in progress.** Acceptance is the
stable suite **AC-1 … AC-16** defined in [`PRD.md`](./PRD.md) §4 (AC-1 … AC-6 **restated /
semantically faithful — the MISSION §8 criteria elaborated into Given/When/Then, not renumbered or
weakened**). The remaining milestones are a proposed, prioritized backlog.

## How milestones are gated (MISSION §9)

- **Cumulative acceptance regression.** Every milestone must keep **all prior AC-n green** while
  adding its own. The local-only / zero-egress promise (**AC-4**) and the safe-extraction guarantees
  (**AC-3, AC-10**) may never be weakened (MISSION §5, NEVER list).
- **Authorization tier per milestone.** Advancing to the **next milestone within this approved
  roadmap** is **time-boxed** (proposed on the board; auto-proceeds after 24h if unobjected). Any
  milestone that would **add network egress, a backend, accounts, or sync is `human-required`** and
  blocks until @pedrofuentes approves — this explicitly includes **M5**, plus any model-download in
  **M4** and any online publishing in **M6** (MISSION §9 project override).

## Milestones

### M1 — Aggregate & Import Foundation (MVP) · **P0 · in progress**
**Scope:** Make it dead-easy for a non-technical person to pull a loved one's memories out of many
**exports/files** (no live logins) into one private local library — generic folder / cloud-download
import, WhatsApp, Google Takeout, Facebook, LinkedIn — on an extensible connector architecture, with
browse/timeline + basic search and a non-technical-first, fully-offline UX.
**Acceptance:** **AC-1 … AC-16** (PRD §4) pass cumulatively — incl. WhatsApp end-to-end (AC-1),
folder photos/videos with dates + thumbnails (AC-2), safe archive extraction (AC-3, AC-10), **proven
zero egress (AC-4)**, macOS + Windows build to GitHub Releases (AC-5), timeline + search (AC-6, AC-7,
AC-8), off-thread ingestion (AC-9), **Facebook/LinkedIn content correctness (AC-16)**, accessibility
(AC-13), originals preserved (AC-14).
**Authorization:** in-flight (current milestone). CI **build/packaging is `auto`**, but the **first
production publish of each release is HUMAN-REQUIRED** — gated by a **protected GitHub Environment with
required reviewers** (MISSION §9). v1 installers ship **unsigned** (signing deferred, MISSION §2).

### M2 — Audio & video transcription · **P1 (top post-v1 candidate) · proposed**
**Scope:** Transcribe WhatsApp voice notes and video/audio **on-device** so a user needn't listen to
or watch every recording — searchable, readable transcripts attached to each media item (MISSION §4,
"the #1 candidate").
**Acceptance direction:** transcripts generated **on-device** (the `whisper-cli` binary is bundled and
the multilingual **`small`** model is **downloaded once on opt-in** — **no cloud STT**; **user memories
never leave the machine**, preserving **AC-4**); transcription runs **off the UI thread** (extends AC-9);
transcript text is **searchable** via the existing FTS index (extends AC-6/AC-7); resilient +
non-destructive incl. long media (mirrors AC-15 / AC-14); multilingual coverage + a WER floor; **explicit
opt-in** (which also gates the download); **model-download integrity/resilience**; **NOTICES/attribution**
for the bundled binary + downloaded weights. Now bound to the concrete suite **AC-17 … AC-24** (PRD §4 M2
addendum).
**Architecture gate:** **ADR-0027** (whisper.cpp via a **bundled** `whisper-cli` binary + an **opt-in,
on-demand, checksum-verified download** of the multilingual **`small`** `ggml` model on the F3c
worker/ffmpeg seam — **binary bundled; model downloaded on opt-in**) — **status: proposed; the cofounder
locked model=`small` / policy=opt-in / delivery=download, and a final confirm of the pinned host(s) + exact URL +
checksum + scoped-allowlist mechanism is pending.**
**Authorization:** time-boxed **only while user data stays on-device** — and it does (transcription is
100% local; memories never leave). ADR-0027 is **🚨 HUMAN-REQUIRED** on **three** triggers: a **heavy
dependency** (a native binary + a ~466 MiB model), **privacy-data capability** (a deceased person's voice
→ stored, searchable text), **and a new product-runtime egress** — the opt-in model download narrows the
§5 product allowlist from "None" to **exactly one** pinned, **data-free** host (cloud inference, or any
egress of user data, remains **never**).

**Increment breakdown (proposed build cards — seed the board on approval, TDD per AGENTS.md):**
1. **M2-0 · Model-validation spike (red-team input).** With **`small` locked**, validate it on **real
   Spanish WhatsApp-style voice notes** and **set the AC-21 WER ceiling** (a quantized `q5_0` `small` may
   be measured as an optional footprint optimization). *Confirms `small` clears the floor; no longer a
   `base`-vs-`small` choice.*
2. **M2-1 · Model download manager + integrity + consent/opt-in UX + scoped egress (+ binary packaging,
   provenance/NOTICES).** **Publish first (prerequisite — chicken-and-egg):** nothing publishes `ggml-small.bin`
   today (`release.yml` ships only installers), so **before** the downloader can fetch it, a manual or small
   human-gated step must **fetch upstream `ggml-small.bin` → verify `sha256==1be3a9b2…fffea987b` & `size==487,601,967`
   → publish a `models-v1` GitHub Release asset with NOTICES**, gated by a **publish-time `hash==pinned` check**
   (ADR-0027 Decision 6e / AC-23). Then build the **main-process model downloader**: an **opt-in/consent screen**
   gating any fetch (one-time ~466 MB; "the only time the app uses the network"; "your memories never leave");
   **SHA-256 verify-before-use + re-verify before each `whisper-cli` spawn** (hard-coded `1be3a9b2…fffea987b`);
   **atomic** install (temp→verify→rename); **resumable** (incl. re-requesting the origin when a **signed-CDN URL
   expires** on resume); corrupt→reject+refetch; graceful **offline/retry**; disk-full/second-instance handled;
   feature disabled until present → **AC-22/AC-24**. Issue the fetch via **Electron `net.request` on the guarded
   session** and add the **single exact-URL allowlist entry to `network-guard.ts`'s `webRequest` policy** (method
   `GET` + the exact pinned URL(s) + empty body — origin **+ redirect/CDN target** `{github.com,
   release-assets.githubusercontent.com}` or HF `{huggingface.co, *.cdn.hf.co}`; **not** a host-only match, **not**
   a Node-primitive downloader; renderer CSP unchanged) **+** the matching **AC-4 harness** edits (the OS firewall in
   `ac4-egress.yml`; the **Node in-process spies stay deny-all** and do not observe the Chromium-stack download; a
   `network-guard` exact-URL unit test) → **🚨 HUMAN-REQUIRED** (egress policy + harness integrity). Still **bundle
   the per-arch `whisper-cli` binary** (built-from-source-in-CI, P1) via `electron-builder`
   `extraResources`/`asarUnpack`, resolved through `process.resourcesPath`; ship **license attribution/NOTICES** for
   the bundled binary + **downloaded** weights with provenance → **AC-23**; packaging-config + allowlist drift
   tests. *(Extends ADR-0007/0023; supersedes the prior bundle-the-model packaging plan.)*
3. **M2-2 · Audio-extraction pipeline.** Extend the bundled-`ffmpeg` seam to decode any voice note/
   audio/video to **16 kHz mono PCM WAV** (array argv, `-protocol_whitelist file`, timeout, caps).
   *(Extends ADR-0004/0012.)*
4. **M2-3 · Transcription worker (off-thread) + long-media.** A transcription job in the F3c
   `worker_threads` harness that spawns `whisper-cli` as a sandboxed, fault-isolated subprocess; streamed
   progress; **duration-scaled timeout/chunking with partial/checkpoint** (the reused spawn seam hard-caps
   children at 30 s) and **child-kill on cancel** (the import worker's *between-records* cancel does not stop
   a long child mid-file). → **AC-18/AC-20**. *(Reuses the *seam*, not the import queue.)*
5. **M2-4 · Transcript storage + FTS indexing (net-new queue).** A **net-new** per-item drain — a
   `transcript_status` column on `items` analogous to `thumb_status` — persisting transcripts **attached to
   media items** and feeding the FTS-synced `search_meta` (or a dedicated FTS column); the external-content
   `items_fts` column change is a **drop+rebuild over the catalog** (not a cheap `ALTER`). **DB migration =
   HUMAN-REQUIRED**; dedup-with-provenance aware. → **AC-19**.
6. **M2-5 · UI: surface transcripts + search (+ per-item control).** Read-only transcript on the
   audio/video item view (no auto-play, accessible), "transcribing…" status, search highlighting,
   non-technical copy, and **per-item** control; **nothing auto-transcribes silently**. (The first-run/global
   **opt-in + download-consent** screen is delivered in M2-1.) → **AC-13/AC-22**.
7. **M2-6 · Perf/accuracy harness.** Offline labelled fixtures (Spanish + others); WER + RTF/throughput
   on macOS + Windows; lock **AC-21**/**AC-18** thresholds. *(No telemetry; CI fixtures.)*
8. **M2-7 · Zero-egress proof — user data everywhere; one allowed exact-URL `GET` (net-new harness · 🚨 HUMAN-REQUIRED).**
   Stand up a **macOS + Windows OS-deny egress harness that exercises the *real* `whisper-cli` binary** and
   asserts **zero user-data egress everywhere** (the in-process **Node** spies cover **main-process Node outbound
   only**; the existing OS-deny firewall is **Linux-only** and Kawsay ships no Linux target). Assert the **only**
   permitted outbound anywhere is the **data-free `GET` to the exact pinned model URL** (method + URL + empty body;
   origin **+ its redirect/CDN host** — `{github.com, release-assets.githubusercontent.com}` or HF `{huggingface.co,
   *.cdn.hf.co}`), asserted at the **`webRequest` allowlist + the OS firewall** (the model download uses Electron
   `net.request` over Chromium's stack, so the **Node spies do not observe it** — they stay deny-all); everything
   else still trips. Because it **edits `.github/workflows/ac4-egress.yml`** + the `network-guard`
   allowlist, it is **🚨 HUMAN-REQUIRED** (harness integrity, MISSION §9) — the same gate as M2-4's DB
   migration. The static/packaging half of AC-17 lands earlier (M2-1). → **AC-17 (+ AC-24's egress assertion).**

### M3 — More sources (new connectors) · **P2 · proposed**
**Scope:** Additional export/file connectors behind the same importer interface — **Telegram,
Messenger, Instagram, iMessage/SMS, Outlook/PST**, etc. (MISSION §4).
**Acceptance direction:** each connector imports its media + messages with correct dates into the
library (mirrors AC-1/AC-2/AC-11), extracts **safely** (must satisfy AC-3, AC-10), and **preserves
zero egress (AC-4)** and partial-import resilience (AC-15). One new AC per connector.
First slice: **AC-25** adds a read-only macOS Messages `chat.db` iMessage/SMS connector for message
text/sender/date provenance plus linked attachments. Next slice: **AC-26** adds a Telegram Desktop
`result.json` connector for messages plus photo/video/voice file refs; full multi-account `chats/`
nesting and service-message semantics are follow-ups.
**Authorization:** time-boxed per connector (export/file-based, reversible) — no new egress.

### M4 — AI categorization & smart search · **P2 · proposed**
**Scope:** Automatic grouping (people, places, themes), smarter/semantic search, and suggested
collections (MISSION §4).
**Acceptance direction:** categorization and inference run **on-device** (preserve **AC-4**); results
are explainable and **user-correctable**; smart search extends AC-7 without regressing exact search.
New ids **AC-1x**.
**Authorization:** time-boxed **only if** models are bundled/on-device. **Any model download or cloud
API is `human-required`** (network egress — MISSION §9 override).

### M5 — Family sharing (cloud) · **P3 · 🚨 HUMAN-REQUIRED — proposed, gated**
**Scope:** Let a user share the archive (or parts of it) with family — the realization of the "one day
share with family" vision (MISSION §1, §4).
**⚠️ Changes the privacy model.** This introduces a **backend / sync / accounts / external origin** and
moves user memory data off the device — it **cannot proceed without an explicit @pedrofuentes
human-required approval** and a redesign of the §5 privacy guarantees (MISSION §5, §9). It must **not**
silently weaken **AC-4**; instead AC-4's scope would be **renegotiated under a new, opt-in,
explicitly-consented sharing model** with its own security review (auth/crypto/PII = human-required).
**Acceptance direction:** defined **only after** the gated approval and privacy-model ADR; new
explicit-consent + encryption ACs.
**Authorization:** **human-required (blocks).** Listed here for transparency, not pre-approved.

### M6 — Memorial outputs (timeline site, photo book) · **P3 · proposed**
**Scope:** Generate shareable keepsakes — a **timeline website** and a printable **photo book** — from
the archive (MISSION §4).
**Acceptance direction:** outputs are **generated locally to disk** (static site folder / PDF) with **no
network egress** (preserves **AC-4**); faithful to catalogued originals (AC-14). New ids **AC-2x**.
**Authorization:** generating local files is time-boxed; **publishing/uploading** any output online is
**human-required** (egress).

## Key milestones

| Milestone | Phase | Priority | Authorization tier | Status |
|-----------|-------|----------|--------------------|--------|
| **M1** — Aggregate & Import Foundation (MVP) | Phase 1 | P0 | in-flight | **in progress** |
| **M2** — Audio & video transcription (on-device; model downloaded on opt-in) | Phase 2 | P1 | 🚨 **human-required** (heavy dep · privacy · opt-in model egress) | proposed |
| **M3** — More sources (Telegram, Messenger, iMessage, PST…) | Phase 2 | P2 | time-boxed (per connector) | proposed |
| **M4** — AI categorization & smart search (on-device) | Phase 3 | P2 | time-boxed (human-required if model download) | proposed |
| **M5** — Family sharing (cloud) | Phase 3 | P3 | 🚨 **human-required** (backend / privacy-model change) | proposed (gated) |
| **M6** — Memorial outputs (timeline site, photo book) | Phase 3 | P3 | time-boxed local; human-required to publish | proposed |

> Priorities and phase groupings are **proposed** and subject to the red-team and to @pedrofuentes.
> M2 is called out as the **#1 post-v1 candidate** per MISSION §4.
