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
