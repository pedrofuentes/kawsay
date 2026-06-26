# PRD — Kawsay

> **Phase-1 gate artifact.** This Product Requirements Document is **subordinate to
> [`MISSION.md`](./MISSION.md)**, which is the binding spec. Where any wording here appears to
> diverge from MISSION, MISSION wins. Acceptance criteria **AC-1 … AC-6 are restated / semantically
> faithful — the MISSION §8 criteria elaborated into Given/When/Then, not renumbered or weakened** —
> and are the canonical, stable test suite; finer-grained criteria are added as **AC-7+** without
> renumbering the canonical set.
>
> **Authored by:** Product Manager sub-agent. **Status:** proposed — awaiting independent red-team
> before the gate passes. **Synthesized from** the four discovery research reports (grief-tech UX,
> export formats, security/Electron hardening, cataloging/packaging) referenced in §9.

---

## 1. Problem statement & vision

When someone dies, the evidence of their life is scattered across a dozen apps and accounts —
WhatsApp threads, phone photo rolls, cloud drives, email, social exports. Gathering it (listening to
every voice note, watching every video, reading every document) is overwhelming, technical, and
emotionally heavy, and it usually falls to a grieving, **non-technical, often older** family member
under time pressure (accounts get closed; devices get wiped). (MISSION §1.)

**Vision.** Anyone who loses someone can, **in an afternoon and without any technical skill**, bring
their loved one's memories into **one private, beautiful archive** they can revisit — and one day
share with family — turning a months-long, painful technical chore into a healing act of
remembrance. The archive lives **entirely on the user's own computer**; a loved one's memories must
never leave the machine. (MISSION §1, §5.)

**What Kawsay v1 is.** A warm, calm, fully-offline **desktop application** (Electron, macOS +
Windows) that imports memories from **exports and files** — no live account logins — into one local
library: originals preserved on disk plus a searchable SQLite catalog, built on an **extensible
connector architecture** so the list of sources keeps growing. (MISSION §2, §3, §4.)

---

## 2. Personas

### 2.1 Primary — "Elena," 64, the **gatherer** (non-technical, grieving)

The person doing the work. Recently lost her husband. Comfortable with WhatsApp and a phone camera;
not comfortable with "files," "folders," "export," or "metadata." She has his laptop, his phone, and
the passwords to a couple of his accounts. She may be using Kawsay while crying.

- **Goals:** Bring his messages, photos, and **voice notes** into one private place; *not lose
  anything*; feel she is honoring him; do it **without asking anyone for help**.
- **Fears:** Deleting or breaking something irreversible; the memories **leaking onto the internet**;
  being rushed; jargon that makes her feel stupid; running out of time before accounts are closed.
- **Emotional context:** Grief narrows working memory even in capable people; ~86% of people over 40
  need reading glasses and older users have reduced contrast sensitivity, tremor, and lower tolerance
  for small targets and stacked decisions (research: `ux.md` §3.1). She needs plain language, large
  type and targets, visible progress, reassurance that nothing leaves her computer, and a "you can
  always come back to this" escape hatch at every step (research: `ux.md` §1.4, §3.3–§3.5).
- **Design implications → ACs:** guided WhatsApp walkthrough and Browse-first flow (**AC-12**),
  accessibility essentials (**AC-13**), resilient/never-silently-dropping imports (**AC-15**),
  originals never altered (**AC-14**), proven zero egress she can trust (**AC-4**).

### 2.2 Secondary — "Mateo," 32, the **inheritor** (family recipient, more technical)

Elena's son. Not the primary operator in v1, but the person the archive is ultimately *for*: the
family member who may **later receive and one day share** it (MISSION §1; family sharing is a gated
post-v1 milestone — see ROADMAP M5).

- **Goals:** Trust that the archive is **complete and faithful** (no silently dropped items), that
  **originals are preserved on disk** in open formats (not trapped in a proprietary blob), and that
  it stays private and portable.
- **Fears:** Lock-in; data loss; a future privacy breach if sharing is ever added carelessly.
- **Emotional context:** Also grieving; values durability and that "this is a gift to the family,"
  not a data product (research: `ux.md` §1.1).
- **Design implications → ACs:** originals-on-disk + undo without data loss (**AC-14**), faithful
  catalog of every source (**AC-1, AC-2, AC-3, AC-11**), local-only guarantee (**AC-4**).

### 2.3 The data subject — the deceased loved one (not a user, but the duty of care)

The memories are the **extremely sensitive personal data of a person who can no longer consent**.
Kawsay's deliberate **export/file** model avoids ever holding the deceased's *live* credentials, and
the local-only invariant keeps their data on one machine. (MISSION §5.) This duty of care motivates
the security NFRs (§6.4) and **AC-4**.

---

## 3. MVP (M1) feature set — "aggregate & import foundation"

v1 makes it dead-easy for a non-technical person to pull a loved one's memories out of many sources,
**via exports/files (no live logins)**, into one private local library, on an extensible connector
architecture (MISSION §4). Each connector is an isolated module behind a common importer interface
(research: `formats.md` "Connector Architecture Mapping"; AGENTS.md Code Style).

### (a) Generic folder / cloud-download import
Import any folder of **photos and videos** (recursive), including **already-downloaded** content from
iCloud Drive, OneDrive, Dropbox, Google Drive, and local/external disks. (This imports downloaded
files — **not** live cloud APIs, which would require OAuth + network egress and are out of scope,
§7.) Type detection by extension + magic bytes (`file-type`); capture date from EXIF
`DateTimeOriginal` with documented fallbacks; thumbnails generated for every item (research:
`formats.md` §5, `catalog-pkg.md` §3). → **AC-2, AC-9, AC-14.**

### (b) WhatsApp "Export Chat" import
Guided import of a WhatsApp export `.zip` covering **text, photos, voice notes/audio (`.opus`), and
video**, parsing the locale-dependent `_chat.txt` and correlating co-located media by filename
(research: `formats.md` §1). Includes a **hand-holding "how to export from WhatsApp" walkthrough**
shown before the file picker (research: `ux.md` §4.2). → **AC-1, AC-12.**

### (c) Archive imports — Google Takeout, Facebook, LinkedIn — extracted **safely**
- **Google Takeout:** Gmail `.mbox` (streaming parse) and Google Photos (sidecar
  `.supplemental-metadata.json` as authoritative date/GPS) → **AC-11**; **Drive-exported loose files**
  (the photos, videos, and documents Takeout writes out as ordinary files) are catalogued by the
  **generic folder importer** → **AC-2** (research: `formats.md` §2).
- **Facebook "Download Your Information"** (JSON; apply the `latin1→utf8` mojibake fix; posts in
  seconds, messages in ms) and **LinkedIn "Get a copy of your data"** (CSVs + any media) — their
  posts, messages, photos, and connections are catalogued with **correct text, timestamps, and media
  linkage** (research: `formats.md` §3–§4). → **AC-16.**
- **All** extraction is **zip-slip / path-traversal guarded** and **decompression-bomb guarded**
  (research: `security.md` Topic 1). → **AC-3, AC-10.**

### (d) The one private local library
**Originals preserved on disk** (folder imports referenced in place; archive contents copied, never
moved or deleted) plus a **SQLite catalog** (`better-sqlite3`) recording source, date, type, media
path, EXIF/GPS, and source-specific metadata, with **SHA-256 content-addressed deduplication** — which
**records every source occurrence** of a deduplicated item (the same photo arriving from two sources is
stored **once** but its provenance from **both** is preserved; nothing is silently dropped) — and a
hand-written migration runner (research: `catalog-pkg.md` §2). → **AC-1, AC-2, AC-3, AC-11, AC-14.**

### (e) Browse / timeline + basic search
A **reverse-chronological timeline** grouped by month, **virtualized** for thousands of items
(`@tanstack/react-virtual`), with lazy-loaded thumbnails served over a local custom protocol; and
**basic search** via SQLite **FTS5** over message text, captions, and filenames, with metadata
filters (type, source, date) (research: `catalog-pkg.md` §4). → **AC-6, AC-7, AC-8.**

### (f) Non-technical-first UX (drag-drop, plain language, progress, fully offline)
Warm/reverent tone; plain language at a 6th–8th-grade level with **no jargon**; a **Browse… button
as the primary path** with drag-and-drop as an enhancement; **percent-done progress with a running
tally** ("37 messages… 3 photos found…"); instant emotional payoff (show the first memory on
completion); **no auto-play**, **reduced motion by default**, large targets, visible focus; and the
local-only promise surfaced in copy ("Your memories never leave this computer") (research: `ux.md`
§1, §2.5, §3, §4). Fully offline at runtime. → **AC-12, AC-13, AC-4.**

---

## 4. Acceptance criteria (bound to stable `AC-n` ids)

> **Baseline Definition of Done (MISSION §8, generic):** tests green, coverage ≥ 80%, lint/typecheck
> clean, Sentinel APPROVED/CONDITIONAL on every merge, README/LICENSE/CONTRIBUTING shipped, empty
> board. **The criteria below are the project-specific, cumulative acceptance regression** — checked
> on every PR and every milestone. **AC-1 … AC-6 are restated / semantically faithful — the MISSION §8
> criteria elaborated into Given/When/Then, not renumbered or weakened** (AGENTS.md NEVER §Integrity).
> Each is written as an executable, Given/When/Then test with its test kind.

### Canonical suite (MISSION §8 — do not renumber)

**AC-1 — WhatsApp export, end-to-end.** *(MISSION §8 AC-1)*
- **Given** a valid WhatsApp "Export Chat" `.zip` containing `_chat.txt` plus photos, voice
  notes/audio (`.opus`), and video,
- **When** a non-technical user imports it through the guided flow,
- **Then** every message, photo, voice note/audio, and video appears as a catalogued item in the
  library, attributed to its sender and dated from the chat timestamps.
- **Test kind:** integration (importer vs. fixture `.zip`) **+** e2e (full guided flow).

**AC-2 — Photos & videos from a folder.** *(MISSION §8 AC-2)*
- **Given** a folder (incl. an iCloud / OneDrive / Dropbox / Google Drive download), possibly nested,
  containing photos and videos,
- **When** the user imports the folder,
- **Then** each item is catalogued with the **correct capture date** (EXIF `DateTimeOriginal`
  preferred; documented fallbacks `CreateDate` → filename pattern → file mtime) and a **generated
  thumbnail**.
- **Test kind:** integration.

**AC-3 — Documents/archives import safely (no zip-slip).** *(MISSION §8 AC-3)*
- **Given** an untrusted archive (Google Takeout, Facebook, or LinkedIn `.zip`), **including** one
  crafted with `../` path-traversal and absolute-path entries,
- **When** Kawsay extracts it,
- **Then** **no file is ever written outside** the designated extraction directory, and the malicious
  archive is rejected with a **stable, assertable error code `ERR_ARCHIVE_UNSAFE_PATH`** (a message key
  the test can observe) surfaced to the user as a **clear, non-technical** message.
- **Test kind:** unit (extractor vs. adversarial fixtures) **+** integration.

**AC-4 — Local-only proven (zero network egress).** *(MISSION §8 AC-4)*
- **Given** the app performing any **import or browse/search** action,
- **When** the action runs under test,
- **Then** an automated test observing Node `http`/`https`/`net` (e.g. `nock.disableNetConnect()` +
  a `net.createConnection` spy) **and** Chromium networking (Playwright `page.route`) records
  **zero** outbound connections.
- **Test kind:** integration **+** e2e. *(This is a core, tested promise; it may never be weakened —
  MISSION §5, NEVER list.)*

**AC-5 — Builds & launches on macOS and Windows, published to GitHub Releases.** *(MISSION §8 AC-5)*
- **Given** the release pipeline on a tagged build,
- **When** CI runs on **macOS and Windows native runners** (per-arch, because `better-sqlite3` is a
  native module),
- **Then** it produces installable artifacts (`.dmg`/`.zip` for macOS, NSIS `.exe` for Windows)
  **published to GitHub Releases**, and a smoke test **launches** the packaged app to a ready window.
  *(v1 ships unsigned; code-signing/notarization is a later gated step — MISSION §2.)*
- **Release gate:** CI **build/packaging is `auto`**, but the **first production publish of each
  release is HUMAN-REQUIRED** — the publish job runs in a **protected GitHub Environment with required
  reviewers**, blocking until @pedrofuentes approves (MISSION §9).
- **Test kind:** CI build **+** e2e smoke launch.

**AC-6 — Browse/timeline + basic search display memories correctly.** *(MISSION §8 AC-6)*
- **Given** a library with imported memories,
- **When** the user opens the timeline and runs a basic search,
- **Then** memories display correctly in a reverse-chronological timeline grouping, and search shows
  the expected matching subset.
- **Test kind:** e2e.

### Finer-grained additions (AC-7+ — augment, never replace, the canonical suite)

**AC-7 — Search precision (splits the *search* half of AC-6).**
- **Given** a catalog with known message text, captions, and filenames,
- **When** the user searches a term and optionally filters by **type / source / date range**,
- **Then** full-text (FTS5) matches are returned ranked, and filters narrow results to **exactly**
  the matching items (every seeded match present; no out-of-filter item returned).
- **Test kind:** integration.

**AC-8 — Virtualized timeline at scale (splits the *timeline* half of AC-6; performance).**
- **Given** a library of **≥ 10,000** items,
- **When** the timeline is displayed and scrolled,
- **Then** the DOM holds only a **bounded/virtualized window** whose mounted-node count stays under a
  fixed cap and **does not grow with item count** (assert the rendered-row count at 10,000 items equals
  the count at 1,000 items, within the window + overscan), and scrolling sustains **≥ 55 fps with no
  main-thread long-task > 50 ms** (assert via the Performance / long-task API in the perf harness).
- **Test kind:** e2e / performance.

**AC-9 — Heavy ingestion & thumbnails run off the UI thread (performance).**
- **Given** an import of many media files,
- **When** parsing, hashing, EXIF extraction, and thumbnail generation run,
- **Then** that work executes **off the UI thread** (`worker_threads` / an `ffmpeg`-`ffprobe`
  subprocess) — asserted by observing the work occurs **off-main-thread** — and **no main-thread task
  exceeds 50 ms** for the duration of the import (asserted via long-task instrumentation), keeping the
  renderer responsive while progress is streamed to the UI.
- **Test kind:** integration / performance.

**AC-10 — Decompression-bomb & malicious-archive rejection (security; beyond AC-3 zip-slip).**
- **Given** a malicious archive that is a **decompression bomb** (excessive compression ratio, total
  uncompressed size, or entry count) **or** contains **symlink** entries,
- **When** Kawsay inspects it,
- **Then** extraction is **aborted before exhausting resources**, no symlink is materialized, the
  per-entry/total/ratio/count caps are enforced, and the failure surfaces a **stable, assertable error
  code `ERR_ARCHIVE_BOMB`** (a message key the test can observe) shown to the user as a **clear,
  non-technical** refusal.
- **Test kind:** unit **+** integration.

**AC-11 — Google Takeout content import (Gmail `.mbox` + Google Photos).**
- **Given** a Takeout export with a Gmail `.mbox` and a Google Photos tree with sidecar
  `.supplemental-metadata.json`,
- **When** the user imports it,
- **Then** emails (with attachments) and photos are catalogued with **correct dates**
  (`photoTakenTime`/sidecar preferred; EXIF / mbox `Date` fallback), using **streaming** parses that
  do not load the whole `.mbox` into memory.
- **Test kind:** integration.

**AC-12 — WhatsApp how-to-export walkthrough + Browse-first flow (non-technical UX).**
- **Given** a first-time user choosing the WhatsApp source,
- **When** the guided import starts,
- **Then** a step-by-step "Export Chat" walkthrough is shown **before** the file picker, the
  **primary action is a "Browse…" button**, and drag-and-drop is offered only as an **optional
  enhancement** (never the sole path).
- **Test kind:** e2e.

**AC-13 — Accessibility essentials (WCAG 2.1 AA).**
- **Given** any primary screen (welcome, source picker, walkthrough, import progress, timeline, item
  view, search),
- **When** tested with **axe-core** and **keyboard-only** navigation under `prefers-reduced-motion`,
- **Then** the screen reports **no serious/critical axe violations**, is fully keyboard-operable with
  a **visible focus indicator**, motion is reduced to opacity/instant, and **no audio/video
  auto-plays**.
- **Test kind:** e2e (axe + Playwright).

**AC-14 — Originals preserved; undo without data loss (data integrity).**
- **Given** memories imported from a folder and from an archive,
- **When** the import completes and is later **undone**,
- **Then** folder-import originals remain **byte-identical in place**, archive-import **copies** are
  added without altering or deleting the source archive, and **undo** removes catalog entries (and
  Kawsay-generated copies/thumbnails) **without touching any original source file**.
- **Test kind:** integration.

**AC-15 — Resilient partial import (never silently drop items).**
- **Given** an import where some files are unreadable or corrupt,
- **When** the import runs,
- **Then** the remaining valid items are catalogued, the import **does not abort**, and the user is
  shown a **count of skipped items** — items are never silently dropped.
- **Test kind:** integration.

**AC-16 — Facebook DYI + LinkedIn import (content correctness).**
- **Given** a real-shaped Facebook **"Download Your Information"** export (JSON, **including the
  `latin1→utf8` mojibake cases**) and a LinkedIn **"Get a copy of your data"** export (CSVs + any
  media),
- **When** the user imports each,
- **Then** their **posts, messages, photos, and connections** appear in the catalog with **correct
  text (no mojibake), correct timestamps, and correct media linkage** — asserting **specific item
  counts and field values** against the fixtures (research: `formats.md` §3–§4).
- **Test kind:** integration.

### M2 acceptance addendum (AC-17 … AC-24 — on-device transcription, **post-v1 / proposed**)

> **Scope:** these criteria belong to ROADMAP **M2 (audio & video transcription)**, not the M1 MVP. They are
> **proposed**, bound to the M2 architecture gate (**ADR-0027**), and **🚨 HUMAN-REQUIRED** (heavy dependency +
> privacy-data capability + a new, scoped network egress) — they activate **only after** @pedrofuentes signs off on
> ADR-0027. They **augment, never replace** the canonical suite and **must keep AC-1 … AC-16 green** (cumulative
> acceptance regression). The zero-egress promise (**AC-4**) for **user data / memories stays absolute and is never
> weakened**; per the cofounder's locked decision it is **narrowed** to permit **exactly one** outbound — an opt-in,
> checksum-verified, data-free **model download** from a single pinned host (AC-17 + the new **AC-24**).

**AC-17 — Voice notes / audio / video transcribed fully on-device; user memories never egress.**
- **Given** a WhatsApp voice note (`.opus`), an audio file, or a video with an audio track, with the `whisper-cli`
  binary **bundled in the installer** and the `small` model **fetched once on opt-in and verified** (ADR-0027 / the
  new AC-24),
- **When** transcription runs **at runtime** on the user's audio,
- **Then** the transcript is produced **entirely on-device** and **no user audio, memory, or derived transcript
  ever leaves the machine** — and **transcription itself makes ZERO network calls** — asserted in **two parts**:
  - **(a) Static / packaging guarantee (provable now):** the binary ships in the installer; there is **no
    network-capable code on the transcription path**; transcription reads local files only (array-argv paths, never
    URLs); the renderer CSP (`connect-src 'none'`) is **unchanged**. The runtime guard (`network-guard.ts`) denies
    all egress **except** the single pinned, data-free **model-download** host (the only permitted app egress
    anywhere — ADR-0027 Decision 6d), which is **not** on the transcription path.
  - **(b) Runtime egress assertion (net-new harness):** the **real** `whisper-cli` subprocess is exercised under an
    **OS-level deny firewall** and records **zero** egress. The existing in-process `net`/`dgram`/`dns` spies prove
    the **main process only** and **cannot observe a separate OS process**, and the existing OS-deny firewall is
    **Linux-only** (`ac4-egress.yml` is `runs-on: ubuntu-latest`) while Kawsay ships **macOS arm64/x64 + Windows
    x64** — so a macOS/Windows OS-deny harness around the real binary is **net-new work** (M2-7, HUMAN-REQUIRED: it
    edits the AC-4 CI workflow). *(The prior claim that the existing harness "already covers the subprocess and
    extends directly" is withdrawn.)*
- **Test kind:** integration (static packaging checks) **+** the net-new OS-deny egress harness. *(Extends AC-4 —
  whose user-data zero-egress promise may never be weakened; MISSION §5, NEVER list. A **cloud-STT** approach fails
  this AC by definition — it ships the user's voice off-device. The **opt-in model download** is the one permitted,
  data-free egress and is asserted by **AC-24**, not a violation of this AC.)*

**AC-18 — Transcription runs off the UI thread (performance).**
- **Given** a batch of recordings queued for transcription,
- **When** audio extraction (`ffmpeg`) and inference (`whisper-cli`) run,
- **Then** that work executes **off the UI thread** (the F3c `worker_threads` harness + a bounded subprocess) —
  asserted by observing the work occurs **off-main-thread** — and **no main-thread task exceeds 50 ms** for the
  duration, keeping the renderer responsive while progress is streamed.
- **Test kind:** integration / performance. *(Extends AC-9.)*

**AC-19 — Transcript text is searchable via FTS.**
- **Given** items whose audio/video has been transcribed,
- **When** the user searches a word or phrase **spoken** in a recording, optionally filtered by type / source /
  date,
- **Then** the matching item is returned by the **existing FTS5 search** (the transcript is indexed into
  `items_fts` via the FTS-synced `search_meta` column — or a dedicated FTS-synced column — **not** the
  message-body `description`), ranked, with filters narrowing **exactly** to matching items — and the transcript is
  **attached to the existing media item**, never a duplicate item.
- **Test kind:** integration. *(Extends AC-6 / AC-7.)*

**AC-20 — Resilient, non-destructive transcription incl. long media (never silently drop; originals untouched).**
- **Given** a transcription run where some recordings are unreadable, corrupt, silent, or in an unsupported
  language — **and where some are multi-minute (long)** — and where the run may be **cancelled** or **re-run**,
- **When** transcription proceeds,
- **Then** each failed/empty item is **skipped and reported with a status** (the user sees a count), the run **does
  not abort**, remaining items still transcribe, **re-running does not duplicate** transcripts, and **no original
  media file is ever altered or deleted** (transcripts and any derived audio are Kawsay-generated only); **long
  recordings are not killed by the 30 s import-spawn cap** — they use a **duration-scaled timeout or chunking** with
  **partial/checkpoint** output — and **cancelling a single in-flight transcription kills the `whisper-cli` child**
  (the import worker's cooperative *between-records* cancel does not stop a long child mid-file).
- **Test kind:** integration. *(Mirrors AC-15; honours AC-14. The transcription queue is a **net-new** per-item
  drain analogous to `thumb_status`, not a verbatim reuse of the import worker — ADR-0027.)*

**AC-21 — Multilingual coverage + accuracy floor (Spanish + others).**
- **Given** a labelled offline fixture set of short, WhatsApp-style voice notes in **Spanish and other languages**,
- **When** transcribed with the **multilingual `small` model** (no `.en` variant; downloaded on opt-in),
- **Then** the spoken language is **auto-detected** and the transcript meets a **defined word-error-rate ceiling**
  on the fixture set — where the concrete WER threshold is **fixed empirically on real Spanish samples by the M2-0
  spike / M2-6 harness, not asserted from clean published benchmarks** (real WhatsApp-voice-note WER runs materially
  worse than clean Common Voice figures, and accuracy rises monotonically with model size — which is why **`small`
  was chosen over `base`**) — measured **offline** (CI fixtures, **no telemetry**).
- **Test kind:** integration / performance (offline fixtures). *(New M2 quality bar; M2-0 now **validates `small`**
  against the ceiling rather than choosing `base` vs `small`.)*

**AC-22 — User control / opt-in over transcription (consent) — gates both transcription AND the model download.**
- **Given** a grief-sensitive library in which transcription would turn a deceased person's voice into stored,
  searchable text, and in which enabling the feature triggers a one-time model download,
- **When** the user reaches the transcription capability,
- **Then** **no audio is transcribed, and no model byte is downloaded, without an explicit user opt-in**: there is a
  clear **first-run / global toggle** (and, ideally, **per-item** control), the current state is visible, and
  **nothing auto-transcribes silently** in the background. **No opt-in ⇒ no model download ⇒ no network.**
- **Test kind:** integration / e2e. *(New M2 privacy capability; honours MISSION §5. The default is **opt-in**
  (LOCKED by @pedrofuentes — ADR-0027); this opt-in is the consent gate for the AC-24 download.)*

**AC-23 — Attribution / NOTICES for third-party artifacts (bundled binary + downloaded model).**
- **Given** a shipped installer bundling the `whisper-cli` binary (whisper.cpp, **MIT**) and a `small` `ggml` model
  (derived from OpenAI Whisper, **MIT**) that the app **downloads on opt-in**,
- **When** the app is packaged,
- **Then** the build includes **license attribution / NOTICES** for the bundled binary **and** for the downloaded
  model weights, each with recorded **provenance** (source + version + size + checksum) — the model's NOTICES travel
  with the app even though the weights arrive at runtime.
- **Test kind:** integration / packaging-config. *(New M2 compliance bar; sequenced in M2-1.)*

**AC-24 — Model-download integrity & resilience (the one permitted egress is safe).**
- **Given** the opt-in `small` model download from the single pinned host (ADR-0027 Decision 6),
- **When** the model is fetched, verified, and installed — including under a dropped connection, an offline machine,
  or a corrupt / tampered file,
- **Then** the file's **SHA-256 is verified before first use** (the hard-coded
  `1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b`, 487,601,967 bytes) and an **unverified model
  is never run**; the install is **atomic** (temp → verify → rename, so a partial file is never seen as "the
  model"); the download is **resumable** (a dropped connection does not restart from zero); a **corrupt / mismatched
  file is rejected and re-fetched**; an **offline or failed** download surfaces a **calm retry with no crash and no
  half-state**, leaving the feature disabled until a verified model is present; and the **only** outbound connection
  observed is the **data-free GET to the pinned host** — every other egress still trips the AC-4 guard.
- **Test kind:** integration **+** the scoped AC-4 egress harness. *(New M2 integrity bar; the safety envelope
  around the single egress AC-4 now permits — ties to AC-17 / AC-22; sequenced in M2-1, harness edits
  HUMAN-REQUIRED.)*

### 4.1 AC traceability table (AC-id → feature → test kind)

| AC | Source | Feature / capability | Test kind |
|----|--------|----------------------|-----------|
| **AC-1** | MISSION §8 | (b) WhatsApp export import — text + photos + voice/audio + video | integration + e2e |
| **AC-2** | MISSION §8 | (a) Folder / cloud-download photo+video import, dates + thumbnails | integration |
| **AC-3** | MISSION §8 | (c) Safe archive extraction — Takeout / Facebook / LinkedIn (no zip-slip) | unit + integration |
| **AC-4** | MISSION §8 | (f) + cross-cutting — local-only / zero network egress | integration + e2e |
| **AC-5** | MISSION §8 | cross-cutting — build macOS + Windows → GitHub Releases, launches | CI build + e2e smoke |
| **AC-6** | MISSION §8 | (e) Browse/timeline + basic search | e2e |
| **AC-7** | added | (e) Search precision — FTS5 + type/source/date filters | integration |
| **AC-8** | added | (e) Virtualized timeline at ≥10k items (performance) | e2e / perf |
| **AC-9** | added | (a) Off-UI-thread ingestion + thumbnail generation (performance) | integration / perf |
| **AC-10** | added | (c) Decompression-bomb / symlink rejection (security) | unit + integration |
| **AC-11** | added | (c)/(d) Takeout content — Gmail `.mbox` + Google Photos sidecar dates | integration |
| **AC-12** | added | (b)/(f) WhatsApp how-to-export walkthrough + Browse-first | e2e |
| **AC-13** | added | (f) Accessibility essentials (WCAG 2.1 AA) | e2e (axe) |
| **AC-14** | added | (d) Originals preserved on disk + undo without data loss | integration |
| **AC-15** | added | (a)/(b)/(c) Resilient partial import | integration |
| **AC-16** | added | (c) Facebook DYI + LinkedIn content correctness — text/timestamps/media linkage | integration |
| **AC-17** | M2 · ADR-0027 | On-device transcription — user memories never egress (absolute); static packaging guarantee **+** real-binary OS-deny egress (extends AC-4; runtime half = net-new M2-7) | integration + net-new OS-deny harness |
| **AC-18** | M2 · ADR-0027 | Transcription off the UI thread (extends AC-9) | integration / perf |
| **AC-19** | M2 · ADR-0027 | Transcripts searchable via FTS5 (`search_meta`/dedicated column), attached to items (extends AC-6/AC-7) | integration |
| **AC-20** | M2 · ADR-0027 | Resilient, non-destructive transcription incl. **long media** (child-kill on cancel; net-new per-item queue) | integration |
| **AC-21** | M2 · ADR-0027 | Multilingual coverage + WER floor (Spanish + others), empirically set on real samples, offline-measured | integration / perf |
| **AC-22** | M2 · ADR-0027 | User control / opt-in over transcription (consent; privacy) | integration / e2e |
| **AC-23** | M2 · ADR-0027 | NOTICES / attribution for bundled binary + **downloaded** model weights (provenance) | integration / packaging |
| **AC-24** | M2 · ADR-0027 | Model-download integrity & resilience — SHA-256 verify-before-use, atomic, resumable, corrupt→refetch, offline-safe; only egress = pinned data-free host | integration + scoped AC-4 harness |

> **AC-17 … AC-24 are M2 (post-v1), proposed, and HUMAN-REQUIRED** — they activate only on @pedrofuentes sign-off of
> ADR-0027 and must keep AC-1 … AC-16 green (cumulative regression). AC-4's **user-data** zero-egress is **never
> weakened**; it is **narrowed** to one opt-in, data-free, checksum-verified model fetch (AC-17 + AC-24).

**Coverage check — every MVP capability maps to ≥1 AC:** (a) → AC-2, AC-9, AC-14, AC-15; (b) → AC-1,
AC-12, AC-15; (c) → AC-3, AC-10, AC-11, AC-15, **AC-16** (Facebook/LinkedIn content correctness);
(d) → AC-1/2/3/11/16 (catalog), AC-14; (e) → AC-6, AC-7, AC-8; (f) → AC-4, AC-12, AC-13.

---

## 5. Non-functional requirements

### 5.1 Local-only / zero network egress *(core invariant — AC-4)*
- **No runtime network origins** — v1 is fully offline (MISSION §5 allowlist: **None**).
- **No telemetry, no analytics on user content**, ever (MISSION §5, NEVER list).
- **All fonts and assets are bundled with the app** — **no remote fonts, no CDNs, no Google Fonts**,
  no remotely-loaded scripts/styles/images — so the renderer needs no network at runtime.
- Enforced in-app (defense in depth, beyond the AC-4 test): block all non-`file:`/`app:`/`blob:`
  requests via `session.webRequest.onBeforeRequest({cancel:true})`, and a **strict
  Content-Security-Policy** that permits only same-origin/bundled resources and forbids all network
  connections — `default-src 'none'; connect-src 'none'; img-src 'self' data:; style-src 'self';
  font-src 'self'; script-src 'self'` (research: `security.md` Topic 3–4).
- **Implication for product scope:** any feature needing the network (map tiles, geocoding, model
  downloads, sharing) is **out of v1** because it would break AC-4 (§7).

### 5.2 Accessibility *(AC-13)*
WCAG 2.1 AA as the floor, exceeded for this audience (research: `ux.md` §3): body contrast target
≥ 7:1 (AA min 4.5:1); click/touch targets ≥ 44px (prefer 48–56px for primary actions) with ≥ 8px
spacing; **visible focus ring**; **no auto-play**; `prefers-reduced-motion` honored by default; text
resizable to 200%; plain language at a 6th–8th-grade level with no jargon; full keyboard operability
and correct ARIA roles/labels/live-regions (incl. import progress).

### 5.3 Performance *(AC-8, AC-9)*
- **Heavy ingestion off the UI thread** — `worker_threads` for parse/hash/EXIF; `ffmpeg`/`ffprobe`
  as a subprocess (ideally an Electron `utilityProcess`); the renderer main thread stays responsive
  with **no main-thread task > 50 ms** during import (**AC-9**) (MISSION §7; research:
  `catalog-pkg.md` §3.4, `security.md` Topic 2).
- **Streaming parses** for large exports (a multi-GB `.mbox`, a 200k-line chat) — never buffer whole
  files into memory (research: `formats.md` §1.8, §2.6).
- **Lazy-loaded media** via a local custom protocol; **virtualized** timeline (`@tanstack/react-
  virtual`) keeping a **bounded mounted-node window** that sustains **≥ 55 fps / no long-task > 50 ms**
  at **≥ 10,000** items (**AC-8**) (research: `catalog-pkg.md` §4.1).
- **SQLite tuned:** WAL journal, sensible pragmas, targeted indexes, FTS5 for search (research:
  `catalog-pkg.md` §2.2, §4.2).

### 5.4 Security *(AC-3, AC-10; supports AC-4)*
- **Zip-slip / path-traversal guards** on **all** archive extraction — `yauzl` `validateFileName`
  plus a belt-and-suspenders resolved-path `startsWith(destDir + sep)` check; **decompression-bomb**
  guards (per-entry size, total size, compression-ratio, entry-count caps); **symlink rejection**
  (research: `security.md` Topic 1).
- **Electron hardening:** `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, strict
  CSP, `will-navigate`/`setWindowOpenHandler` deny, a **minimal `contextBridge` IPC** surface, and
  `@electron/fuses` + ASAR integrity at package time (research: `security.md` Topic 3).
- **Untrusted-input validation with `zod`** — validate every IPC payload (in **preload and main**)
  and every parsed sidecar/JSON structure before use (research: `security.md` Topic 3; MISSION §3).
- **Media-parser isolation** — run `ffprobe`/`ffmpeg` with `spawn` (array args, never shell), with
  timeouts and output caps; keep parsers patched (Dependabot) (research: `security.md` Topic 2).
- **Supply chain / release gates:** Dependabot, CodeQL, and secret scanning enabled; open
  high/critical alerts and any detected secret **gate every release** (MISSION §5).

### 5.5 Cross-platform *(AC-5)*
macOS (arm64 + x64) and Windows (x64; arm64 cross-compiled) via `electron-builder`, `npmRebuild` +
`buildDependenciesFromSource` for `better-sqlite3`, built on **per-arch native runners** (research:
`catalog-pkg.md` §5). v1 ships **unsigned** (one-time Gatekeeper/SmartScreen prompt); signing is a
later gated step (MISSION §2).

### 5.6 Data integrity & durability *(AC-14)*
Originals are **never moved or deleted**; the catalog is rebuildable from originals on disk; imports
are **undoable**; SHA-256 content addressing dedupes identical files across sources — storing the bytes
**once** while **recording every source occurrence**, so deduplication **preserves provenance and never
silently drops** an item (consistent with AC-14/AC-15 and Mateo's "nothing silently dropped") (research:
`catalog-pkg.md` §2, §6).

---

## 6. Success metrics

> **Measured offline only.** Because Kawsay ships **no telemetry/analytics** (MISSION §5, NEVER
> list), every metric below is gathered via **moderated usability testing** and **CI benchmark
> fixtures** — never via in-product data collection. Thresholds that bind a per-PR AC (SM-2 → AC-8/AC-9)
> are stated as **concrete, offline-measured numbers**; the qualitative usability targets remain
> judgement-based by nature.

| # | Metric (from MISSION §1 vision) | Proposed target | How measured (no telemetry) |
|---|---|---|---|
| SM-1 | **An afternoon to a usable archive** | A non-technical tester completes a first successful import **unaided in one sitting** | Moderated test with 5 bereaved, non-technical users aged 60+ (research: `ux.md` §"older user testing") |
| SM-2 | **Time-to-first-memory-visible** | **First memory visible within ≤ 10 s** of starting an import of the **named standard test fixture** (excludes time the *source platform* takes to produce the export) | CI benchmark on the named standard fixture (offline) + moderated test |
| SM-3 | **Breadth of sources** | A user can bring memories from **≥ 3 of the 5** v1 sources into one library | Moderated test / acceptance run (AC-1, AC-2, AC-11, AC-16) |
| SM-4 | **Import fidelity** | **0** silently-dropped items; skipped items always surfaced with a count | AC-15 (automated) |
| SM-5 | **Privacy guarantee** | **0** outbound network connections during import and use — always | AC-4 (automated, every PR) |
| SM-6 | **Unaided task completion** | **≥ 4 of 5** non-technical 60+ testers complete a WhatsApp import without help | Moderated usability test |

---

## 7. Out of scope for v1

Explicitly **not** in M1 (MISSION §4), to keep the gate honest:

- **Live account / OAuth connections** to any service (v1 is export/file-based — avoids holding the
  deceased's live credentials and any network egress).
- **Cloud sync, accounts, or family sharing** — adding a backend changes the privacy model and is a
  **human-required** gated milestone (ROADMAP **M5**; MISSION §9).
- **AI auto-categorization & smart search** (ROADMAP M4).
- **Audio/video transcription** — the **#1 roadmap candidate**, deliberately deferred (ROADMAP M2).
- **Memorial-site / photo-book / "export-out"** features (ROADMAP M6).
- **Anything requiring the network** — map tiles, geocoding, online model downloads, update checks —
  because it would violate the local-only invariant (AC-4). (GPS *coordinates* are still catalogued
  locally; rendering them on an online map is out of scope.)
- **Code-signing / notarization** of installers — deferred gated step (MISSION §2); v1 artifacts are
  unsigned.
- **Mobile apps and multi-user** — v1 is a single-user desktop app (MISSION §2, §5).

---

## 8. Assumptions & open questions (for the red-team)

- **Numeric thresholds are now concrete** and binding: **SM-2 ≤ 10 s** to first memory on the named
  standard fixture, **AC-8** ≥ 10,000 items with a capped mounted-node window at **≥ 55 fps / no
  long-task > 50 ms**, and **AC-9 no main-thread task > 50 ms** during import. The red-team may tune the
  exact numbers, but each is now observable and falsifiable as written.
- **iOS WhatsApp** attachment naming and `.mbox` streaming at multi-GB scale need real-sample
  validation (research: `formats.md` Gaps; `security.md` Gaps).
- **Connectors as separate increments:** each source (WhatsApp, folder, Takeout, Facebook, LinkedIn)
  is expected to ship as its own TDD increment behind the common importer interface; M1 is "done"
  when AC-1 … AC-16 pass cumulatively.

---

## 9. References

- **Binding spec:** [`MISSION.md`](./MISSION.md) — §1 mission, §2 product, §4 MVP scope, §5
  security/privacy, §8 Definition-of-Done (AC-1 … AC-6), §9 authorization tiers.
- **Repo conventions:** [`AGENTS.md`](./AGENTS.md); [`ROADMAP.md`](./ROADMAP.md);
  [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md); [`docs/TESTING-STRATEGY.md`](./docs/TESTING-STRATEGY.md).
- **Discovery research (synthesized into this PRD):**
  - Grief-tech UX, tone, design tokens, accessibility — `research/ux.md`.
  - Export file formats (WhatsApp, Takeout, Facebook, LinkedIn, generic folder) — `research/formats.md`.
  - Security & Electron hardening (zip-slip, media parsers, zero-egress, native rebuild) —
    `research/security.md`.
  - Local media cataloging + Electron packaging/distribution — `research/catalog-pkg.md`.

*All acceptance criteria are testable and consistent with MISSION; none requires network egress or
any action on MISSION's NEVER list.*
