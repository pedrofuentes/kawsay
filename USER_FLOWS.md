# USER_FLOWS — Kawsay

> **Phase-2 gate artifact.** This UX/UI design spec is **subordinate to [`MISSION.md`](./MISSION.md)**
> (binding) and paired with [`PRD.md`](./PRD.md) and [`ROADMAP.md`](./ROADMAP.md). Where any wording
> here appears to diverge from MISSION, **MISSION wins**. Every choice is grounded in **MISSION §2
> (Design direction)** and the grief-tech UX research (`research/ux.md`); browse/timeline/search
> patterns draw on `research/catalog-pkg.md` §4.
>
> **Authored by:** UX/UI Design sub-agent. **Status:** proposed — **awaiting independent red-team**
> before the gate passes. **Scope:** the v1 (M1) experience for **Elena** (primary, non-technical,
> grieving, often 60+) and the duty of care toward **Mateo** (the archive's eventual inheritor).
> Acceptance ties: **AC-4, AC-6, AC-7, AC-8, AC-12, AC-13, AC-14, AC-15**.

---

## Table of contents

1. [Design principles](#1-design-principles)
2. [Core user journeys](#2-core-user-journeys)
3. [Information architecture & navigation](#3-information-architecture--navigation)
4. [UI component list](#4-ui-component-list)
5. [Design tokens](#5-design-tokens)
6. [Accessibility approach (AC-13)](#6-accessibility-approach-ac-13)
7. [Design rubric](#7-design-rubric)

---

## 1. Design principles

These are the emotional/tone stance Kawsay holds toward a grieving, non-technical user. They are the
tie-breakers for every later decision — when a choice is ambiguous, the option that better honors
these principles wins. (MISSION §2; `ux.md` §1.2–§1.5, §3.)

### P1 — Reverent, never clinical
Kawsay is a **caring guide walking alongside the user**, not a piece of software being configured.
We lead with *what the person gains* ("Bring [Name]'s messages here"), never with what the software
does ("Import files"). No jargon — not even *export, sync, archive, folder, metadata, parse, upload*
— without a plain-language paraphrase. Tone profile (NNGroup, `ux.md` §1.2): **serious but gentle,
casual, deeply respectful, quietly matter-of-fact** — never formal, never chummy-cheerful, never
exclamatory. *Trustworthiness, not friendliness, earns the right to be used here.*

### P2 — Name the person; make grief implicit
Within the first two steps, onboarding asks **the loved one's name**, and from then on the UI uses
*their name* everywhere — never "the deceased," "the contact," or "your loved one." Grief is
acknowledged **once**, gently, at the start ("Gathering these memories is a meaningful thing to do —
we'll take it one step at a time"), then never mentioned again unless the user initiates it. We never
run a "what's your situation?" intake. (`ux.md` §1.4.2, §1.5.)

### P3 — Gentle pacing; one thing at a time
**Never rush.** No timers, no "complete setup now," no urgency cues, no session timeouts. One
decision per screen (Hick's Law) — features beyond the first import stay hidden until the first
import succeeds. A calm **"You can close Kawsay and come back anytime — nothing will be lost"** escape
hatch is reachable at every step. Reduced motion is the **default**, not an opt-in. (`ux.md` §1.4,
§3.3, §3.6.)

### P4 — Privacy you can feel
The local-only promise (**AC-4**) is surfaced as **reassurance, not fine print**: the verbatim line
**"Your memories never leave this computer"** appears in onboarding and in the footer of every import
step, and a quiet persistent **"Private & on this computer"** badge lives in the status bar. Soft,
friendly lock iconography (rounded, not a bank-vault padlock); **no cloud, globe, or upload imagery
anywhere**. Privacy is the foundation the whole product stands on. (`ux.md` §2.5; MISSION §5.)

### P4b — Nothing is ever lost or broken
Elena's deepest fear is *deleting or breaking something irreversible*. So: **originals are never
moved, altered, or deleted** — Kawsay only ever makes copies (**AC-14**); **every import is undoable**
without touching a source file; and imports **never silently drop items** — skipped files are always
surfaced with a count (**AC-15**). We say this out loud ("You're just making a copy — nothing will be
deleted") and never deviate. (`ux.md` §3.5; PRD §2.1, §5.6.)

### P5 — Built for tired eyes and unsteady hands
The audience skews 60+ and may be reading through tears. So we exceed typical baselines: large,
legible type (**18px preferred body**), high contrast (**≥7:1 body target**), big hit targets
(**≥44px, prefer 48–56px**), generous whitespace that "breathes," **percent-done progress** (never a
bare spinner), and a **"Browse…" button as the primary path** with drag-and-drop only as an optional
enhancement. (`ux.md` §3.1–§3.4; PRD §5.2.)

### P6 — Instant, emotional payoff
The reward for finishing an import is **seeing their face**, immediately — the first memory, not a
success toast or a settings screen. Progress is concrete and human ("We found 347 of [Name]'s
photos"), and **media never auto-plays** — a voice note or video plays only on the user's explicit
intent, so a loved one's voice never ambushes a grieving user. (`ux.md` §1.4.4, §4.2 Step 6, §1.5.)

---

## 2. Core user journeys

Each journey below gives the **happy path** with the **emotional context at each step**, followed by
its **empty / loading / error** states. Wireframes are ASCII sketches for intent, not pixel specs.
All copy uses the loved one's name once known; `[Name]` is the placeholder. All flows are **fully
offline** and **keyboard-operable** with a **visible focus ring** (§6).

### Journey A — First-run onboarding

**Goal:** welcome the user, earn trust about privacy, learn the loved one's name, choose where the
library lives on this computer, and reach the first source — calmly, one step at a time. (`ux.md`
§4.1–§4.2; AC-4, AC-12, AC-13.)

The onboarding is a **WalkthroughStepper** wizard. Focus moves to each step's `<h1>` on advance
(§6). The **"Add memories later"** / **"Show me around first"** escape hatch is always present. Every
step footer carries the **PrivacyBadge** line.

```
┌──────────────────────────────────────────────────────────┐
│                                                          │
│                     Kawsay                               │   ← serif display, warm canvas
│                                                          │
│     A private place to gather [the people you love]      │
│              memories — one step at a time.              │
│                                                          │
│         ┌────────────────────────────────────┐           │
│         │     Start bringing memories  →     │           │   ← primary (sage), ≥56px tall
│         └────────────────────────────────────┘           │
│              Show me around first                        │   ← quiet text link
│                                                          │
│      🔒  Nothing leaves your computer. No account needed. │   ← PrivacyBadge
└──────────────────────────────────────────────────────────┘
```

**Step 0 — Welcome (emotional entry).** Full-screen warm canvas, a single centered serif heading,
generous whitespace. One gentle grief acknowledgment line. Two choices only: **Start bringing
memories** / **Show me around first**. *Emotion:* arrival should feel like a calm room, not a setup
screen — stillness communicates safety before a word is read.

**Step 1 — Privacy reassurance.** A short, plain reassurance the user can believe: **"Everything
stays on your device. Your memories never leave this computer — there's no account, no cloud, nothing
is uploaded."** A soft rounded-lock illustration; no cloud/globe imagery. A single **"I understand —
let's begin"** continues. *Emotion:* directly answers Elena's fear that memories could "leak onto the
internet" before she invests any effort. (AC-4; `ux.md` §2.5.)

**Step 2 — Name your loved one.** One large text input (≥48px tall, 20px text). Label: **"Who are
you honoring?"** Helper: *"We'll use their name as we go."* From here, every UI string uses the name.
*Emotion:* personalizes the whole experience and quietly signals this is about a *person*, not data.
(`ux.md` §1.4.2, §4.2 Step 1.)

**Step 3 — Choose where [Name]'s library lives.** Plain framing, **not** "select database path":
**"Where should we keep [Name]'s memories on this computer?"** A sensible **default is pre-filled and
recommended** — a *"Kawsay — [Name]"* folder inside the user's Documents — with a single **"Change…"**
(opens the native folder picker via **LibraryLocationPicker**). Helper: *"This is a private folder on
your computer. The original photos and messages always stay where they are; Kawsay keeps its copy
here."* *Emotion:* removes a technical decision most users shouldn't have to make, while giving
control to those who want it; reiterates "originals stay put" (AC-14).

**Step 4 — Choose a starting source.** Hands off to **Journey B**. Copy: **"Where are some of
[Name]'s memories?"** plus a persistent **"I'll add this later"** escape hatch. *Emotion:* the user
is now oriented, reassured, and ready — with no pressure to do it all at once.

| State | Behavior |
|---|---|
| **Happy** | Welcome → privacy → name → library location → first source, each step one decision. |
| **Empty** | No prior library exists → this is the canonical first-run path (above). |
| **Loading** | Steps are instant; no spinners. Creating the library folder shows a brief inline *"Setting up [Name]'s library…"* (≤1s) with no blocking modal. |
| **Error** | Chosen folder not writable / no space → plain message *"We can't save to that folder. Let's pick another place."* + re-open picker; never a raw OS error or path/errno. Folder already contains a Kawsay library → offer **"Open the existing library"** vs **"Choose a different place."** |
| **Returning user** | Onboarding is skipped; app opens to the **Library home** (Journey D). "Show me around first" replays a 3-card, skippable tour, never forced. |

---

### Journey B — Choose a source + guided "how to export" walkthrough (AC-12)

**Goal:** let a non-technical user pick a source and **hand-hold them through getting the export
out** of WhatsApp / Google / Facebook / LinkedIn — or simply point at a folder — before any file
picker appears. This walkthrough-before-picker is the product's key differentiator and is bound to
**AC-12**. (`ux.md` §4.2 Step 3; `formats.md` §1–§4.)

**Source picker.** 5–6 large **SourceCard**s (min 80px tall, icon + one-line plain description,
generous padding, ≥8px apart). Reverent, non-techy labels:

```
┌──────────────────────────────────────────────────────────┐
│  Where are some of [Name]'s memories?                    │  ← serif h1
│                                                          │
│  ┌───────────────────────┐  ┌───────────────────────┐    │
│  │ 💬  WhatsApp chats     │  │ 🖼  A folder of photos │    │
│  │ Messages, voice notes, │  │ From this computer, a  │    │
│  │ photos & videos        │  │ phone, or a drive      │    │
│  └───────────────────────┘  └───────────────────────┘    │
│  ┌───────────────────────┐  ┌───────────────────────┐    │
│  │ 📦  Google Takeout     │  │ 📘  Facebook           │    │
│  │ Email & Google Photos  │  │ Posts, messages, photos│    │
│  └───────────────────────┘  └───────────────────────┘    │
│  ┌───────────────────────┐                                │
│  │ 💼  LinkedIn           │     I'll add this later  →    │  ← escape hatch always visible
│  └───────────────────────┘                                │
│  🔒 Your memories never leave this computer.              │  ← PrivacyBadge footer
└──────────────────────────────────────────────────────────┘
```

**Walkthrough pattern (all sources).** A **WalkthroughStepper**: one short sentence per step, a large
illustrative screenshot, a prominent **"Step X of N"**, and **"I've done this →"** / **"Show me
again"** controls. Each walkthrough ends with the same reassurance — **"You're just making a copy —
nothing will be deleted from [source]"** — then advances to **Journey C**'s file/folder step.
Screenshots are **updateable components** (not hardcoded), because source apps change their UI
frequently; an "Open [source]'s official help page" link is offered as a fallback *(note: opening an
external help page is the user leaving Kawsay via their own browser — the app itself still makes no
network requests, preserving AC-4)*. (`ux.md` §4.2 Step 3, Gap §5.)

**B1 — WhatsApp** *(text + photos + voice notes + video; AC-1, AC-12).* Steps (`ux.md` §4.2):
1. *"On your phone, open WhatsApp and tap the chat with [Name]."*
2. *"Tap the ⋮ menu (top right) → **More** → **Export chat**."*
3. *"Choose **Attach media** so the photos and voice notes come too."*
4. *"Send it to yourself (email or save to Files), then bring that file to this computer."*
Then → file picker for the WhatsApp `.zip`.

**B2 — A folder of photos** *(generic / cloud-download; AC-2).* No multi-step export; a one-screen
primer:
- *"Already downloaded photos from iCloud, OneDrive, Dropbox, or Google Drive? Or have them on a
  phone or memory stick? Point Kawsay at the folder — we'll look inside every folder it contains."*
- *"Kawsay reads these photos where they are and never changes or moves them."* (AC-14.)
Then → **folder** picker (recursive).

**B3 — Google Takeout** *(Gmail `.mbox` + Google Photos; AC-11).* Steps:
1. *"On a computer, go to Google Takeout (takeout.google.com) and sign in as [Name]."*
2. *"Choose **Mail** and **Google Photos** (you can leave the rest unticked)."*
3. *"Ask Google to make the download — they'll email a link when it's ready (this can take a while —
   that part is up to Google)."*
4. *"Download the file they send, then bring it to this computer."*
Then → file picker for the Takeout `.zip`.

**B4 — Facebook ("Download Your Information")** *(AC-16).* Steps:
1. *"In Facebook, open **Settings & privacy → Settings**."*
2. *"Find **Your information** → **Download your information**."*
3. *"Pick **JSON** format, then request the download."*
4. *"When Facebook says it's ready, download it and bring it here."*
Then → file picker for the Facebook `.zip`.

**B5 — LinkedIn ("Get a copy of your data")** *(AC-16).* Steps:
1. *"In LinkedIn, open **Settings → Data privacy**."*
2. *"Choose **Get a copy of your data**."*
3. *"Select everything, then request the archive."*
4. *"When LinkedIn emails the file, download it and bring it here."*
Then → file picker for the LinkedIn `.zip`.

| State | Behavior |
|---|---|
| **Happy** | Pick source → read the short walkthrough → "I've done this" → file/folder picker → **Journey C**. |
| **Empty** | If the user has no export yet, **"I don't have this file yet"** keeps the walkthrough open and offers the official-help link — never a dead end. |
| **Loading** | Walkthrough is static; advancing is instant. The file/folder picker is the OS-native dialog (no in-app spinner). |
| **Error** | *Wrong file type* → **"This doesn't look like a WhatsApp export. Want to try a different file?"** with a one-line note + thumbnail of what the right file looks like; never an error code. *Picker cancelled* → return calmly to the walkthrough, no scolding. |

---

### Journey C — Import (progress, partial-failure recovery, "what we found")

**Goal:** turn a long, opaque technical operation into a calm, watchable, trustworthy moment — and
end on emotional payoff. Heavy work runs **off the UI thread** so the screen stays responsive
(AC-9); progress is announced to assistive tech via a polite **live region** (§6). Imports are
**undoable** (AC-14) and **never silently drop items** (AC-15). (`ux.md` §4.2 Steps 5–6, §4.3.)

```
┌──────────────────────────────────────────────────────────┐
│            Reading through [Name]'s WhatsApp…            │  ← plain language, not "Parsing archive"
│                                                          │
│              ◍  (gentle breathing icon)                  │  ← pulses only if motion allowed
│                                                          │
│   ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░   62%                      │  ← ImportProgress, percent-done
│                                                          │
│        84 messages · 37 photos · 12 voice notes          │  ← running tally, builds anticipation
│                                                          │
│   This can take as long as it needs. You can keep this   │
│   open, or come back later — nothing will be lost.       │
│                                              [ Pause ]   │  ← cancel/pause without losing imported items
│  🔒 Your memories never leave this computer.             │
└──────────────────────────────────────────────────────────┘
```

**C1 — Progress (the most critical moment).** A **percent-done** bar (never a bare spinner) with a
**running tally** of what's been found, and a plain-text explanation of the current activity
("Reading through [Name]'s messages…"). A gentle **breathing** icon — only when `prefers-reduced-
motion` is off; otherwise static. Reassurance that there's no rush and they can leave. A **Pause /
Cancel** that never discards already-imported items. (`ux.md` §4.2 Step 5; AC-9, AC-13.)

**C2 — "What we found" summary (emotional payoff).** On completion, show the **first memory
immediately** — the earliest-dated photo or a voice-note waveform — with a warm, concrete count:
**"We found 347 of [Name]'s photos and 89 voice notes."** A single primary action: **"See everything
→"**. No upsell, no settings, no "share" prompt at this moment. An optional, quiet one-liner
(*"What a gift to have all of this"*) is feature-flagged for testing — it may feel presumptuous and
must be easy to disable. (`ux.md` §4.2 Step 6.)

```
┌──────────────────────────────────────────────────────────┐
│   ┌───────────────┐                                       │
│   │  [first photo │   We found 347 of [Name]'s photos     │
│   │   of [Name]]  │   and 89 voice notes.                 │
│   └───────────────┘                                       │
│                       ┌───────────────────────────────┐   │
│                       │      See everything  →        │   │  ← single primary action
│                       └───────────────────────────────┘   │
│   We couldn't read 14 files.  [ See which ones ]         │  ← SkippedItemsPanel entry (only if >0)
└──────────────────────────────────────────────────────────┘
```

| State | Behavior |
|---|---|
| **Happy** | Progress with tally → completion → first memory + count → "See everything." |
| **Empty** | *Export had nothing we could read* → **"We looked through this file but couldn't find any messages or photos. This sometimes happens if the export didn't finish. Here's how to try again."** + link back to the relevant walkthrough. Never a blank success. |
| **Loading** | The import **is** the loading state — but it is *informative* loading (percent + tally + plain text), never a stuck spinner. If no progress for >3s, the explanatory line updates so it never feels frozen. Long imports show an approximate time-to-go and stay cancellable. |
| **Partial failure (AC-15)** | Valid items are kept; the import **does not abort**. The summary shows **"We brought in 312 of [Name]'s photos. 14 files couldn't be read — would you like to see which ones?"** opening the **SkippedItemsPanel** (filename + plain reason). Items are **never silently dropped**. |
| **Hard error** | *Unsafe archive (zip-slip / bomb — AC-3, AC-10)* → a calm refusal: **"This file looks damaged or unsafe, so we stopped to keep your computer safe. Try downloading it again."** No `ERR_ARCHIVE_UNSAFE_PATH`/`ERR_ARCHIVE_BOMB` codes shown (the stable codes exist for tests, not users). *Disk full* → **"There isn't enough room to save these. Free up some space and we'll pick up where we left off."** |
| **Undo (AC-14)** | A persistent **UndoBanner** ("[Name]'s WhatsApp memories were added · **Undo**") and an always-available undo in source detail; undo removes catalog entries + Kawsay-made copies/thumbnails, **never** an original source file. |

---

### Journey D — Browse / timeline

**Goal:** the moment after import and the app's true home — a calm, reverse-chronological **timeline**
of everything gathered, grouped by month, that stays fast at **10,000+ items** via virtualization
(AC-6, AC-8). Thumbnails lazy-load over a local protocol; nothing reaches the network. (`catalog-
pkg.md` §4.1; PRD §5.3.)

```
┌─────────────┬────────────────────────────────────────────┐
│  [Name]     │  Search [Name]'s memories…            🔎    │  ← SearchBar (persistent)
│             │  [ All ] [ Photos ] [ Videos ] [ Voice ] …  │  ← FilterChips
│ ▸ Timeline  │ ───────────────────────────────────────────│
│ ▸ Search    │  June 2019                                  │  ← MonthHeader (sticky)
│ ▸ Add       │  ┌────┐┌────┐┌────┐┌────┐┌────┐┌────┐        │
│   memories  │  │▥ ▥ ││▥ ▥ ││ ▶  ││▥ ▥ ││ 🔊 ││▥ ▥ │        │  ← TimelineGrid of MemoryCards
│             │  └────┘└────┘└────┘└────┘└────┘└────┘        │
│ ─────────── │  May 2019                                   │
│ Sources     │  ┌────┐┌────┐┌────┐ …                        │
│  WhatsApp   │                                              │
│  Photos     │                                              │
│             │  🖥 Private & on this computer               │  ← persistent PrivacyBadge
└─────────────┴────────────────────────────────────────────┘
```

**Happy path.** Open to the most recent month; scroll smoothly through months. Each **MemoryCard**
shows a thumbnail with a small type affordance (▶ video, 🔊 voice note, ✉ message) and never
auto-plays. A sticky **MonthHeader** keeps the user oriented (cognitive-load aid for the audience).
Clicking a card opens **Journey F** (single memory).

| State | Behavior |
|---|---|
| **Happy** | Virtualized month-grouped grid; bounded mounted-node window (AC-8); lazy thumbnails. |
| **Empty (first run, no imports yet)** | A warm **EmptyState**, not a void: **"[Name]'s library is ready. Let's bring in the first memories."** + a single **"Add memories"** button → Journey B. (Never blame the user for emptiness.) |
| **Empty (a source had 0 items)** | Inline note in that source's view: *"We didn't find anything in this one yet."* + how to try again. |
| **Loading** | Thumbnails show a soft blur/skeleton placeholder while decoding; the grid frame and month headers render immediately so the screen is never blank. No full-screen spinner. |
| **Error** | A thumbnail that fails to render shows a gentle placeholder with the item's type icon and date — the memory is still openable; the timeline never breaks because one file is unreadable. |

---

### Journey E — Search & filter

**Goal:** find a specific memory by words (message text, captions, filenames) and/or narrow by type,
source, and date — fast and forgiving (AC-6, AC-7). Full-text via SQLite FTS5; filters compose with
search. (`catalog-pkg.md` §4.2.)

**Happy path.** The persistent **SearchBar** accepts plain words; results appear as the same
**TimelineGrid** of **MemoryCard**s, ranked, with matched text snippets shown on message results.
**FilterChips** (All · Photos · Videos · Voice notes · Messages · by Source · by Date range) narrow
results; active filters are visible and individually removable. Search and filters are debounced;
work happens off the UI thread so typing stays responsive.

| State | Behavior |
|---|---|
| **Happy** | Type → ranked results update calmly; chips narrow further; clearing returns to full timeline. |
| **Empty (no matches)** | **"We couldn't find anything for "[term]". Try fewer words, or a different name."** + a one-tap **"Clear search"** — never a cold "0 results." Suggest removing an active filter if one is narrowing things. |
| **Empty (nothing imported yet)** | Search is **not** offered as a dead end on an empty library; it routes to the same "Add memories" EmptyState as Journey D. |
| **Loading** | A subtle inline progress affordance in the SearchBar (not a blocking overlay); previous results stay visible until new ones arrive (no flash from blank). |
| **Error** | If a query can't be parsed, fall back to a literal whole-string search rather than erroring; never show FTS syntax errors to the user. |

---

### Journey F — View a single memory (incl. playing a voice note / video)

**Goal:** open one memory in a focused, reverent view and — only on explicit intent — play a voice
note or video. **No media ever auto-plays** (AC-13; `ux.md` §1.5, §3.1). A loved one's voice must
never start unexpectedly.

```
┌──────────────────────────────────────────────────────────┐
│  ✕ Close                                   ‹ Prev   Next › │  ← MediaViewer / Lightbox, keyboard ← →
│                                                          │
│            ┌──────────────────────────────┐               │
│            │                              │               │
│            │     [ photo / video frame ]  │               │
│            │            ▶ Play            │  ← explicit play only; never autoplay
│            │                              │               │
│            └──────────────────────────────┘               │
│                                                          │
│   [Name] · 14 June 2019 · from WhatsApp                  │  ← provenance: who/when/which source
│   "Happy birthday, mijo — call me when you wake up."     │  ← caption / message text if present
│                                                          │
│   🔊 Voice note · 0:42      [ ▶ Play ]  ──────●────       │  ← VoiceNotePlayer, user-initiated
└──────────────────────────────────────────────────────────┘
```

**Happy path.** A calm, low-chrome viewer (**MediaViewer** / **Lightbox**). Photos show full; videos
show a **poster frame with an explicit ▶ Play**; voice notes show a **waveform + duration + Play**
(**VoiceNotePlayer**). Provenance is always shown — **who, when, and which source** — honoring
Mateo's need for a *faithful, attributed* archive (AC-1/AC-16; PRD §2.2). Keyboard: `←/→` previous/
next, `Esc` closes, `Space` toggles play **only after** the player has focus (so Space never
surprise-plays from the grid). Pressing **Play** on one media item **pauses any other** — never two
voices at once.

| State | Behavior |
|---|---|
| **Happy** | Open → view → optionally Play (user-initiated) → navigate prev/next or close back to the grid. |
| **Empty** | N/A for a single item, but a deleted/undone item routes back to the timeline with a quiet *"That memory was removed."* |
| **Loading** | Full-resolution media loads behind the thumbnail/poster (progressive); a soft inline indicator on the player while audio/video buffers from disk — never a blocking modal. |
| **Error** | *Unplayable/corrupt media* → **"We're having trouble opening this one. The original is still safe on your computer."** + a **"Show where this is saved"** action (reveals the original file in the OS file manager). The original is never altered (AC-14). |

---

## 3. Information architecture & navigation

**Mental model:** *one library for one person, made of memories that arrive from sources and are
viewed on a timeline.* The library is the home; sources feed it; timeline and search are the two ways
to look through it. (MISSION §2, §4; PRD §3.)

```
Kawsay
└── [Name]'s Library  ........................ the single top-level home (one library per person in v1)
    ├── Timeline  (home view) ................ reverse-chronological, month-grouped — Journey D
    ├── Search ............................... full-text + filters over the same items — Journey E
    ├── Add memories ......................... source picker → guided walkthrough → import — Journeys B, C
    │   └── Sources (provenance list) ........ WhatsApp · Photos · Takeout · Facebook · LinkedIn
    │       └── per-source detail ............ what came from here · re-import more · Undo (AC-14)
    ├── Memory view (overlay) ................ single item + play media — Journey F
    └── Settings (minimal) ................... library location · text size · reduced motion · about/privacy
```

**Primary navigation — a calm left sidebar** with at most a handful of always-visible destinations,
ordered by how often they're used: **Timeline**, **Search**, **Add memories**, then a quiet
**Sources** list (provenance). Large hit targets (≥48px rows), the current section clearly marked,
plain labels. The sidebar is **hidden during onboarding** (one-thing-at-a-time) and **revealed only
after the first successful import** (progressive disclosure, Hick's Law; `ux.md` §1.4.5, §4.1).

**How sources / timeline / search relate.**
- **Sources are the inputs**, never the primary way to browse — they exist so the user (and later
  Mateo) can see *where each memory came from* and add more from the same place. Provenance is
  preserved even when the same photo arrived from two sources (dedup keeps one copy, records both
  origins — PRD §5.6).
- **Timeline is the default lens** — everything, newest first, regardless of source.
- **Search is the other lens** — the same items, filtered by words/type/source/date.
- The three share one underlying catalog; switching lenses never re-imports or moves anything.

**Persistent chrome.** A slim **status bar** carries the **"Private & on this computer"** PrivacyBadge
at all times (P4). A persistent, reachable **"Add memories"** entry means new sources can be added
anytime, with **no pressure to import everything at once** (`ux.md` §4.4). There are no tabs in the
window title, no notification badges, no urgency cues anywhere.

---

## 4. UI component list

The reusable components Engineering will build, each with a one-line purpose and **key states**.
Components consume **only design tokens** (§5) — no ad-hoc colors, sizes, or durations. All
interactive components have a visible **focus** state and meet hit-target minimums (§6).

### Shell & cross-cutting
| Component | Purpose | Key states |
|---|---|---|
| **AppShell** | Top-level layout: sidebar + content + status bar; owns reduced-motion/theme context. | onboarding (no sidebar) · main (sidebar shown) |
| **Sidebar / NavRail** | Primary navigation to Timeline · Search · Add memories · Sources. | default · active item · hover · focus · hidden (onboarding) |
| **PrivacyBadge** | The always-visible "Private & on this computer / never leaves this computer" reassurance. | status-bar (compact) · step-footer (full sentence) |
| **StatusBar** | Slim persistent bar hosting PrivacyBadge + library name. | default |
| **ReassuranceNote** | Inline gentle micro-copy ("You can come back anytime — nothing will be lost"). | info · privacy · pacing |
| **Toast / QuietToast** | Non-blocking, auto-dismiss confirmation (no urgency, no error use). | success · info (never auto-plays sound) |

### Onboarding & import
| Component | Purpose | Key states |
|---|---|---|
| **WelcomeHero** | Step-0 full-screen warm welcome + grief acknowledgment + two choices. | default |
| **WalkthroughStepper** | The wizard frame for onboarding **and** per-source export walkthroughs; "Step X of N", Back/Next, focus-moves-to-h1. | first · middle · last · per-step |
| **NameInput** | Large single field capturing the loved one's name. | empty · filled · invalid (blank) · focus |
| **LibraryLocationPicker** | Plain-language chooser for where the library lives, with recommended default + native picker. | default (recommended) · changed · error (not writable / no space) · existing-library-found |
| **SourceCard** | Large, tappable card for one source (icon + plain one-liner). | default · hover · focus · pressed · disabled |
| **WalkthroughStep** | One illustrated export step: screenshot + one sentence + "I've done this / Show me again". | default · screenshot-loading · help-link-fallback |
| **BrowseButton** | The **primary** file/folder picker action (never drag-only). | default · hover · focus · pressed |
| **Dropzone** | Optional drag-and-drop **enhancement** wrapping BrowseButton. | idle · drag-over (ghost/magnet) · invalid-type · disabled |
| **ImportProgress** | Percent-done bar + running tally + plain activity text + breathing icon (motion-gated). | indeterminate(<brief) · running · paused · complete · error; live-region announces |
| **WhatWeFoundSummary** | Completion payoff: first memory + warm count + single "See everything". | with-skips · without-skips |
| **SkippedItemsPanel** | Lists items that couldn't be read (filename + plain reason) — never silent drops (AC-15). | hidden(0 skipped) · shown · expanded |
| **UndoBanner** | Persistent "added · Undo" affordance for the last import (AC-14). | visible · undoing · dismissed |

### Browse, search & memory
| Component | Purpose | Key states |
|---|---|---|
| **TimelineGrid** | Virtualized, month-grouped grid of memories at 10k+ items (AC-8). | loading · populated · scrolling · empty |
| **MonthHeader** | Sticky month/year divider for orientation. | default · sticky/pinned |
| **MemoryCard** | One memory's thumbnail + type affordance (▶/🔊/✉); never auto-plays. | default · hover · focus · loading(skeleton) · thumb-error |
| **LazyThumbnail** | Loads a thumbnail from the local protocol only when visible. | placeholder/blur · loaded · error |
| **SearchBar** | Persistent plain-words search input. | empty · typing · searching · has-results · no-results |
| **FilterChips** | Toggleable filters (type · source · date range); composable with search. | inactive · active · removable · group |
| **DateRangePicker** | Plain calendar range filter. | default · range-selected · cleared |
| **MediaViewer / Lightbox** | Focused single-memory overlay with prev/next + keyboard nav. | photo · video(poster) · audio · message · loading · error |
| **VoiceNotePlayer** | Waveform + duration + **explicit** Play for voice notes (no auto-play). | idle · playing · paused · buffering · error |
| **VideoPlayer** | Poster + **explicit** Play; pauses any other playing media. | idle(poster) · playing · paused · buffering · error |
| **ProvenanceMeta** | Shows who/when/which-source for a memory (faithful attribution). | default |

### Feedback, empty & error primitives
| Component | Purpose | Key states |
|---|---|---|
| **EmptyState** | Warm, non-blaming "nothing here yet" + the one helpful next action. | library-empty · source-empty · no-search-matches |
| **ErrorBanner** | Plain-language, non-technical error surface (no codes). | inline · dismissible · with-retry · with-reveal-original |
| **ConfirmDialog** | Confirmation only for genuinely consequential actions (e.g., Undo an import); destructive action visually separated. | default · destructive · loading |
| **PlayButton** | Shared explicit-intent media trigger used by voice/video. | idle · active · focus · disabled |
| **IconButton / Button** | Token-driven buttons honoring hit-target minimums. | primary · secondary · ghost · hover · focus · pressed · disabled |
| **SoftLockGlyph** | Friendly rounded lock used in privacy moments (not a vault padlock). | default |

---

## 5. Design tokens

A concrete, named token set grounded in `ux.md` §2.4. These are authored as CSS variables and become
**Tailwind theme tokens** (Tailwind v4 `@theme`) that Engineering reuses everywhere — components must
not hardcode values. The palette's grounding image (MISSION §2): *a warm room on an autumn evening —
candlelit parchment, aged wood, dried botanicals; nothing harsh, nothing cold.*

> **AC-4 — fonts & assets are BUNDLED, never remote.** The font *family names* below were selected
> with reference to Google Fonts, **but Kawsay must NOT load them (or anything) from Google Fonts, a
> CDN, or any URL at runtime or in the renderer.** Ship the chosen OFL/SIL-licensed faces as **local
> `.woff2` files bundled in the app** (e.g. self-hosted via an `@fontsource/*` package or vendored
> `assets/fonts/`), served under `font-src 'self'` with the strict CSP from PRD §5.1. Likewise all
> icons/illustrations are bundled SVGs — no remote images. This is a hard gate (MISSION §5, NEVER
> list; PRD §5.1). *(Adding the font dependency itself is an Engineering step under the normal
> ASK-FIRST/dependency process — this doc specifies intent, not a dependency change.)*

> **Light-first; dark-mode intent.** v1 ships **light only** — a warm off-white canvas is core to the
> calm, non-clinical feel, and *"techy dark mode as default"* is explicitly rejected (`ux.md` §2.1).
> Tokens are **semantically named** (`--color-canvas`, `--color-text-primary`, …) precisely so a
> future **opt-in "warm dusk"** dark theme (deep warm browns/charcoals — never cool slate) can remap
> the same names without touching components. Dark mode is **not** in M1 scope.

### 5.1 Color — canvas, surface & text (light)

```css
/* CANVAS & SURFACE — 60% dominant warm off-white (never clinical pure white) */
--color-canvas:          #F6F2EE;  /* warm off-white base */
--color-surface-raised:  #FFFFFF;  /* cards, modals */
--color-surface-tinted:  #F0EBE4;  /* subtle tinted areas */
--color-surface-sunken:  #EDE6DD;  /* sidebar, inactive panes */

/* TEXT — warm near-black, never harsh #000 */
--color-text-primary:    #2A1F1A;  /* body — ~12:1 on canvas */
--color-text-secondary:  #5C504A;  /* captions, labels */
--color-text-tertiary:   #8A7D76;  /* timestamps, hints */
--color-text-disabled:   #C0B4AC;  /* disabled, placeholder */
--color-text-inverse:    #FAF7F4;  /* text on dark surfaces */
```

### 5.2 Color — sage (primary interactive) & clay (warm accent)

```css
/* SAGE — primary interactive (renewal, calm, hospice/wellness lineage) */
--color-sage-50:  #F0F5F2;  --color-sage-100: #DCE9E2;  --color-sage-200: #B8D2C5;
--color-sage-300: #8DB8A4;  --color-sage-400: #619B84;  --color-sage-500: #3F7D64; /* primary CTA */
--color-sage-600: #2E5E4A;  --color-sage-700: #1F4234;  --color-sage-800: #132B22;
--color-sage-900: #0A1811;

/* CLAY — warm secondary accent (humanity without aggression) */
--color-clay-50:  #FAF3EE;  --color-clay-100: #F2E3D6;  --color-clay-200: #E4C6AC;
--color-clay-300: #CFA47E;  --color-clay-400: #B78153;  --color-clay-500: #9E6235; /* warm hover/active */
--color-clay-600: #7C4B27;  --color-clay-700: #58341B;  --color-clay-800: #371F0F;
--color-clay-900: #1C0F05;

/* PARCHMENT — gentle amber warmth (permanence/legacy, used sparingly) */
--color-parchment-100: #FDF8F0;  --color-parchment-200: #FAF0DE;  --color-parchment-300: #F5E2B8;
```

> **Usage (60-30-10):** **60%** warm canvas, **30%** sage surfaces/borders, **10%** sage/clay accents
> for primary actions and active states. Clay is for warm hover/active and gentle highlights — not for
> errors. (`ux.md` §2.3.)

### 5.3 Color — borders, semantic status & focus

```css
/* BORDERS & DIVIDERS */
--color-border-subtle:  #E6DDD5;  --color-border-default: #D1C5BB;  --color-border-strong: #B5A89D;

/* SEMANTIC STATUS — muted, warm, never alarming-bright */
--color-success-bg: #EEF5F0;  --color-success-text: #215C38;  --color-success-border: #B2D6BD;
--color-error-bg:   #FDF0EC;  --color-error-text:   #8C2E1A;  --color-error-border:   #F0B9A8;
--color-warning-bg: #FDF6E6;  --color-warning-text: #6B4500;  --color-warning-border: #EDD898;
--color-info-bg:    #EEF3F7;  --color-info-text:    #1C4565;  --color-info-border:    #B0CEE4;

/* FOCUS RING — sage, 3px solid, 3px offset (see §6) */
--color-focus-ring: #3F7D64;
```

> **Contrast note (verify in build):** `--color-text-primary` on `--color-canvas` ≈ **12:1** (passes
> the ≥7:1 body target). `--color-sage-500` on `--color-canvas` ≈ **5.2:1** — acceptable for large
> text / non-text UI, **but small body text must use `--color-text-primary`, not sage**. Re-validate
> every text/background pair before merge (rubric R3; `ux.md` §2.4 note, §3.2).

### 5.4 Typography

```css
/* FAMILIES — all BUNDLED locally as .woff2 (NOT fetched from Google Fonts/CDN — AC-4) */
--font-display: 'Lora', 'Source Serif 4', Georgia, serif;   /* warmth, gravitas, memorial-publishing feel */
--font-body:    'Inter', system-ui, sans-serif;              /* screen-legible UI/body */

/* SIZE SCALE — 18px preferred body default for 60+ readers (86% of 40+ need reading glasses) */
--text-xs: 12px;  --text-sm: 14px;  --text-base: 16px; /* min body */  --text-md: 18px; /* preferred body */
--text-lg: 20px;  --text-xl: 24px;  --text-2xl: 30px;  --text-3xl: 36px;  --text-4xl: 48px;

/* LINE HEIGHTS — generous for readability */
--leading-tight: 1.25;  --leading-snug: 1.4;  --leading-base: 1.6;  --leading-relaxed: 1.75;  --leading-loose: 2.0;

/* WEIGHTS */
--font-normal: 400;  --font-medium: 500;  --font-semibold: 600;  --font-bold: 700;

/* LETTER SPACING */
--tracking-tight: -0.01em;  --tracking-normal: 0;  --tracking-wide: 0.02em;  --tracking-wider: 0.04em;
```

- **Display/headings:** `--font-display` (Lora) — imports warmth and timelessness for the loved one's
  name, page titles, and the emotional payoff line.
- **Body/UI:** `--font-body` (Inter) at **`--text-md` (18px)** by default; never below `--text-base`
  (16px) for body. Text must remain legible when the OS scales fonts to **200%** (§6).
- Respect the user's **system font-size** preference; do not lock a px size that can't scale.

### 5.5 Spacing, radii, elevation

```css
/* SPACING (4px base) — err heavily toward MORE space; min card padding = --space-6 (24px) */
--space-1: 4px;  --space-2: 8px;  --space-3: 12px;  --space-4: 16px;  --space-5: 20px;  --space-6: 24px;
--space-8: 32px; --space-10: 40px; --space-12: 48px; --space-16: 64px; --space-20: 80px; --space-24: 96px;

/* BORDER RADIUS — rounded = warm/approachable; avoid sharp rectangles */
--radius-sm: 4px;  --radius-base: 8px;  --radius-md: 12px;  --radius-lg: 16px;  --radius-xl: 24px;  --radius-full: 9999px;

/* ELEVATION — warm-tinted shadows (brown #2A1F1A base, never cool/gray-black) */
--shadow-sm:   0 1px 3px rgba(42,31,26,0.06), 0 1px 2px rgba(42,31,26,0.04);
--shadow-base: 0 4px 6px -1px rgba(42,31,26,0.07), 0 2px 4px -2px rgba(42,31,26,0.04);
--shadow-md:   0 10px 15px -3px rgba(42,31,26,0.08), 0 4px 6px -4px rgba(42,31,26,0.04);
--shadow-lg:   0 20px 25px -5px rgba(42,31,26,0.09), 0 8px 10px -6px rgba(42,31,26,0.04);
```

- **Whitespace is a feature.** Memorial apps must never feel crowded; prefer the larger spacing step
  when unsure. Minimum **`--space-6` (24px)** padding on any card. (`ux.md` §2.4.)
- **Elevation is gentle** — raise cards/modals just enough to read as layered; warm shadow color keeps
  it soft, not stark.

### 5.6 Motion

```css
/* DURATIONS */
--duration-instant: 80ms;  --duration-fast: 150ms;  --duration-normal: 250ms;
--duration-slow:    400ms; --duration-calm: 600ms;  /* import-completion reveal */

/* EASINGS */
--easing-default: ease-out;
--easing-gentle:  cubic-bezier(0.25, 0.46, 0.45, 0.94);
--easing-spring:  cubic-bezier(0.34, 1.56, 0.64, 1);  /* sparing; NOT on primary grief flows */
```

- Motion is **subtle and unobtrusive** — slow dissolves and fades-from-slightly-below, never snapping
  or bouncing on primary flows. The only "alive" motion is the import **breathing** icon.
- **Reduced motion is the default posture and is honored globally** — under `prefers-reduced-motion:
  reduce`, all animation/transition collapses to opacity-only at `--duration-instant`, and the
  breathing icon goes static. In Electron, also respect `nativeTheme.prefersReducedMotion`. (`ux.md`
  §3.6; AC-13.)

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important; animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important; scroll-behavior: auto !important;
  }
}
```

---

## 6. Accessibility approach (AC-13)

WCAG 2.1 AA is the **floor**, deliberately exceeded for an audience that skews 60+, may be
emotionally distressed, and is non-technical (`ux.md` §3; PRD §5.2). Verified by **axe-core** + **keyboard-
only** runs under `prefers-reduced-motion` on every primary screen (welcome, source picker,
walkthrough, import progress, timeline, item view, search) — **no serious/critical violations** is the
bar (AC-13).

| Area | Commitment |
|---|---|
| **Text contrast** | Target **≥7:1** for normal body text (AA min 4.5:1); **≥4.5:1** for large text (≥18px / 14px bold). Small body text always uses `--color-text-primary`; never small sage-on-canvas. (R3.) |
| **Non-text contrast** | Buttons, icons, input borders, focus ring **≥4.5:1** (AA min 3:1) against adjacent colors. |
| **Visible focus** | A **3px solid sage focus ring at 3px offset** (`--color-focus-ring`) on **every** interactive element; focus is **never** removed, only restyled. Visible for mouse and keyboard. |
| **Hit targets** | **≥44×44px** minimum, **prefer 48px**, **56px** for primary actions; **≥8px** between adjacent targets (tremor tolerance). |
| **Keyboard** | Everything operable without a mouse: logical tab order, Enter/Space activation, `Esc` closes overlays, `←/→` prev/next in MediaViewer. **No keyboard traps.** Drag-and-drop is never the only path — a **BrowseButton** primary always exists (AC-12). |
| **Focus management (wizard)** | On each onboarding/walkthrough step change, **move focus to the step's `<h1>`** so screen-reader users are re-oriented and short-term-memory load is reduced. |
| **Screen readers** | Correct ARIA roles/labels on all controls. **Import progress is an `aria-live="polite"` region** announcing milestones ("84 messages found", "Import complete — 347 photos"). Decorative illustrations are `aria-hidden`; meaningful images have alt text (e.g. a photo's date/source). Electron auto-enables a11y when VoiceOver/JAWS is detected; expose an explicit toggle in Settings. |
| **No auto-play** | **No audio or video ever auto-plays** — voice notes and videos require an explicit Play; `Space` only toggles play **after** the player has focus. (Protects against a loved one's voice starting unexpectedly.) |
| **Reduced motion** | Honored by **default** (§5.6); no animation exceeds 3 Hz; **zero flashing** anywhere. |
| **Resize / zoom** | Layout remains usable and lossless at **200%** OS font scaling; respects system font-size; no fixed-height text clipping. |
| **Plain language** | All copy at a **6th–8th-grade** reading level, sentences **≤15–20 words**, one idea per paragraph, **no jargon** and **no error codes** surfaced to users (stable codes like `ERR_ARCHIVE_UNSAFE_PATH` are for tests only). Spell actions out step-by-step. (`ux.md` §3.4.) |
| **No time pressure** | No session timeouts, no countdowns, no auto-advancing steps; the user sets the pace (P3). |
| **Forgiving by design** | Error *prevention* first (separated destructive actions, confirmation for Undo); originals never deleted (AC-14); every import undoable; partial failures surfaced, never silent (AC-15). |

---

## 7. Design rubric

The explicit checklist the build's **visual self-check loop** runs against (Playwright renders +
screenshots, `ux.md`/this doc as ground truth). Every item must pass before a UI PR is considered
done; a failure is a blocker, not a nit.

| # | Rubric item | Pass criteria |
|---|---|---|
| **R1** | **Visual hierarchy** | The single most important thing on each screen is unmistakably dominant (size/weight/space); one primary action per screen; no competing CTAs. |
| **R2** | **Spacing & rhythm** | Spacing uses only `--space-*`; cards have ≥`--space-6` padding; layout "breathes" — never crowded; consistent vertical rhythm. |
| **R3** | **Contrast & legibility** | Body text ≥7:1 (large ≥4.5:1), non-text ≥4.5:1, **verified** against tokens; body ≥`--text-base`, default `--text-md`; no small sage-on-canvas. |
| **R4** | **Alignment & grid** | Elements align to a consistent grid; optical alignment honored; no off-grid one-offs; timeline columns even. |
| **R5** | **Typographic scale** | Only `--text-*`/`--leading-*`/weight tokens; display = Lora, body = Inter; no arbitrary font sizes; heading levels nest correctly. |
| **R6** | **Color-token usage** | Only palette tokens — **zero hardcoded hex** in components; 60-30-10 respected; clay not used for errors; semantic colors only for status. |
| **R7** | **Component consistency** | Shared components (Button, SourceCard, MemoryCard, EmptyState…) look/behave identically everywhere; states (hover/focus/pressed/disabled) are uniform. |
| **R8** | **Empty / loading / error states** | Every view ships all three: warm non-blaming EmptyState, informative (non-spinner) loading, plain-language ErrorBanner with no codes. |
| **R9** | **Responsive behavior** | Usable from a small window up; sidebar/grid reflow gracefully; legible at **200%** font scaling with no clipping or overlap. |
| **R10** | **Accessibility — focus / contrast / targets** | Visible 3px focus ring on all controls; hit targets ≥44px (48–56 primary), ≥8px apart; full keyboard operation; axe-core: no serious/critical (AC-13). |
| **R11** | **Motion & reduced-motion** | Motion subtle/unobtrusive; no bounce on primary flows; under `prefers-reduced-motion` everything is opacity-only/instant; no flashing; **no media auto-play**. |
| **R12** | **Tone & reverence** | Copy is reverent, plain, jargon-free; uses [Name]; grief acknowledged once; privacy reassurance present; no urgency cues; **no cloud/upload imagery** (P1, P2, P4). |
| **R13** | **Privacy & safety cues** | "Never leaves this computer" reassurance on import steps; persistent Private badge; soft rounded lock; "you're only making a copy / nothing is deleted" surfaced (P4, P4b; AC-4, AC-14). |

---

> **Provenance.** Grounded in **MISSION §2** (warm, calm, reverent; soft palette, generous
> whitespace, legible type, plain language, gentle pacing) and **`research/ux.md`** (tone §1, visual
> direction & tokens §2, accessibility §3, onboarding/import patterns §4), with browse/timeline/search
> patterns from **`research/catalog-pkg.md` §4**, and tied to **PRD** acceptance **AC-4, AC-6, AC-7,
> AC-8, AC-12, AC-13, AC-14, AC-15**. **Status: proposed — awaiting independent red-team.**
