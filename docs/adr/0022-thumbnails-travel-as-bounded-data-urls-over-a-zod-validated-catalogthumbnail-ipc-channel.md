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
