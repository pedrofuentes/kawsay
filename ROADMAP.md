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
**Acceptance direction:** transcripts generated **fully offline** (bundled/on-device model — **no
cloud STT**, preserving **AC-4**); transcription runs **off the UI thread** (extends AC-9); transcript
text is **searchable** via the existing FTS index (extends AC-6/AC-7); resilient + non-destructive
(mirrors AC-15 / AC-14); multilingual coverage + a WER floor for Spanish and others. Now bound to the
concrete suite **AC-17 … AC-21** (PRD §4 M2 addendum).
**Architecture gate:** **ADR-0027** (whisper.cpp via a bundled `whisper-cli` binary + the `base`
multilingual `ggml` model on the F3c worker/ffmpeg seam; **bundle, never download**) — **status:
proposed, awaiting red-team + @pedrofuentes sign-off.**
**Authorization:** time-boxed **only while it stays on-device** — but ADR-0027 is **🚨 HUMAN-REQUIRED**
on two independent triggers: a **heavy bundled dependency** (a native binary + a 142–466 MiB model that
~doubles–triples the installer) **and** **privacy-data capability** (a deceased person's voice → stored,
searchable text). Any approach needing a network model download or cloud inference is **human-required**
(egress) and breaks the privacy story.

**Increment breakdown (proposed build cards — seed the board on approval, TDD per AGENTS.md):**
1. **M2-0 · Model-choice spike (red-team input).** Validate `base` (142 MiB) vs `small` (466 MiB) vs a
   quantized `q5_0` variant on **real Spanish WhatsApp-style voice notes**; recommend the bundled model
   + WER ceiling. *Answers the cofounder's "too heavy?" empirically; gates M2-1's model pick.*
2. **M2-1 · Engine + model packaging.** Bundle the per-arch `whisper-cli` binary + chosen `ggml` model
   via `electron-builder` `extraResources`/`asarUnpack` (macOS arm64+x64, Windows x64), resolved through
   `process.resourcesPath`; **no download path**; packaging-config drift test (mirrors
   `tests/unit/packaging-config.test.ts`). *(Extends ADR-0007/0023.)*
3. **M2-2 · Audio-extraction pipeline.** Extend the bundled-`ffmpeg` seam to decode any voice note/
   audio/video to **16 kHz mono PCM WAV** (array argv, `-protocol_whitelist file`, timeout, caps).
   *(Extends ADR-0004/0012.)*
4. **M2-3 · Transcription worker (off-thread).** A transcription job in the F3c harness
   (`worker_threads`/`utilityProcess`) that spawns `whisper-cli` as a sandboxed, fault-isolated
   subprocess; cooperative cancel + streamed progress. → **AC-18**. *(Reuses the coordinator/protocol.)*
5. **M2-4 · Transcript storage + FTS indexing.** Persist transcripts **attached to media items**, indexed
   into `items_fts`; **DB migration = HUMAN-REQUIRED**; dedup-with-provenance aware. → **AC-19**.
6. **M2-5 · UI: surface transcripts + search.** Read-only transcript on the audio/video item view (no
   auto-play, accessible), "transcribing…" status, search highlighting, non-technical copy. → **AC-13**.
7. **M2-6 · Perf/accuracy harness.** Offline labelled fixtures (Spanish + others); WER + RTF/throughput
   on macOS + Windows; lock **AC-21**/**AC-18** thresholds. *(No telemetry; CI fixtures.)*
8. **M2-7 · Zero-egress proof.** Extend the AC-4 harness to the transcription worker + `whisper-cli`
   subprocess; assert zero egress at install and runtime. → **AC-17**.

### M3 — More sources (new connectors) · **P2 · proposed**
**Scope:** Additional export/file connectors behind the same importer interface — **Telegram,
Messenger, Instagram, iMessage/SMS, Outlook/PST**, etc. (MISSION §4).
**Acceptance direction:** each connector imports its media + messages with correct dates into the
library (mirrors AC-1/AC-2/AC-11), extracts **safely** (must satisfy AC-3, AC-10), and **preserves
zero egress (AC-4)** and partial-import resilience (AC-15). One new AC per connector.
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
| **M2** — Audio & video transcription (on-device) | Phase 2 | P1 | time-boxed (if on-device) | proposed |
| **M3** — More sources (Telegram, Messenger, iMessage, PST…) | Phase 2 | P2 | time-boxed (per connector) | proposed |
| **M4** — AI categorization & smart search (on-device) | Phase 3 | P2 | time-boxed (human-required if model download) | proposed |
| **M5** — Family sharing (cloud) | Phase 3 | P3 | 🚨 **human-required** (backend / privacy-model change) | proposed (gated) |
| **M6** — Memorial outputs (timeline site, photo book) | Phase 3 | P3 | time-boxed local; human-required to publish | proposed |

> Priorities and phase groupings are **proposed** and subject to the red-team and to @pedrofuentes.
> M2 is called out as the **#1 post-v1 candidate** per MISSION §4.
