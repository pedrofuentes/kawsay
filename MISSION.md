# MISSION — Kawsay

> **This is the per-project brief.** It is the *only* file you normally edit per project. The generic operating instructions in [`docs/KICKOFF.md`](docs/KICKOFF.md) read this file and fill every project-specific decision from it. Leave a field as `{{...}}` or `TODO` only if you truly want the agent to ask you about it at launch.
>
> Fill it in, then launch with the one-liner in the README.

---

## 1. Identity & mission
- **Project name:** Kawsay
- **Repo:** `pedrofuentes/kawsay` *(to be created at kickoff)*
- **Cofounder handle (for @-mentions on gated decisions):** @pedrofuentes
- **One-line mission:** Kawsay ("living energy" in Quechua) helps non-technical people gather, organize, and preserve the memories of a loved one who has passed — messages, photos, videos, voice notes, and documents scattered across messaging, email, social, and cloud accounts — into one private, lovingly catalogued place to honor and remember them.
- **Target users & the problem:** People grieving the loss of a loved one — usually non-technical — who want to honor that person by collecting their digital life. Those memories are fragmented across a dozen apps and accounts; gathering them (listening to every WhatsApp audio, watching every video, reading every document) is overwhelming, technical, and emotionally heavy. Kawsay makes it simple, gentle, and private.
- **Success vision:** Anyone who loses someone can, in an afternoon and without any technical skill, bring their loved one's memories into one private, beautiful archive they can revisit — and one day share with family — turning a months-long, painful technical chore into a healing act of remembrance. Wildly successful = the trusted, private place families turn to when someone passes, preserving thousands of legacies.

## 2. Product shape
- **Product type:** Local desktop application (Electron), cross-platform — macOS and Windows.
- **Hosting / distribution:** GitHub Releases — downloadable installers (`.dmg` / `.exe`). No backend. *(Code-signing / notarization is a later gated step.)*
- **Backend?** **None** — fully local / self-contained; all processing happens on-device. Adding any backend, sync, account, or cloud service later is a **human-required** gated decision (§9).
- **Design direction:** Warm, calm, reverent, and human — never clinical or "techy." Soft palette, generous whitespace, beautiful and legible typography, plain language with zero jargon, gentle pacing appropriate to grief. *No fixed design system yet — propose one* (calm / well-being / memorial-appropriate). Concrete reference *links* go in §6.

## 3. Tech stack
- **Language(s):** TypeScript (strict).
- **Framework(s) / key libraries:** Electron + React + Vite + Tailwind (app shell & UI); **SQLite** (`better-sqlite3`) for the local catalog/index, with original files preserved on disk; ingestion: `exifr` (photo EXIF), `mailparser` (Takeout / email), `fluent-ffmpeg` / `ffprobe` (audio + video metadata & thumbnails), a **zip-slip-guarded** archive extractor (e.g. `yauzl`), `zod` (validation). **Extensible connector architecture** — each source is an isolated importer module behind a common interface, so new sources are cheap to add.
- **Package manager:** pnpm.
- **Test runner / e2e:** Vitest (unit / integration) + Playwright (e2e).
- **Visual verification:** Playwright (renders + screenshots the running UI for the design loop).
- *Decision (deliberate):* evaluated **Tauri v2** (Rust + system WebView — leaner binaries, tighter sandbox) against Electron and **chose Electron** for autonomous-fleet velocity, the day-one JS ingestion ecosystem, and proven large-local-data performance (Obsidian, VS Code). Revisit only if footprint/security come to outweigh those.

## 4. MVP scope (v1)
v1 = the **aggregate & import foundation**: make it dead-easy for a non-technical person to pull a loved one's memories out of many sources — via **exports/files**, no live account logins — into one private local library, built on an **extensible connector architecture** so the source list keeps growing.

**Comprehensive source coverage (v1):**
1. **Cloud drives & folders — one generic importer covering iCloud Drive, OneDrive, Dropbox, Google Drive, and local/external disks:** import any folder of photos, videos, audio, and documents (recursive), with type + date/EXIF detection and thumbnails.
2. **WhatsApp:** guided "Export Chat" import including text, photos, **voice notes/audio**, and video, with a hand-holding "how to export" walkthrough.
3. **Google Takeout:** Gmail (`.mbox` email), Google Photos, and Drive contents.
4. **Facebook:** "Download Your Information" export.
5. **LinkedIn:** "Get a copy of your data" export.
6. **One private local library:** originals preserved on disk + a SQLite catalog (source, date, type, media), with **browse/timeline + basic search** so imported memories are immediately viewable.

- Non-technical-first throughout: drag-and-drop, clear progress, plain language, **fully offline**.
- **Explicitly out of scope for v1:** live account / OAuth connections; cloud sync, accounts, or family sharing; AI auto-categorization; **audio/video transcription** (top roadmap candidate — see below); memorial-site / photo-book / export-out features.
- **Roadmap (post-v1), each a new connector or capability:** **audio & video transcription** (so you needn't listen to every recording — the #1 candidate); more sources — Telegram, Messenger, Instagram, iMessage/SMS, Outlook/PST, etc.; AI categorization & smart search; family sharing (cloud — a gated milestone that changes the privacy model); memorial outputs (timeline site, photo book).

## 5. Security, privacy & data
- **Auth model:** None — single-user local desktop app; no login, no accounts.
- **Privacy/data constraints:** All data stays **on the user's device**. Nothing is uploaded; no telemetry; no analytics on user content. A loved one's memories must never leave the machine. This local-only guarantee is a **core, tested** promise (see AC-4).
- **Network allowlist (runtime origins the *product* may contact):** **None** — v1 is fully offline.
- **Agent egress allowlist (origins the *build fleet itself* may reach — distinct from the product's):** GitHub + the npm registry + the named research/doc domains. The fleet must not reach beyond this; any deploy/signing secrets live in GitHub **Environment** secrets, never in the repo or a worktree.
- **Known security risks to research up front:** safe parsing of **untrusted export files** — zip-slip / path-traversal when unpacking WhatsApp / Takeout / Facebook / LinkedIn archives, and media-parser vulnerabilities; guaranteeing the local-only / no-egress invariant; handling extremely sensitive personal data of a deceased person with care. (The export/file model deliberately avoids holding the deceased's live credentials.)
- **Continuous scanning:** Dependabot, code scanning (CodeQL) and secret scanning are enabled and monitored; open **high/critical** vulnerability alerts and any detected secret gate every release (lower-severity tracked on the board).

## 6. Reuse & references
- **Prior art / code to study or port:** grief-tech / digital-legacy products (e.g. Empathy, Eternos, HereAfter) for tone & UX; local photo/media catalogers (e.g. Immich, PhotoPrism) for cataloging/timeline patterns; open-source WhatsApp-export parsers. *(Add specific repo links as you find them.)*
- **Design/UX references:** calm / well-being / memorial aesthetics — *links TBD* (or "propose one"). The qualitative direction is in §2.

## 7. Harness pre-answers (so agents-template New-Project-Setup never stalls)
- **Coverage threshold:** 80 — Sentinel ratchets up; never decreases.
- **Git author identity (commits):** pedrofuentes <git@pedrofuent.es>
- **AI attribution (commit `Co-authored-by` trailer):** Copilot <223556219+Copilot@users.noreply.github.com>
- **Sentinel method:** B (CI, enforced by branch protection) for production + A (sub-agent) in dev.
- **Agent identity (for unattended runs):** *Start under attended single-operator mode (below) as @pedrofuentes; provision a distinct **GitHub App** (`kawsay-bot[bot]`) to enable fully-unattended Tier-2 — the agent will walk you through provisioning one (see `CONTINUOUS-OPERATION.md` §Agent identity).*
- **Attended single-operator mode (opt-in):** `yes — I accept running under my own identity while present.` Start now under @pedrofuentes: the agent takes gate answers via the **live CLI or a bounded-trusted async board channel** (self-signature + cofounder-login + solo-repo), runs **Tier-1 only (no unattended Tier-2)**, and keeps all other v2 protections. Provision the GitHub App above to go fully unattended.
- **Enforced coding patterns:** TypeScript strict; the **local-only / zero-network-egress** invariant enforced by an automated test; **zip-slip / path-traversal guards** on all archive extraction; isolated connector modules behind a common importer interface; **performance: heavy ingestion runs off the UI thread (worker threads / `ffmpeg` subprocess), streaming parses for large exports, lazy-loaded media — keep the renderer light**; accessibility for non-technical users; no secrets in the repo or bundle.
- **Forbidden actions (NEVER):** transmit, upload, or sync any user memory data off the device; add telemetry or analytics on user content; commit secrets; weaken or remove the local-only guarantee, Sentinel, tests, branch protection, or the scanners.
- **Enable branch protection on `main`?** Yes.

## 8. Definition of Done (project-specific acceptance)
The generic kickoff already requires: tests green, coverage ≥ threshold, lint/typecheck clean, Sentinel APPROVED/CONDITIONAL on every merge, README/LICENSE/CONTRIBUTING shipped, and an empty board. **This project also requires (each bound to a stable `AC-n` test id, checked on every PR and every milestone — cumulative acceptance regression):**
- **AC-1:** A non-technical user can import a **WhatsApp export** (text + photos + voice notes/audio + video) end-to-end and see the items in the library.
- **AC-2:** **Photos & videos** import from a folder (incl. iCloud / OneDrive / Dropbox / Google Drive downloads) with correct dates and generated thumbnails.
- **AC-3:** **Documents / archives** (incl. a Google Takeout, Facebook, or LinkedIn zip) import **safely** — no zip-slip / path traversal.
- **AC-4:** **Local-only proven:** an automated test asserts **zero network egress** during import and use.
- **AC-5:** The app **builds** into installable **macOS and Windows** artifacts published to **GitHub Releases**, and launches.
- **AC-6:** **Browse/timeline + basic search** display imported memories correctly.

## 9. Authorization — what the agent may do without you (tiered)

The agent sorts every gated action into one of five **authorization tiers** and acts per the tier
*without asking*, except where the tier requires you. These are the defaults; override per project below.

| Tier | The agent… | Default actions in this tier |
|------|------------|------------------------------|
| **auto** | just does it | §3 stack deps + reasonable transitive build/test/lint tooling; authoring CI/CD (tests, lint/typecheck, Sentinel Method B, the scanners, the deploy pipeline); routine **reversible** architecture; **staging/preview** deploys; fixing security alerts + shepherding Dependabot PRs; merging a Sentinel-passed PR |
| **auto-with-audit** | does it, records an ADR/audit note in `DECISIONS.md` | new **non-heavy** dependencies; data-model/schema changes; new config/env vars; new internal module boundaries |
| **time-boxed** | proposes on the board and **auto-proceeds after the timeout** if you don't object | the **next milestone** *within the approved `ROADMAP.md`*; a non-heavy dep with a transitive-risk note; enabling an optional integration; a **built-UI design review** (the agent posts screenshots to a `DECISION:` issue and auto-proceeds after the window — raise to `human-required` to gate every design change) |
| **human-required** | **blocks until you approve** (a `decision:approved` label / review from *your* identity) | mission / scope / pivots; auth · crypto · credential · privacy-data design; the **first** production deploy or package publish **of each release**; a **new backend / proxy / external origin**; **heavy or unusual** deps; **accepting** a high/critical security risk; sending user data off the §5 allowlist; a **harness-integrity** PR (the Sentinel config/prompt, `AGENTS.md`, CI workflows, branch protection, or scanner config); a **third-party / first-time-contributor** PR |
| **never** | refuses | the §7 NEVER list; committing secrets; weakening/removing Sentinel, tests, branch protection, or the scanners (branch protection is **tighten-only**); force-push / history-rewrite of `main`; deleting branches, releases, tags, or data; changing `.github/workflows/**` security-relevant config without a `human-required` gate |

- **Default time-box (auto-proceed window for the `time-boxed` tier):** 24h
- **Risk tolerance:** conservative — sensitive personal data, solo operator; shifts borderline actions toward `human-required`.
- **Production release gate:** human-required — the first production build/publish *of each release* (CI/build stays `auto`). Enforce it with a protected **Environment** (required reviewers) on the release job.
- **Project overrides** (move specific actions to a different tier): any action that would add **network egress, data upload/sync, telemetry, a backend, or an external origin** → **human-required** (or **never** for anything that would break the local-only guarantee), regardless of the default tier.
- **Pre-authorized specifics** (kept for clarity; these are `auto`): the §3 stack + standard CI + the GitHub Releases packaging/distribution pipeline.

## 10. Resource governance (concurrency & cost)

Caps the fleet so it can't runaway-spawn or overspend. The orchestrator and watchdog honor these — on
breach they **queue** new work and finish in-flight increments first; they never exceed a cap.
- **Max concurrent workers / worktrees:** 4
- **Per-watchdog-tick spawn cap:** 3
- **Per-milestone token/cost budget (soft — queue at the cap, raise a `needs:decision` to exceed):** no hard cap — queue at the concurrency caps; raise a `needs:decision` before any unusual spend.
